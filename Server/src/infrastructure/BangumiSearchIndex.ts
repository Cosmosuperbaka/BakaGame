import type { Database } from "bun:sqlite";
import {
  Meilisearch,
  type EnqueuedTaskPromise,
  type Index,
  type SearchResponse,
} from "meilisearch";
import { isMeiliApiError, meiliHttpClient } from "./MeiliHttpClient";

export interface BangumiSearchOptions {
  apiKey?: string;
  /** 搜索服务基址；缺省取回环。独立部署时由 `AppEnv.meilisearchUrl` 显式传入。 */
  host?: string;
  client?: Meilisearch;
}

/** 作品索引文档。字段与官方 `internal/search/subject` 的 document 对齐。 */
export interface SubjectSearchDocument {
  [key: string]: unknown;
  id: number;
  name: string;
  aliases: string[];
  /** 标签名数组，对应官方 `document.Tag`（来自 subjects.tags）。 */
  tag: string[];
  meta_tag: string[];
  date: number;
  score: number;
  rating_count: number;
  heat: number;
  rank: number;
  type: number;
}

/** 角色索引文档。字段与官方 `internal/search/character` 的 document 对齐。 */
export interface CharacterSearchDocument {
  [key: string]: unknown;
  id: number;
  name: string;
  aliases: string[];
  comment: number;
  collect: number;
}

export interface SubjectSearchQuery {
  keyword: string;
  limit: number;
  /** 作品类型白名单；缺省表示不限类型。 */
  types?: number[];
  /** 年份下界（含），对应官方 `air_date >= YYYY-01-01`。 */
  startYear?: number;
  /** 年份上界（含）。 */
  endYear?: number;
  /** 无关键词时是否按热度降序（猜歌的随机出题依赖它）。 */
  sortByHeat?: boolean;
}

export interface SearchResult {
  ids: number[];
  estimatedTotalHits: number;
}

const SUBJECT_INDEX = "subjects";
const CHARACTER_INDEX = "characters";
const METADATA_INDEX = "bangumi_search_metadata";
// v3：猜歌与 CEE 的作品索引合并为一个、并按官方口径重设 settings
// （filterable 去 nsfw、rankingRules 去 nsfw:asc），据此强制重建存量索引。
const INDEX_SCHEMA_VERSION = 3;
const BATCH_SIZE = 1_000;
// 基址由调用方从 `AppEnv.meilisearchUrl` 传入；这里只保留同网络命名空间下的回环缺省。
const DEFAULT_MEILISEARCH_URL = "http://127.0.0.1:7700";
const SEARCH_TIMEOUT_MS = 5_000;
const INDEX_TASK_TIMEOUT_MS = 600_000;

/** 与官方 `subject.rankRule()` 逐字一致，只去掉 `nsfw:asc`（数据里已没有 nsfw 条目）。 */
export const SUBJECT_RANKING_RULES = [
  "exactness",
  "words",
  "typo",
  "proximity",
  "attribute",
  "sort",
  "id:asc",
  "rank:asc",
  "score:desc",
];
/** 与官方 `character.rankRule()` 逐字一致，同样去掉 `nsfw:asc`。 */
export const CHARACTER_RANKING_RULES = [
  "exactness",
  "words",
  "typo",
  "proximity",
  "attribute",
  "sort",
  "id:asc",
  "comment:desc",
  "collect:desc",
];
/**
 * 与官方 filter 保持一致（见 `internal/search/subject/handle.go` 的 ReqFilter）：
 * type / tag / air_date→date / rating→score / rating_count / rank / meta_tags→meta_tag。
 * **`nsfw` 已去掉**：匿名请求拿不到 nsfw 条目，数据里不存在，留着只是多一个高基数 facet。
 */
export const SUBJECT_FILTERABLE = [
  "tag",
  "meta_tag",
  "date",
  "score",
  "rating_count",
  "rank",
  "type",
];
/**
 * 可排序字段。**`id` 必须在列**：无关键词出题时的 sort 用 `id:asc` 做最终稳定
 * 兜底（同 heat/rank/score 时保证结果确定）。Meilisearch 只允许按显式声明为
 * sortable 的字段排序，缺一个整个查询就会被拒；rankingRules 里的 `id:asc` 不受
 * 此限制，两处语义不同。
 */
