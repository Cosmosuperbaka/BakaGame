import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Meilisearch, MeilisearchApiError, type EnqueuedTaskPromise, type Index, type SearchResponse } from "meilisearch";
import type { CCBMeilisearchOptions } from "./CCBMeilisearch";
import type { AnimeAutoFilters } from "../shared/Index";

export interface BangumiSubjectSearchDocument {
  [key: string]: unknown;
  id: number;
  name: string;
  aliases: string[];
  date: number;
  score: number;
  rating_count: number;
  heat: number;
  rank: number;
  type: number;
  nsfw: boolean;
}

const INDEX = "bangumi_subjects";
const METADATA = "bangumi_search_metadata";
const SCHEMA_VERSION = 1;
const BATCH_SIZE = 1_000;
const INTERNAL_SEARCH_URL = "http://127.0.0.1:7700";
const SEARCH_TIMEOUT_MS = 5_000;
const INDEX_TASK_TIMEOUT_MS = 600_000;
const RANKING_RULES = ["exactness", "words", "typo", "proximity", "attribute", "sort", "heat:desc", "rank:asc", "score:desc", "id:asc"];

type Indexed = Index<BangumiSubjectSearchDocument> & { getStats(): Promise<{ numberOfDocuments: number }> };

export class BangumiMeilisearch {
  private readonly client: Meilisearch;
  private readonly subjects: Indexed;
  private readonly metadata: Index<{ id: string; revision: string }>;

  constructor(options: CCBMeilisearchOptions) {
    this.client = options.client ?? new Meilisearch({ host: INTERNAL_SEARCH_URL, apiKey: options.apiKey, timeout: SEARCH_TIMEOUT_MS });
    this.subjects = this.client.index<BangumiSubjectSearchDocument>(INDEX) as Indexed;
    this.metadata = this.client.index(METADATA);
  }

  async initialize(db: Database, sourcePath: string): Promise<void> {
    await this.client.health();
    await this.ensureIndex(this.subjects);
    await waitForIndexTask(this.subjects.updateSettings({
      rankingRules: RANKING_RULES,
      searchableAttributes: ["name", "aliases"],
      filterableAttributes: ["date", "score", "rating_count", "rank", "type", "nsfw"],
      sortableAttributes: ["heat", "rank", "score", "id"],
    }));
    await this.ensureIndex(this.metadata);
    const revision = `${SCHEMA_VERSION}:${await fingerprint(sourcePath)}`;
    const count = Number((db.query("SELECT count(*) AS count FROM subjects").get() as { count: number }).count);
    const stats = await this.subjects.getStats();
    let indexedRevision: string | undefined;
    try { indexedRevision = (await this.metadata.getDocument("dataset")).revision; }
    catch (error) { if (!(error instanceof MeilisearchApiError) || error.cause?.code !== "document_not_found") throw error; }
    if (indexedRevision !== revision || stats.numberOfDocuments !== count) {
      await this.replace(db);
      await waitForIndexTask(this.metadata.addDocuments([{ id: "dataset", revision }], { primaryKey: "id" }));
    }
  }

  async searchSubjects(keyword: string, limit: number, filters: AnimeAutoFilters = {}): Promise<number[]> {
    const filter = ["type = 2", "nsfw = false"];
    if (filters.startYear) filter.push(`date >= ${filters.startYear}0101`);
    if (filters.endYear) filter.push(`date < ${(filters.endYear + 1)}0101`);
    const result = await this.subjects.search(keyword, { limit, filter, sort: keyword.trim() ? undefined : ["heat:desc", "rank:asc", "score:desc", "id:asc"] });
    return (result as SearchResponse<BangumiSubjectSearchDocument>).hits.map((hit) => Number(hit.id));
  }

  private async replace(db: Database): Promise<void> {
    await waitForIndexTask(this.subjects.deleteAllDocuments());
    const columns = new Set((db.query("PRAGMA table_info(subjects)").all() as Array<{ name: string }>).map((column) => column.name));
    const rank = columns.has("rank") ? "rank" : "0 AS rank";
    const aliases = columns.has("aliases") ? "aliases" : "name_cn AS aliases";
    const rows = db.query(`SELECT id,name,name_cn,${aliases},date,score,rating_count,heat,type,nsfw,${rank} FROM subjects ORDER BY id`).all() as Array<Record<string, unknown>>;
    const docs = rows.map((row) => ({ id: Number(row.id), name: String(row.name), aliases: uniqueStrings(typeof row.name_cn === "string" ? row.name_cn : "", parseJsonStrings(row.aliases)), date: parseDate(String(row.date)), score: Number(row.score ?? 0), rating_count: Number(row.rating_count ?? 0), heat: Number(row.heat ?? 0), rank: Number(row.rank ?? 0), type: Number(row.type ?? 0), nsfw: Boolean(row.nsfw) }));
    for (let offset = 0; offset < docs.length; offset += BATCH_SIZE) await waitForIndexTask(this.subjects.addDocuments(docs.slice(offset, offset + BATCH_SIZE), { primaryKey: "id" }));
  }
  private async ensureIndex<T extends Record<string, unknown>>(index: Index<T>): Promise<void> {
    try { await index.fetchInfo(); }
    catch (error) {
      if (!(error instanceof MeilisearchApiError) || error.cause?.code !== "index_not_found") throw error;
      await waitForIndexTask(this.client.createIndex(index.uid, { primaryKey: "id" }));
    }
  }
}

async function fingerprint(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
async function waitForIndexTask(task: EnqueuedTaskPromise): Promise<void> { const result = await task.waitTask({ timeout: INDEX_TASK_TIMEOUT_MS }); if (result.status !== "succeeded") throw new Error(`Bangumi 搜索索引任务失败: ${result.error?.code ?? result.status}`); }
function parseDate(value: string): number { const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value); return match ? Number(`${match[1]}${match[2]}${match[3]}`) : 0; }
function uniqueStrings(...values: Array<string | string[]>): string[] { return [...new Set(values.flatMap((value) => Array.isArray(value) ? value : [value]).map((value) => value.trim()).filter(Boolean))]; }
function parseJsonStrings(value: unknown): string[] { try { const parsed = JSON.parse(String(value ?? "[]")); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; } catch { return []; } }
