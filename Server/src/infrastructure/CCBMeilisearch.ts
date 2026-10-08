import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Meilisearch, type EnqueuedTaskPromise, type Index, type SearchResponse } from "meilisearch";
import { isMeiliApiError, meiliHttpClient } from "./MeiliHttpClient";

export interface CCBCharacterSearchDocument {
  [key: string]: unknown;
  id: number;
  name: string;
  aliases: string[];
  comment: number;
  collect: number;
  nsfw: boolean;
}

export interface CCBSubjectSearchDocument {
  [key: string]: unknown;
  id: number;
  name: string;
  aliases: string[];
  tag: string[];
  meta_tag: string[];
  date: number;
  score: number;
  rating_count: number;
  heat: number;
  rank: number;
  type: number;
  nsfw: boolean;
}

export interface CCBMeilisearchOptions {
  apiKey?: string;
  client?: Meilisearch;
}

export interface CCBSearchResult {
  ids: number[];
  estimatedTotalHits: number;
}

const CHARACTER_INDEX = "ccb_characters";
const SUBJECT_INDEX = "ccb_subjects";
const METADATA_INDEX = "ccb_search_metadata";
// v2：移除 page_rank（自接入起就是 rating_count 的副本、全仓零读取），并据此强制重建存量索引。
const INDEX_SCHEMA_VERSION = 2;
const BATCH_SIZE = 1_000;
// 容器部署时 Meilisearch 可能与 app 不在同一网络命名空间（回环地址不通）：用 MEILISEARCH_URL 覆盖为容器可达地址。
const INTERNAL_SEARCH_URL = (Bun.env.MEILISEARCH_URL?.trim() || "http://127.0.0.1:7700").replace(/\/+$/, "");
const SEARCH_TIMEOUT_MS = 5_000;
const INDEX_TASK_TIMEOUT_MS = 600_000;

export const CCB_CHARACTER_RANKING_RULES = [
  "exactness", "words", "typo", "proximity", "attribute", "sort",
  "id:asc", "comment:desc", "collect:desc", "nsfw:asc",
];
export const CCB_SUBJECT_RANKING_RULES = [
  "exactness", "words", "typo", "proximity", "attribute", "sort",
  "id:asc", "rank:asc", "score:desc", "nsfw:asc",
];

type IndexWithDocuments<T extends Record<string, unknown>> = Index<T> & { getStats(): Promise<{ numberOfDocuments: number }> };

/**
 * CCB 搜索的唯一索引适配器。
 *
 * 索引字段、过滤器和排序规则与 Bangumi server 的 search 包保持一致。
 * SQLite 只负责存放详情，搜索命中顺序完全由 Meilisearch 返回。
 */
export class CCBMeilisearch {
  private readonly client: Meilisearch;
  private readonly characters: IndexWithDocuments<CCBCharacterSearchDocument>;
  private readonly subjects: IndexWithDocuments<CCBSubjectSearchDocument>;
  private readonly metadata: Index<{ [key: string]: unknown; id: string; revision: string }>;

  constructor(options: CCBMeilisearchOptions) {
    // httpClient 用 node:http 单写 + keep-alive 替代 fetch，消除容器网络路径上每次请求约 40ms 的 TCP 罚时。
    this.client = options.client ?? new Meilisearch({
      host: INTERNAL_SEARCH_URL,
      apiKey: options.apiKey,
      timeout: SEARCH_TIMEOUT_MS,
      httpClient: meiliHttpClient,
    });
    this.characters = this.client.index<CCBCharacterSearchDocument>(CHARACTER_INDEX) as IndexWithDocuments<CCBCharacterSearchDocument>;
    this.subjects = this.client.index<CCBSubjectSearchDocument>(SUBJECT_INDEX) as IndexWithDocuments<CCBSubjectSearchDocument>;
    this.metadata = this.client.index(METADATA_INDEX);
  }

  async initialize(db: Database, sourcePath: string): Promise<void> {
    await this.client.health();
    await this.configureIndex(this.characters, CCB_CHARACTER_RANKING_RULES, ["name", "aliases"], ["nsfw"], ["comment", "collect"]);
    await this.configureIndex(this.subjects, CCB_SUBJECT_RANKING_RULES, ["name", "aliases"], ["tag", "meta_tag", "date", "score", "rating_count", "rank", "type", "nsfw"], ["date", "score", "rating_count", "heat", "rank"]);
    await this.ensureIndex(this.metadata);

    const revision = `${INDEX_SCHEMA_VERSION}:${await fingerprint(sourcePath)}`;
    const characterCount = Number((db.query("SELECT count(*) AS count FROM characters").get() as { count: number }).count);
    const subjectCount = Number((db.query("SELECT count(*) AS count FROM subjects").get() as { count: number }).count);
    const [characterStats, subjectStats] = await Promise.all([this.characters.getStats(), this.subjects.getStats()]);
    let indexedRevision: string | undefined;
    try {
      indexedRevision = (await this.metadata.getDocument("dataset")).revision;
    } catch (error) {
      if (!isMeiliApiError(error, "document_not_found")) throw error;
    }
    if (indexedRevision !== revision || characterStats.numberOfDocuments !== characterCount) {
      await this.replaceCharacters(db);
    }
    if (indexedRevision !== revision || subjectStats.numberOfDocuments !== subjectCount) {
      await this.replaceSubjects(db);
    }
    if (indexedRevision !== revision) {
      await waitForIndexTask(this.metadata.addDocuments([{ id: "dataset", revision }], { primaryKey: "id" }));
    }
  }

