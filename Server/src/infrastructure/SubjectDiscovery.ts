import type { Database } from "bun:sqlite";
import PQueue from "p-queue";
import {
  BANGUMI_DISCOVERY_CONCURRENCY,
  BANGUMI_DISCOVERY_REQUEST_TIMEOUT_MS,
  BANGUMI_DISCOVERY_TOTAL_BUDGET_MS,
} from "../config/Constants";
import type { BangumiSearchIndex } from "./BangumiSearchIndex";
import { BANGUMI_USER_AGENT } from "./BangumiUserAgent";

/**
 * 新条目发现：补上「两份 dump 之间新出的作品」。
 *
 * 没有它，搜索永远搜不到新番 —— 数据集是构建产物，下次构建之前不会自己更新。
 *
 * 为什么不用 `sort: "date"`：官方搜索的 sort 只接受白名单内的字段（见
 * `internal/search/subject/handle.go`），传 date 会被直接拒绝。改用 `air_date` 过滤：
 * 只要「首播日期晚于上次同步日」的条目，结果集就是这段时间的新增，分页取全即可。
 * 搜索结果的 total 有上限，一次窗口内足够。
 *
 * **裁剪规则同样适用**：既没有角色关联、也没有关联音乐的条目直接跳过 —— 与全量构建
 * 的判据保持一致，否则库里会慢慢长出一批永远用不到的条目。
 */

export interface DiscoveryOptions {
  db: Database;
  base: string;
  search?: BangumiSearchIndex;
  /** 上次同步到哪一天（YYYY-MM-DD）；缺省回看 30 天。 */
  since?: string;
  /** 单次最多带入多少条，防止上游异常时灌爆。 */
  limit?: number;
  /** 相邻候选之间的间隔：上游是公益服务，每日任务不该连续猛打。 */
  pauseMs?: number;
  fetcher?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 单次出站请求超时；缺省取常量。 */
  requestTimeoutMs?: number;
  /** 本次发现的总时间预算；缺省取常量。 */
  totalBudgetMs?: number;
}

export interface DiscoveryResult {
  window: string;
  candidates: number;
  added: number;
  skipped: number;
  failed: number;
  /** 失败作品的编号与原因（有上限）：运维靠它排查，光有计数说明不了为什么。 */
  failures: Array<{ id: number; message: string }>;
}

/** 失败样本只留前若干条：上游整体故障时几百条同样的原因没有信息量。 */
const MAX_FAILURE_SAMPLES = 20;

/** 出站请求的公共上下文：同一次发现共用的取数函数、地址与截止时间。 */
interface FetchContext {
  fetcher: typeof fetch;
  base: string;
  requestTimeoutMs: number;
  /** 总预算的信号；与每个请求自己的超时合并，任何一个触发都中止。 */
  budget: AbortSignal;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
/** 作品类型：书籍 / 动画 / 音乐 / 游戏 / 三次元。 */
const ALL_TYPES = [1, 2, 3, 4, 6];
/** 上游单页上限：`limit` 只认查询串，且超过 20 会被压回 20。 */
const SEARCH_PAGE_SIZE = 20;
const DEFAULT_PAUSE_MS = 100;
/** 角色关联：接口只给中文关系名，`type` 是角色类型（人物 / 机体 / 组织…），不能当关系码。 */
const CHARACTER_RELATIONS: Record<string, number> = {
  主角: 1,
  配角: 2,
  客串: 3,
  闲角: 4,
  旁白: 5,
  声库: 6,
};
/** 音乐关联：与 dump 的关系码同义，运行时据此区分片头、片尾与插曲。 */
const MUSIC_RELATIONS: Record<string, number> = {
  原声集: 3001,
  角色歌: 3002,
  片头曲: 3003,
  片尾曲: 3004,
  插入歌: 3005,
  印象曲: 3006,
  广播剧: 3007,
};
const OTHER_MUSIC_RELATION = 3099;

/** 接口形态的 infobox 是键值数组，dump 形态是 wikitext；多值项的元素形如 `{ v }`。 */
export type ApiInfobox = string | Array<{ key?: string; value?: unknown }>;

const infoboxValues = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value])
    .map((item) => {
      const text = typeof item === "object" && item ? (item as { v?: unknown }).v : item;
      return typeof text === "string" || typeof text === "number" ? String(text).trim() : "";
    })
    .filter(Boolean);