export const SUBJECT_SORTABLE = ["id", "date", "score", "rating_count", "heat", "rank"];
export const SUBJECT_SEARCHABLE = ["name", "aliases"];
/** 角色索引：官方 filterable 只有 nsfw，去掉后为空。 */
export const CHARACTER_FILTERABLE: string[] = [];
export const CHARACTER_SORTABLE = ["comment", "collect"];
export const CHARACTER_SEARCHABLE = ["name", "aliases"];

type IndexWithDocuments<T extends Record<string, unknown>> = Index<T> & {
  getStats(): Promise<{ numberOfDocuments: number; isIndexing?: boolean }>;
};

/**
 * 全部搜索索引的唯一适配器：猜歌与 CEE 共用 `subjects` 索引，角色索引为 `characters`。
 * 同一批作品只索引一份，体积与更新口径都只有一处。
 */
export class BangumiSearchIndex {
  private readonly client: Meilisearch;
  private readonly subjects: IndexWithDocuments<SubjectSearchDocument>;
  private readonly characters: IndexWithDocuments<CharacterSearchDocument>;
  private readonly metadata: Index<{ [key: string]: unknown; id: string; revision: string }>;
  private initialization: Promise<void> | undefined;

  constructor(options: BangumiSearchOptions = {}) {
    // httpClient 用 node:http 单写 + keep-alive 替代 fetch，消除容器网络路径上的 TCP 罚时。
    this.client =
      options.client ??
      new Meilisearch({
        host: options.host?.replace(/\/+$/, "") || DEFAULT_MEILISEARCH_URL,
        apiKey: options.apiKey,
        timeout: SEARCH_TIMEOUT_MS,
        httpClient: meiliHttpClient,
      });
    this.subjects = this.client.index<SubjectSearchDocument>(
      SUBJECT_INDEX
    ) as IndexWithDocuments<SubjectSearchDocument>;
    this.characters = this.client.index<CharacterSearchDocument>(
      CHARACTER_INDEX
    ) as IndexWithDocuments<CharacterSearchDocument>;
    this.metadata = this.client.index(METADATA_INDEX);
  }

  /** 只读探测：服务可达性与两个索引的文档数，给后台状态页。 */
  async status(): Promise<{ subjects: number; characters: number; isIndexing: boolean }> {
    await this.client.health();
    const [subjects, characters] = await Promise.all([
      this.subjects.getStats(),
      this.characters.getStats(),
    ]);
    return {
      subjects: subjects.numberOfDocuments,
      characters: characters.numberOfDocuments,
      isIndexing: Boolean(subjects.isIndexing || characters.isIndexing),
    };
  }

  /**
   * 初始化索引：配置、必要时全量灌入。同一适配器只执行一次——猜歌与 CEE 两条链路共用
   * 一个适配器，并发调用拿到的是同一个 Promise；失败不缓存，下次调用可以重试。
   *
   * 重灌条件只有三个：索引架构版本变了、数据集基线标识变了、文档数与库不一致。
   * **不能**用数据集文件内容当修订号：数据集可写，更新器、发现、备份每一轮都在改文件，
   * 那样每次重启都会清空并重灌数十万文档，期间本地数据查询全部挂起。
   * 平时的变更由待同步队列增量写进索引，所以修订号只绑定「会改变索引内容的基线」。
   */
  initialize(db: Database): Promise<void> {
    this.initialization ??= this.runInitialize(db).catch((error: unknown) => {
      this.initialization = undefined;
      throw error;
    });
    return this.initialization;
  }