  async searchCharacters(keyword: string, limit: number): Promise<CCBSearchResult> {
    const result = await this.characters.search(keyword, {
      limit,
      filter: ["nsfw = false"],
    });
    return this.toResult(result);
  }

  async searchSubjects(keyword: string, limit: number, types: number[]): Promise<CCBSearchResult> {
    const typeFilter = types.map((type) => `type = ${type}`);
    const result = await this.subjects.search(keyword, {
      limit,
      filter: [[...typeFilter], "nsfw = false"],
    });
    return this.toResult(result);
  }

  async updateCharacter(document: CCBCharacterSearchDocument): Promise<void> {
    await waitForIndexTask(this.characters.updateDocuments([document], { primaryKey: "id" }));
  }

  private async configureIndex<T extends Record<string, unknown>>(
    index: Index<T>, rankingRules: string[], searchableAttributes: string[], filterableAttributes: string[], sortableAttributes: string[],
  ): Promise<void> {
    await this.ensureIndex(index);
    await waitForIndexTask(index.updateSettings({ rankingRules, searchableAttributes, filterableAttributes, sortableAttributes }));
  }

  private async ensureIndex<T extends Record<string, unknown>>(index: Index<T>): Promise<void> {
    try {
      await index.fetchInfo();
    } catch (error) {
      if (!isMeiliApiError(error, "index_not_found")) throw error;
      await waitForIndexTask(this.client.createIndex(index.uid, { primaryKey: "id" }));
    }
  }

  private async replaceCharacters(db: Database): Promise<void> {
    await waitForIndexTask(this.characters.deleteAllDocuments());
    const rows = db.query("SELECT id,name,name_cn,aliases,comments,collects FROM characters ORDER BY id").all() as Array<Record<string, unknown>>;
    await this.addBatches(this.characters, rows.map((row) => ({
      id: Number(row.id), name: String(row.name), aliases: uniqueStrings(String(row.name_cn), parseJsonStrings(row.aliases)),
      comment: Number(row.comments), collect: Number(row.collects), nsfw: false,
    })));
  }

  private async replaceSubjects(db: Database): Promise<void> {
    await waitForIndexTask(this.subjects.deleteAllDocuments());
    const columns = new Set((db.query("PRAGMA table_info(subjects)").all() as Array<{ name: string }>).map((column) => column.name));
    const rank = columns.has("rank") ? "rank" : "0 AS rank";
    const aliases = columns.has("aliases") ? "aliases" : "name_cn AS aliases";
    const rows = db.query(`SELECT id,name,name_cn,${aliases},date,raw_tags,meta_tags,score,rating_count,heat,type,nsfw,${rank} FROM subjects ORDER BY id`).all() as Array<Record<string, unknown>>;
    await this.addBatches(this.subjects, rows.map((row) => ({
      id: Number(row.id), name: String(row.name), aliases: uniqueStrings(String(row.name_cn), parseJsonStrings(row.aliases)),
      tag: Object.keys(parseJsonRecord(row.raw_tags)), meta_tag: parseJsonStrings(row.meta_tags),
      date: parseDate(String(row.date)), score: Number(row.score), rating_count: Number(row.rating_count),
      heat: Number(row.heat), rank: Number(row.rank ?? 0), type: Number(row.type), nsfw: Boolean(row.nsfw),
    })));
  }

  private async addBatches<T extends Record<string, unknown>>(index: Index<T>, documents: T[]): Promise<void> {
    for (let offset = 0; offset < documents.length; offset += BATCH_SIZE) {
      await waitForIndexTask(index.addDocuments(documents.slice(offset, offset + BATCH_SIZE), { primaryKey: "id" }));
    }
  }

  private toResult<T extends { id: number }>(result: SearchResponse<T>): CCBSearchResult {
    return { ids: result.hits.map((hit) => Number(hit.id)), estimatedTotalHits: result.estimatedTotalHits ?? result.hits.length };
  }
}

async function fingerprint(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function waitForIndexTask(task: EnqueuedTaskPromise): Promise<void> {
  const result = await task.waitTask({ timeout: INDEX_TASK_TIMEOUT_MS });
  if (result.status !== "succeeded") throw new Error(`CCB 搜索索引任务失败: ${result.error?.code ?? result.status}`);
}

function uniqueStrings(...values: Array<string | string[]>): string[] {
  return [...new Set(values.flatMap((value) => Array.isArray(value) ? value : [value]).map((value) => value.trim()).filter(Boolean))];
}

function parseJsonStrings(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(value: unknown): Record<string, number> {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, number> : {};
  } catch {
    return {};
  }
}

function parseDate(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? Number(`${match[1]}${match[2]}${match[3]}`) : 0;
}