/** 把接口的键值数组还原成 dump 同形的 wikitext，库里 `infobox` 列只有这一种形态。 */
export const infoboxToWikitext = (infobox: ApiInfobox | null | undefined): string => {
  if (typeof infobox === "string") return infobox;
  if (!Array.isArray(infobox) || !infobox.length) return "";
  const lines = infobox.map(({ key, value }) =>
    Array.isArray(value)
      ? `|${key}={\r\n${infoboxValues(value)
          .map((item) => `[${item}]`)
          .join("\r\n")}\r\n}`
      : `|${key}= ${infoboxValues(value)[0] ?? ""}`
  );
  return `{{Infobox\r\n${lines.join("\r\n")}\r\n}}`;
};

const infoboxField = (infobox: ApiInfobox | undefined, keys: string[]): string[] => {
  if (!Array.isArray(infobox)) return [];
  for (const key of keys) {
    const values = infoboxValues(infobox.find((item) => item.key === key)?.value);
    if (values.length) return values;
  }
  return [];
};

/** `/v0/subjects/{id}` 里本项目用得到的字段。 */
interface ApiSubject {
  id?: number;
  type?: number;
  name?: string;
  name_cn?: string;
  date?: string;
  infobox?: ApiInfobox;
  summary?: string;
  nsfw?: boolean;
  tags?: Array<{ name?: string; count?: number }>;
  meta_tags?: string[];
  images?: { large?: string };
  rating?: { score?: number; total?: number; rank?: number };
  collection?: Record<string, number>;
}

interface ApiCharacter {
  id?: number;
  /** 角色类型（1 人物 / 2 机体 / 3 舰船 / 4 组织），对应库里的 `role` 列。 */
  type?: number;
  /** 关联关系的中文名，只有作品的角色列表接口才带。 */
  relation?: string;
  name?: string;
  gender?: string | null;
  summary?: string;
  infobox?: ApiInfobox;
  stat?: { comments?: number; collects?: number };
}

const ymd = (time: number) => new Date(time).toISOString().slice(0, 10);

export async function discoverNewSubjects(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const now = options.now ?? Date.now;
  const since = options.since ?? ymd(now() - 30 * DAY_MS);
  const limit = options.limit ?? 1000;
  const pauseMs = options.pauseMs ?? DEFAULT_PAUSE_MS;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const context: FetchContext = {
    fetcher: options.fetcher ?? fetch,
    base: options.base,
    requestTimeoutMs: options.requestTimeoutMs ?? BANGUMI_DISCOVERY_REQUEST_TIMEOUT_MS,
    budget: AbortSignal.timeout(options.totalBudgetMs ?? BANGUMI_DISCOVERY_TOTAL_BUDGET_MS),
  };

  const candidates = await searchSince(context, since, limit);
  const result: DiscoveryResult = {
    window: since,
    candidates: candidates.length,
    added: 0,
    skipped: 0,
    failed: 0,
    failures: [],
  };
  if (!candidates.length) return result;

  const known = new Set<number>(
    (options.db.query("SELECT id FROM subjects").all() as Array<{ id: number }>).map((row) =>
      Number(row.id)
    )
  );
  const fail = (id: number, error: unknown) => {
    result.failed += 1;
    if (result.failures.length < MAX_FAILURE_SAMPLES)
      result.failures.push({
        id,
        message: error instanceof Error ? error.message : String(error),
      });
  };

  for (const subjectId of candidates) {
    // 已经在库里的不动：它们的评分/热度由日常刷新负责，这里只补「新」的。
    if (known.has(subjectId)) {
      result.skipped += 1;
      continue;
    }
    if (context.budget.aborted) {
      fail(subjectId, new Error("超出本次发现的总时间预算，留待下次"));
      continue;
    }
    if (pauseMs > 0) await sleep(pauseMs);
    try {
      const added = await importSubject(context, options.db, options.search, subjectId);
      if (added) result.added += 1;
      else result.skipped += 1;
    } catch (error) {
      fail(subjectId, error);
    }
  }
  return result;
}