  private async runInitialize(db: Database): Promise<void> {
    await this.client.health();
    await this.configureIndex(
      this.subjects,
      SUBJECT_RANKING_RULES,
      SUBJECT_SEARCHABLE,
      SUBJECT_FILTERABLE,
      SUBJECT_SORTABLE
    );
    await this.configureIndex(
      this.characters,
      CHARACTER_RANKING_RULES,
      CHARACTER_SEARCHABLE,
      CHARACTER_FILTERABLE,
      CHARACTER_SORTABLE
    );
    await this.ensureIndex(this.metadata);

    // 基线标识取 SQLite 的 user_version：构建出新基线时由构建方提升它，日常写入不会动它。
    const baseline = Number(
      (db.query("PRAGMA user_version").get() as { user_version: number }).user_version
    );
    const revision = `${INDEX_SCHEMA_VERSION}:${baseline}`;
    const subjectCount = Number(
      (db.query("SELECT count(*) AS count FROM subjects").get() as { count: number }).count
    );
    const characterCount = Number(
      (db.query("SELECT count(*) AS count FROM characters").get() as { count: number }).count
    );
    const [subjectStats, characterStats] = await Promise.all([
      this.subjects.getStats(),
      this.characters.getStats(),
    ]);
    let indexedRevision: string | undefined;
    try {
      indexedRevision = (await this.metadata.getDocument("dataset")).revision;
    } catch (error) {
      if (!isMeiliApiError(error, "document_not_found")) throw error;
    }
    if (indexedRevision !== revision || subjectStats.numberOfDocuments !== subjectCount) {
      await this.replaceSubjects(db);
    }
    if (indexedRevision !== revision || characterStats.numberOfDocuments !== characterCount) {
      await this.replaceCharacters(db);
    }
    if (indexedRevision !== revision) {
      await waitForIndexTask(
        this.metadata.addDocuments([{ id: "dataset", revision }], { primaryKey: "id" })
      );
    }
  }

  /**
   * 作品搜索。两个玩法共用：猜歌传 `types: [2]` + 年份区间，CEE 传它允许的作品类型。
   * **不再过滤 nsfw** —— 数据里已经不存在 nsfw 条目（构建期剔除，且匿名 API 也拿不到）。
   */
  async searchSubjects(query: SubjectSearchQuery): Promise<SearchResult> {
    const filter: Array<string | string[]> = [];
    if (query.types?.length) filter.push(query.types.map((type) => `type = ${type}`));
    if (query.startYear) filter.push(`date >= ${query.startYear}0101`);
    if (query.endYear) filter.push(`date <= ${query.endYear}1231`);
    const result = await this.subjects.search(query.keyword, {
      limit: query.limit,
      filter: filter as string[][],
      sort: query.sortByHeat ? ["heat:desc", "rank:asc", "score:desc", "id:asc"] : undefined,
    });
    return this.toResult(result as SearchResponse<SubjectSearchDocument>);
  }

  async searchCharacters(keyword: string, limit: number): Promise<SearchResult> {
    const result = await this.characters.search(keyword, { limit });
    return this.toResult(result as SearchResponse<CharacterSearchDocument>);
  }

  async updateCharacter(document: CharacterSearchDocument): Promise<void> {
    await waitForIndexTask(this.characters.updateDocuments([document], { primaryKey: "id" }));
  }

  /** 单条更新作品索引：数据集可写之后，元数据变更要即时反映到搜索。 */
  async updateSubject(document: SubjectSearchDocument): Promise<void> {
    await waitForIndexTask(this.subjects.updateDocuments([document], { primaryKey: "id" }));
  }

  /**
   * 批量更新作品索引（更新器的待同步队列用）。
   *
   * 用 `addDocuments` 而不是逐条 `updateDocuments`：Meilisearch 的每次写都是
   * 一个异步任务，逐条发会让任务队列被几十万条小任务撑爆，批量写能把
   * 「一轮刷新」压成几次任务。
   */
  async updateSubjects(documents: SubjectSearchDocument[]): Promise<void> {
    if (!documents.length) return;
    await this.addBatches(this.subjects, documents);
  }

  /** 构造索引文档。更新器落库后按同一份映射回写索引，避免两处口径漂移。 */
  toSubjectDocument(row: Record<string, unknown>): SubjectSearchDocument {
    return {
      id: Number(row.id),
      name: String(row.name),
      aliases: uniqueStrings(cellText(row.name_cn), parseJsonStrings(row.aliases)),
      tag: parseJsonStrings(row.tags),
      meta_tag: parseJsonStrings(row.meta_tags),
      date: parseDate(cellText(row.date)),
      score: Number(row.score ?? 0),
      rating_count: Number(row.rating_count ?? 0),
      heat: Number(row.heat ?? 0),
      rank: Number(row.rank ?? 0),
      type: Number(row.type ?? 0),
    };
  }

