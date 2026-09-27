import type { Database } from "bun:sqlite";
import { Meilisearch, type Index, type SearchResponse } from "meilisearch";

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
  page_rank: number;
  heat: number;
  rank: number;
  type: number;
  nsfw: boolean;
}

export interface CCBMeilisearchOptions {
  url: string;
  apiKey?: string;
  timeoutMs?: number;
  client?: Meilisearch;
}

export interface CCBSearchResult {
  ids: number[];
  estimatedTotalHits: number;
}

const CHARACTER_INDEX = "ccb_characters";
const SUBJECT_INDEX = "ccb_subjects";
const BATCH_SIZE = 1_000;

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

  constructor(options: CCBMeilisearchOptions) {
    this.client = options.client ?? new Meilisearch({
      host: options.url,
      apiKey: options.apiKey,
      timeout: options.timeoutMs ?? 5_000,
    });
    this.characters = this.client.index<CCBCharacterSearchDocument>(CHARACTER_INDEX) as IndexWithDocuments<CCBCharacterSearchDocument>;
    this.subjects = this.client.index<CCBSubjectSearchDocument>(SUBJECT_INDEX) as IndexWithDocuments<CCBSubjectSearchDocument>;
  }

  async initialize(db: Database): Promise<void> {
    await this.client.health();
    await this.configureIndex(this.characters, CCB_CHARACTER_RANKING_RULES, ["name", "aliases"], ["nsfw"], ["comment", "collect"]);
    await this.configureIndex(this.subjects, CCB_SUBJECT_RANKING_RULES, ["name", "aliases"], ["tag", "meta_tag", "date", "score", "rating_count", "rank", "type", "nsfw"], ["date", "score", "rating_count", "page_rank", "heat", "rank"]);

    const characterCount = Number((db.query("SELECT count(*) AS count FROM characters").get() as { count: number }).count);
    const subjectCount = Number((db.query("SELECT count(*) AS count FROM subjects").get() as { count: number }).count);
    const [characterStats, subjectStats] = await Promise.all([this.characters.getStats(), this.subjects.getStats()]);
    if (characterStats.numberOfDocuments !== characterCount) {
      await this.replaceCharacters(db);
    }
    if (subjectStats.numberOfDocuments !== subjectCount) {
      await this.replaceSubjects(db);
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
    await this.characters.updateDocuments([document], { primaryKey: "id" }).waitTask();
  }

  private async configureIndex<T extends Record<string, unknown>>(
    index: Index<T>, rankingRules: string[], searchableAttributes: string[], filterableAttributes: string[], sortableAttributes: string[],
  ): Promise<void> {
    try {
      await index.fetchInfo();
    } catch {
      await this.client.createIndex(index.uid, { primaryKey: "id" }).waitTask();
    }
    await index.updateSettings({ rankingRules, searchableAttributes, filterableAttributes, sortableAttributes }).waitTask();
  }

  private async replaceCharacters(db: Database): Promise<void> {
    await this.characters.deleteAllDocuments().waitTask();
    const rows = db.query("SELECT id,name,name_cn,aliases,comments,collects FROM characters ORDER BY id").all() as Array<Record<string, unknown>>;
    await this.addBatches(this.characters, rows.map((row) => ({
      id: Number(row.id), name: String(row.name), aliases: uniqueStrings(String(row.name_cn), parseJsonStrings(row.aliases)),
      comment: Number(row.comments), collect: Number(row.collects), nsfw: false,
    })));
  }

  private async replaceSubjects(db: Database): Promise<void> {
    await this.subjects.deleteAllDocuments().waitTask();
    const columns = new Set((db.query("PRAGMA table_info(subjects)").all() as Array<{ name: string }>).map((column) => column.name));
    const rank = columns.has("rank") ? "rank" : "0 AS rank";
    const aliases = columns.has("aliases") ? "aliases" : "name_cn AS aliases";
    const rows = db.query(`SELECT id,name,name_cn,${aliases},date,raw_tags,meta_tags,score,rating_count,heat,type,nsfw,${rank} FROM subjects ORDER BY id`).all() as Array<Record<string, unknown>>;
    await this.addBatches(this.subjects, rows.map((row) => ({
      id: Number(row.id), name: String(row.name), aliases: uniqueStrings(String(row.name_cn), parseJsonStrings(row.aliases)),
      tag: Object.keys(parseJsonRecord(row.raw_tags)), meta_tag: parseJsonStrings(row.meta_tags),
      date: parseDate(String(row.date)), score: Number(row.score), rating_count: Number(row.rating_count),
      page_rank: Number(row.rating_count), heat: Number(row.heat), rank: Number(row.rank ?? 0), type: Number(row.type), nsfw: Boolean(row.nsfw),
    })));
  }

  private async addBatches<T extends Record<string, unknown>>(index: Index<T>, documents: T[]): Promise<void> {
    for (let offset = 0; offset < documents.length; offset += BATCH_SIZE) {
      await index.addDocuments(documents.slice(offset, offset + BATCH_SIZE), { primaryKey: "id" }).waitTask();
    }
  }

  private toResult<T extends { id: number }>(result: SearchResponse<T>): CCBSearchResult {
    return { ids: result.hits.map((hit) => Number(hit.id)), estimatedTotalHits: result.estimatedTotalHits ?? result.hits.length };
  }
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