/** 单个请求的取消信号：自身超时与整体预算任一触发都中止。 */
const requestSignal = (context: FetchContext): AbortSignal =>
  AbortSignal.any([AbortSignal.timeout(context.requestTimeoutMs), context.budget]);

/** 按首播日期过滤 + 分页取全（total 有上限，够一个同步窗口用）。 */
async function searchSince(context: FetchContext, since: string, limit: number): Promise<number[]> {
  const ids: number[] = [];
  let offset = 0;
  while (ids.length < limit) {
    const page = new URLSearchParams({ limit: String(SEARCH_PAGE_SIZE), offset: String(offset) });
    const response = await context.fetcher(`${context.base}/v0/search/subjects?${page}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": BANGUMI_USER_AGENT,
      },
      body: JSON.stringify({
        keyword: "",
        filter: { air_date: [`>=${since}`], type: ALL_TYPES },
        sort: "heat",
      }),
      signal: requestSignal(context),
    });
    // 搜索失败必须抛出：否则「上游挂了」和「这段时间没有新条目」在结果上一模一样。
    if (!response.ok) throw new Error(`新条目搜索失败：HTTP ${response.status}`);
    const body = (await response.json()) as { data?: Array<{ id: number }>; total?: number };
    const found = (body.data ?? []).map((item) => Number(item.id));
    ids.push(...found);
    offset += found.length;
    // 翻页只看 total：实际页大小由上游决定，不能拿「不满一页」判断结束。
    if (!found.length || offset >= Number(body.total ?? 0)) break;
  }
  return ids.slice(0, limit);
}

interface ApiRelation {
  id?: number;
  type?: number;
  relation?: string;
}

/** 一部作品入库所需的全部上游数据：拿齐之后才写库。 */
interface SubjectBundle {
  subject: ApiSubject;
  characterRows: ApiCharacter[];
  relationRows: ApiRelation[];
  /** 库里还没有的角色的详情；上游 404 的角色不在其中。 */
  characterDetails: Map<number, ApiCharacter>;
  /** 关联音乐条目的详情，键为条目编号；上游 404 记为 null。 */
  musicDetails: Map<number, ApiSubject | null>;
}

/**
 * 导入单个作品，分两个阶段：先把所有上游数据**抓齐**（只读库），再在**一个事务**里写入。
 * 抓取途中任何一次失败都整体放弃、库里不留任何东西，该作品下次发现仍是「未知」，会自然重试；
 * 若边抓边写，作品行先落库后角色抓取失败，它就会永远被当成「已有」而跳过，残缺且不可自愈。
 * 返回是否真的入库（被裁掉的返回 false）。
 */
async function importSubject(
  context: FetchContext,
  db: Database,
  search: BangumiSearchIndex | undefined,
  subjectId: number
): Promise<boolean> {
  const bundle = await fetchBundle(context, db, subjectId);
  if (!bundle) return false;
  const insertedCharacterIds = db.transaction(() => writeBundle(db, subjectId, bundle))();
  // 索引在提交之后再写：索引失败不影响数据落库，下轮重建会补上。文档从刚落库的行构造，
  // 与整库重灌、更新器走同一份映射，不再各写一套。
  if (search) {
    const subjectRow = db
      .query(
        "SELECT id,name,name_cn,aliases,tags,meta_tags,date,score,rating_count,heat,rank,type FROM subjects WHERE id=?"
      )
      .get(subjectId) as Record<string, unknown>;
    search.updateSubject(search.toSubjectDocument(subjectRow)).catch(() => {});
    for (const characterId of insertedCharacterIds) {
      const characterRow = db
        .query("SELECT id,name,name_cn,aliases,comments,collects FROM characters WHERE id=?")
        .get(characterId) as Record<string, unknown>;
      search.updateCharacter(search.toCharacterDocument(characterRow)).catch(() => {});
    }
  }
  return true;
}

/** 抓取阶段：只读库、只发请求；返回 null 表示该作品不该入库。 */
async function fetchBundle(
  context: FetchContext,
  db: Database,
  subjectId: number
): Promise<SubjectBundle | null> {
  const { base } = context;
  const [subject, characters, related] = await Promise.all([
    getJson<ApiSubject>(context, `${base}/v0/subjects/${subjectId}`),
    getJson<ApiCharacter[]>(context, `${base}/v0/subjects/${subjectId}/characters`),
    getJson<ApiRelation[]>(context, `${base}/v0/subjects/${subjectId}/subjects`),
  ]);
  if (!subject) return null;
  // 合规：匿名拿到的条目 nsfw 恒为 false，这里再挡一道，防止上游行为变化。
  if (subject.nsfw) return null;

  const characterRows = Array.isArray(characters) ? characters : [];
  const relationRows = Array.isArray(related) ? related : [];
  const musicIds = relationRows
    .filter((row) => Number(row.type) === 3)
    .map((row) => Number(row.id));
  // 裁剪：没角色也没音乐的直接丢，与全量构建同一条判据。
  if (!characterRows.length && !musicIds.length) return null;

  // 缺失角色与音乐的详情并发抓取（并发窗口受限）：作品常有数十个角色，串行会拖到天亮。
  const queue = new PQueue({ concurrency: BANGUMI_DISCOVERY_CONCURRENCY });
  const characterDetails = new Map<number, ApiCharacter>();
  const musicDetails = new Map<number, ApiSubject | null>();
  const requested = new Set<number>();
  const jobs: Array<Promise<void>> = [];
  for (const row of characterRows) {
    const characterId = Number(row.id);
    if (!Number.isInteger(characterId) || characterId <= 0 || requested.has(characterId)) continue;
    requested.add(characterId);
    if (hasCharacter(db, characterId)) continue;
    jobs.push(
      queue.add(async () => {
        const detail = await getJson<ApiCharacter>(context, `${base}/v0/characters/${characterId}`);
        if (detail) characterDetails.set(characterId, detail);
      })
    );
  }
  for (const musicId of new Set(musicIds)) {
    jobs.push(
      queue.add(async () => {
        musicDetails.set(
          musicId,
          await getJson<ApiSubject>(context, `${base}/v0/subjects/${musicId}`)
        );
      })
    );
  }
  // 任何一个失败都让整部作品失败；等其余任务落定，避免失败之后还有请求在占用额度。
  const settled = await Promise.allSettled(jobs);
  for (const item of settled) if (item.status === "rejected") throw item.reason;

  return { subject, characterRows, relationRows, characterDetails, musicDetails };
}

const hasCharacter = (db: Database, characterId: number): boolean =>
  db.query("SELECT 1 FROM characters WHERE id=?").get(characterId) !== null;

const heatOf = (subject: ApiSubject): number =>
  Object.values(subject.collection ?? {}).reduce<number>(
    (sum, value) => sum + Number(value ?? 0),
    0
  );

/** 写库阶段（在事务内同步执行）：作品、角色、关联一起落库；返回新写入的角色编号。 */
function writeBundle(db: Database, subjectId: number, bundle: SubjectBundle): number[] {
  const { subject } = bundle;
  const tags = subject.tags ?? [];
  const tagNames = tags.map((tag) => String(tag.name)).filter(Boolean);
  const rawTags = Object.fromEntries(
    tags.filter((tag) => tag.name).map((tag) => [String(tag.name), Number(tag.count ?? 0)])
  );
  const rating = subject.rating ?? {};
  const aliases = [String(subject.name_cn ?? "")].filter(Boolean);

  db.query("INSERT OR REPLACE INTO subjects VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    subjectId,
    Number(subject.type ?? 0),
    String(subject.name ?? ""),
    String(subject.name_cn ?? ""),
    JSON.stringify(aliases),
    infoboxToWikitext(subject.infobox),
    String(subject.summary ?? ""),
    String(subject.date ?? ""),
    0,
    JSON.stringify(tagNames),
    JSON.stringify(rawTags),
    JSON.stringify(subject.meta_tags ?? []),
    Number(rating.score ?? 0),
    Number(rating.total ?? 0),
    heatOf(subject),
    Number(rating.rank ?? 0),
    String((subject.images ?? {}).large ?? "")
  );

  const insertedCharacterIds = writeCharacters(db, subjectId, bundle);
  writeMusicRelations(db, subjectId, bundle);
  return insertedCharacterIds;
}

/** 角色：只补库中没有的，已有角色不动（它们的详情由各自的作品覆盖）。 */
function writeCharacters(db: Database, subjectId: number, bundle: SubjectBundle): number[] {
  const inserted: number[] = [];
  for (const [order, row] of bundle.characterRows.entries()) {
    const characterId = Number(row.id);
    if (!Number.isInteger(characterId) || characterId <= 0) continue;
    const detail = bundle.characterDetails.get(characterId);
    if (detail) {
      // 角色详情没有中文名字段，与构建脚本一样只能从 infobox 取。
      const nameCn = infoboxField(detail.infobox, ["简体中文名", "中文名"])[0] ?? "";
      const characterAliases = infoboxField(detail.infobox, ["别名"]);
      const comments = Number(detail.stat?.comments ?? 0);
      const collects = Number(detail.stat?.collects ?? 0);
      db.query("INSERT OR REPLACE INTO characters VALUES (?,?,?,?,?,?,?,?,?)").run(
        characterId,
        Number(detail.type ?? row.type ?? 0),
        String(detail.name ?? ""),
        nameCn,
        detail.gender === "male" || detail.gender === "female" ? detail.gender : "?",
        JSON.stringify(characterAliases),
        String(detail.summary ?? ""),
        comments,
        collects
      );
      inserted.push(characterId);
    } else if (!hasCharacter(db, characterId)) {
      // 上游已无此角色（404）且库里也没有：不建指向不存在角色的关联。
      continue;
    }
    db.query("INSERT OR IGNORE INTO character_subject_relations VALUES (?,?,?,?)").run(
      characterId,
      subjectId,
      CHARACTER_RELATIONS[String(row.relation ?? "")] ?? 0,
      order
    );
  }
  return inserted;
}

/** 关联作品：音乐条目要连曲目一起带出来（猜歌的出题素材）。 */
function writeMusicRelations(db: Database, subjectId: number, bundle: SubjectBundle): void {
  for (const [order, row] of bundle.relationRows.entries()) {
    if (Number(row.type) !== 3) continue;
    const relatedId = Number(row.id);
    const music = bundle.musicDetails.get(relatedId);
    const title = String(music?.name_cn || music?.name || "");
    if (!title) continue;
    db.query("INSERT OR IGNORE INTO subject_music_relations VALUES (?,?,?,?,?,?,?)").run(
      subjectId,
      relatedId,
      MUSIC_RELATIONS[String(row.relation ?? "")] ?? OTHER_MUSIC_RELATION,
      order,
      title,
      infoboxField(music?.infobox, ["艺术家", "歌手", "演唱"]).join("、") || null,
      "theme"
    );
  }
}

/**
 * 只有 404 算「条目不存在」。其余失败必须抛出：吞掉的话一次限流就会让角色列表变成空，
 * 作品被当成无角色裁掉，结果里还只记一条「跳过」。每个请求都带超时，挂起的连接卡不死整条任务。
 */
async function getJson<T>(context: FetchContext, url: string): Promise<T | null> {
  const response = await context.fetcher(url, {
    headers: { Accept: "application/json", "User-Agent": BANGUMI_USER_AGENT },
    signal: requestSignal(context),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`上游请求失败：HTTP ${response.status}`);
  return (await response.json()) as T;
}