  private async configureIndex<T extends Record<string, unknown>>(
    index: Index<T>,
    rankingRules: string[],
    searchableAttributes: string[],
    filterableAttributes: string[],
    sortableAttributes: string[]
  ): Promise<void> {
    await this.ensureIndex(index);
    await waitForIndexTask(
      index.updateSettings({
        rankingRules,
        searchableAttributes,
        filterableAttributes,
        sortableAttributes,
      })
    );
  }

  private async ensureIndex<T extends Record<string, unknown>>(index: Index<T>): Promise<void> {
    try {
      await index.fetchInfo();
    } catch (error) {
      if (!isMeiliApiError(error, "index_not_found")) throw error;
      await waitForIndexTask(this.client.createIndex(index.uid, { primaryKey: "id" }));
    }
  }

  private async replaceSubjects(db: Database): Promise<void> {
    await waitForIndexTask(this.subjects.deleteAllDocuments());
    await this.addPaged(
      this.subjects,
      db,
      "SELECT id,name,name_cn,aliases,tags,meta_tags,date,score,rating_count,heat,rank,type FROM subjects",
      (row) => this.toSubjectDocument(row)
    );
  }

  private async replaceCharacters(db: Database): Promise<void> {
    await waitForIndexTask(this.characters.deleteAllDocuments());
    await this.addPaged(
      this.characters,
      db,
      "SELECT id,name,name_cn,aliases,comments,collects FROM characters",
      (row) => ({
        id: Number(row.id),
        name: String(row.name),
        aliases: uniqueStrings(cellText(row.name_cn), parseJsonStrings(row.aliases)),
        comment: Number(row.comments ?? 0),
        collect: Number(row.collects ?? 0),
      })
    );
  }

  /**
   * 按主键分页读、分批写：数十万行不一次性展开进内存，也不在等待 Meilisearch 任务期间
   * 长时间持有读游标（会挡住同库的写者）。
   */
  private async addPaged<T extends Record<string, unknown>>(
    index: Index<T>,
    db: Database,
    selectSql: string,
    toDocument: (row: Record<string, unknown>) => T
  ): Promise<void> {
    const page = db.query(`${selectSql} WHERE id > ? ORDER BY id LIMIT ${BATCH_SIZE}`);
    let lastId = Number.NEGATIVE_INFINITY;
    for (;;) {
      const rows = page.all(lastId) as Array<Record<string, unknown>>;
      if (rows.length === 0) return;
      await waitForIndexTask(index.addDocuments(rows.map(toDocument), { primaryKey: "id" }));
      lastId = Number(rows[rows.length - 1]!.id);
    }
  }

  private async addBatches<T extends Record<string, unknown>>(
    index: Index<T>,
    documents: T[]
  ): Promise<void> {
    for (let offset = 0; offset < documents.length; offset += BATCH_SIZE) {
      await waitForIndexTask(
        index.addDocuments(documents.slice(offset, offset + BATCH_SIZE), { primaryKey: "id" })
      );
    }
  }

  private toResult<T extends { id: number }>(result: SearchResponse<T>): SearchResult {
    return {
      ids: result.hits.map((hit) => Number(hit.id)),
      estimatedTotalHits: result.estimatedTotalHits ?? result.hits.length,
    };
  }
}

async function waitForIndexTask(task: EnqueuedTaskPromise): Promise<void> {
  const result = await task.waitTask({ timeout: INDEX_TASK_TIMEOUT_MS });
  if (result.status !== "succeeded")
    throw new Error(`搜索索引任务失败: ${result.error?.code ?? result.status}`);
}

export function uniqueStrings(...values: Array<string | string[]>): string[] {
  return [
    ...new Set(
      values
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ];
}

/** 取文本列：字符串原样收，数字与布尔取其字面文本，其余（null、undefined、对象、数组）按空串，避免把 [object Object] 写进索引。 */
export function cellText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    return String(value);
  return "";
}

export function parseJsonStrings(value: unknown): string[] {
  try {
    const parsed = JSON.parse(cellText(value) || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function parseDate(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? Number(`${match[1]}${match[2]}${match[3]}`) : 0;
}
