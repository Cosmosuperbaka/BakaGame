import type { Database } from "bun:sqlite";
import { bangumiImageCachePath } from "./BangumiImagePaths";
import { hasAvifMagic } from "./BangumiImageService";
import type { BangumiImageStore } from "./BangumiImageStore";
import type { BangumiSearchIndex } from "./BangumiSearchIndex";

/**
 * 作品在线更新器：让数据集自己保持新鲜，不再依赖「下次构建」。
 *
 * 数据集从 CI 周更的只读产物改成**后端自己更新的可写库**之后，必须有人负责
 * 把上游的变化搬进来，否则评分、热度、标签永远停在构建那一刻。更新量与节奏
 * 由两件事决定：
 *
 * - **三层**：按热度排名分位划分刷新间隔（热 2 天 / 温 7 天 / 冷 30 天）。
 *   分位**每轮按当前热度分布重算**，所以作品变热会自动被刷得更勤，凉了就自动
 *   减少打扰 —— 这就是「智能调整数量」。
 * - **按玩家数限速**：没人玩的时候只跑 10 req/s（字面意义上的慢慢更新），
 *   在线玩家越多跑得越快，到 20 人封顶 100 req/s。上游是公益性质的 Bangumi
 *   API，玩家的请求永远优先，后台更新只吃空闲带宽。
 *
 * 整套逻辑跑在数据 Worker 里：SQLite 的写、图床的写都收口在单一线程，
 * 不需要额外的锁或队列（见 BangumiDataWorker 的注释）。
 */

const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
/** 失败退避上限：连续失败也别把条目永久钉死，一周后总得再试一次。 */
const MAX_BACKOFF_MS = 7 * DAY_MS;
/** 索引待同步的失败次数上限：超过就丢弃（下一轮刷新会重新入队）。 */
const MAX_INDEX_ATTEMPTS = 5;
/** 单轮刷新上限：一轮跑太久会让按需更新排不到。 */
const DEFAULT_ROUND_LIMIT = 1_000;
/** 两轮之间的间隔。 */
const DEFAULT_ROUND_DELAY_MS = 60_000;
/** 按需队列上限：异常流量下不能让内存无限涨。 */
const MANUAL_QUEUE_LIMIT = 512;
/** 命中 nsfw 的条目：数据集构建期就是剔除 nsfw 的，上游翻脸时至少别再碰它。 */
const NSFW_RETRY_MS = 30 * DAY_MS;
/** 单次回源超时。 */
const UPSTREAM_TIMEOUT_MS = 8_000;

/** 一层刷新策略：`coverage` 是热度排名前多少比例（按 heat 降序）。 */
export interface RefreshTier {
  coverage: number;
  intervalDays: number;
}

/** 默认三层：前 20% 两天一次，前 50% 一周一次，其余一个月一次。 */
export const DEFAULT_REFRESH_TIERS: RefreshTier[] = [
  { coverage: 0.2, intervalDays: 2 },
  { coverage: 0.5, intervalDays: 7 },
  { coverage: 1, intervalDays: 30 },
];

export interface SubjectUpdaterLogger {
  warn?: (message: string) => void;
  info?: (message: string) => void;
}

/** 可跨线程传递的更新器参数（只含可结构化克隆的值）。 */
export interface SubjectUpdaterInit {
  base: string;
  imageSource?: string;
  minRate?: number;
  maxRate?: number;
  playerScale?: number;
}

export interface SubjectUpdaterOptions extends SubjectUpdaterInit {
  /** 数据集连接（Worker 内可写）。 */
  db: Database;
  search?: BangumiSearchIndex;
  /** 图床分片（Worker 侧可写实例）：刷新时顺手把缺的封面补上。 */
  images?: BangumiImageStore;
  tiers?: RefreshTier[];
  roundLimit?: number;
  roundDelayMs?: number;
  fetcher?: typeof fetch;
  logger?: SubjectUpdaterLogger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** `/v0/subjects/{id}` 里更新器用得到的字段。 */
interface ApiSubject {
  name?: string;
  name_cn?: string;
  date?: string;
  infobox?: string;
  summary?: string;
  nsfw?: boolean;
  tags?: Array<{ name?: string; count?: number }>;
  meta_tags?: string[];
  images?: { large?: string };
  rating?: { score?: number; total?: number; rank?: number };
  collection?: Record<string, number>;
}

interface DueRow {
  id: number | string;
  heat: number | null;
  refreshed_at: number | null;
  next_at: number | null;
}

/** 从 API 响应取热度：收藏分布各桶求和，与全量构建脚本同一口径。 */
const heatOf = (subject: ApiSubject): number =>
  Object.values(subject.collection ?? {}).reduce<number>((sum, value) => sum + Number(value ?? 0), 0);

const toDateNumber = (value: string): number => Number(String(value ?? "").replace(/-/g, "")) || 0;

export class SubjectUpdater {
  private readonly db: Database;
  private readonly base: string;
  private readonly search?: BangumiSearchIndex;
  private readonly images?: BangumiImageStore;
  private readonly imageSource: string;
  private readonly minRate: number;
  private readonly maxRate: number;
  private readonly playerScale: number;
  private readonly tiers: RefreshTier[];
  private readonly roundLimit: number;
  private readonly roundDelayMs: number;
  private readonly fetcher: typeof fetch;
  private readonly logger?: SubjectUpdaterLogger;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private players = 0;
  private running = false;
  private paused = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** 下一次请求的最早时刻：限速靠它排队，比滑动窗口更适合「匀速慢跑」。 */
  private nextSlotAt = 0;
  /** 玩家看过的条目：下一轮优先刷新。 */
  private readonly manual = new Set<number>();

  constructor(options: SubjectUpdaterOptions) {
    this.db = options.db;
    this.base = options.base.replace(/\/+$/, "");
    this.search = options.search;
    this.images = options.images;
    this.imageSource = (options.imageSource ?? "").replace(/\/+$/, "");
    this.minRate = Math.max(1, options.minRate ?? 10);
    this.maxRate = Math.max(this.minRate, options.maxRate ?? 100);
    this.playerScale = options.playerScale ?? 20;
    this.tiers = options.tiers ?? DEFAULT_REFRESH_TIERS;
    this.roundLimit = options.roundLimit ?? DEFAULT_ROUND_LIMIT;
    this.roundDelayMs = options.roundDelayMs ?? DEFAULT_ROUND_DELAY_MS;
    this.fetcher = options.fetcher ?? fetch;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
    this.ensureSchema();
  }

  /**
   * 状态表建在数据集里：状态必须与它描述的数据同生共死，独立文件会在
   * 换库（重新构建、回滚备份）后指向一批已经不存在的条目。
   */
  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bangumi_refresh (
        subject_id INTEGER PRIMARY KEY,
        tier INTEGER NOT NULL,
        refreshed_at INTEGER NOT NULL,
        failures INTEGER NOT NULL,
        next_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bangumi_index_pending (
        subject_id INTEGER PRIMARY KEY,
        queued_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL
      );
    `);
  }

  /** 当前速率（req/s）：没人玩跑最慢，玩家越多越快，到 `playerScale` 封顶。 */
  get rate(): number {
    if (this.playerScale <= 0) return this.maxRate;
    const ratio = Math.min(1, Math.max(0, this.players / this.playerScale));
    return this.minRate + (this.maxRate - this.minRate) * ratio;
  }

  /** 上报在线玩家数：更新器据此调整速率。 */
  reportLoad(players: number): void {
    this.players = Number.isFinite(players) ? Math.max(0, Math.floor(players)) : 0;
  }

  /** 备份期间暂停写库：VACUUM INTO 与持续写入互相拖累，先让备份跑完。 */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => { void this.tick(); }, delay);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    // 暂停期间保持 1s 心跳：备份一结束就能立刻接着跑，不用等满一轮。
    if (this.paused) { this.schedule(1_000); return; }
    try {
      const refreshed = await this.runRound();
      if (refreshed) this.logger?.info?.(`作品刷新：本轮 ${refreshed} 条（速率 ${this.rate.toFixed(1)} req/s）`);
    } catch (error) {
      this.logger?.warn?.(`作品刷新轮次失败：${error instanceof Error ? error.message : String(error)}`);
    }
    this.schedule(this.roundDelayMs);
  }

  /**
   * 跑一轮：先按三层挑出到期的条目，再补玩家刚看过的条目，最后统一 flush 索引。
   * 返回本轮成功刷新的条数。
   *
   * 只认 `paused`（备份期间）：`running` 是循环开关，由 `tick` 负责 ——
   * 否则「跑一轮」这个动作在没 `start()` 时会被静默吃掉，测试与按需调用都没法用。
   */
  async runRound(): Promise<number> {
    let refreshed = 0;
    for (const item of this.selectDue()) {
      if (this.paused) break;
      if (await this.refresh(Number(item.id), item.tier)) refreshed += 1;
    }
    const manual = [...this.manual];
    this.manual.clear();
    for (const subjectId of manual) {
      if (this.paused) break;
      // 按需只对「确实过期」的条目发请求：玩家翻目录会连续点开一批作品，
      // 不做这道闸门的话，热门条目会被重复刷新，白耗上游配额。
      if (!this.isStale(subjectId)) continue;
      if (await this.refresh(subjectId)) refreshed += 1;
      await this.waitForSlot();
    }
    await this.flushIndex();
    return refreshed;
  }

  /**
   * 把库里现有作品登记为「此刻已刷新」（只补没有记录的条目）。
   *
   * 不登记的话，部署首轮会把三万多条全部当成「从未刷新」，于是一上线就把全库刷一遍
   * —— 可这些数据是刚随构建产物流下来的，本来就是新鲜的。登记之后三层节奏从部署
   * 时刻起算，真正的首次刷新落在 2 / 7 / 30 天之后。
   */
  markDatasetFresh(): number {
    const result = this.db.query<never, [number]>(
      "INSERT OR IGNORE INTO bangumi_refresh (subject_id, tier, refreshed_at, failures, next_at)"
      + " SELECT id, -1, ?, 0, 0 FROM subjects",
    ).run(this.now());
    return result.changes;
  }

  /** 玩家请求触发的按需更新：只登记，真正的请求排在下一轮（异步、不挡查询）。 */
  requestRefresh(subjectId: number): void {
    if (!Number.isInteger(subjectId) || subjectId <= 0) return;
    if (this.manual.size >= MANUAL_QUEUE_LIMIT) return;
    this.manual.add(subjectId);
  }

  /**
   * 挑出本轮到期的条目。
   *
   * 到期判定有两条且必须同时满足：
   * - **新鲜度**：`now - refreshed_at >= 该层间隔`（分位本轮重算，所以同一条
   *   作品变热后会提前到期、变冷后会被推迟）。
   * - **退避**：`now >= next_at`（连续失败的条目按指数退避往后压）。
   */
  private selectDue(): Array<{ id: number | string; tier: number }> {
    const rows = this.db.query<DueRow, []>(
      "SELECT s.id AS id, s.heat AS heat, r.refreshed_at AS refreshed_at, r.next_at AS next_at"
      + " FROM subjects s LEFT JOIN bangumi_refresh r ON r.subject_id = s.id"
      + " ORDER BY s.heat DESC, s.id ASC",
    ).all();
    const total = Math.max(1, rows.length);
    const now = this.now();
    const due: Array<{ id: number | string; tier: number }> = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const tier = this.tierAt(index / total);
      const intervalMs = (this.tiers[tier]?.intervalDays ?? 30) * DAY_MS;
      const stale = row.refreshed_at === null || now - row.refreshed_at >= intervalMs;
      const allowed = row.next_at === null || now >= row.next_at;
      if (stale && allowed) due.push({ id: row.id, tier });
      if (due.length >= this.roundLimit) break;
    }
    return due;
  }

  /** 热度排名（0 = 最热）落在哪一层。 */
  private tierAt(ratio: number): number {
    for (let index = 0; index < this.tiers.length; index += 1) {
      if (ratio < (this.tiers[index]?.coverage ?? 1)) return index;
    }
    return Math.max(0, this.tiers.length - 1);
  }

  /** 是否过期到值得为一次玩家请求回源（口径取最热的那一层间隔）。 */
  private isStale(subjectId: number): boolean {
    const row = this.db.query<{ refreshed_at: number }, [number]>(
      "SELECT refreshed_at FROM bangumi_refresh WHERE subject_id = ?",
    ).get(subjectId);
    if (!row) return true;
    const shortest = Math.min(...this.tiers.map((tier) => tier.intervalDays));
    return this.now() - row.refreshed_at >= shortest * DAY_MS;
  }

  /** 刷新单个作品：拉详情 → 覆盖落库 → 入索引待同步队列。返回是否成功。 */
  async refresh(subjectId: number, tier = 0): Promise<boolean> {
    if (!Number.isInteger(subjectId) || subjectId <= 0) return false;
    await this.waitForSlot();
    const now = this.now();
    let ok = false;
    try {
      const response = await this.fetcher(`${this.base}/v0/subjects/${subjectId}`, {
        headers: { Accept: "application/json", "User-Agent": "BakaGame/1.0" },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const subject = await response.json() as ApiSubject;
      // nsfw 守卫：数据集构建期就剔除了 nsfw 条目，上游一旦把某条翻成 nsfw，
      // 这里绝不把它写进来 —— 只记状态、长期不再尝试。
      if (subject.nsfw) {
        this.logger?.warn?.(`作品 ${subjectId} 上游标记 nsfw，跳过本次更新`);
        this.mark(subjectId, now, tier, 0, now + NSFW_RETRY_MS);
        return false;
      }
      ok = this.applySubject(subjectId, subject, now);
      if (ok) await this.ensureImage(String(subject.images?.large ?? ""));
    } catch (error) {
      this.logger?.warn?.(`作品 ${subjectId} 刷新失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const failures = ok ? 0 : this.failuresOf(subjectId) + 1;
    this.mark(subjectId, now, tier, failures, ok ? now : now + this.backoffFor(failures));
    return ok;
  }

  /** 覆盖式更新：上游是权威，除了类型与 nsfw（数据集的裁剪依据）之外全量覆盖。 */
  private applySubject(subjectId: number, subject: ApiSubject, now: number): boolean {
    const tags = Array.isArray(subject.tags) ? subject.tags : [];
    const tagNames = tags.map((tag) => String(tag.name ?? "")).filter(Boolean);
    const rawTags = Object.fromEntries(tags.filter((tag) => tag.name).map((tag) => [String(tag.name), Number(tag.count ?? 0)]));
    const rating = subject.rating ?? {};
    const image = String(subject.images?.large ?? "");
    const heat = heatOf(subject);

    // 上游没给的字段保持原值：匿名接口偶尔缺 collection / images，拿 0 或空串覆盖
    // 会把一条热门作品的封面和热度抹掉 —— 比不更新更糟。
    const current = this.db.query<{ heat: number; image: string }, [number]>("SELECT heat, image FROM subjects WHERE id = ?").get(subjectId);
    const result = this.db.query<never, [string, string, string, string, string, string, string, string, number, number, number, number, string, number]>(
      "UPDATE subjects SET name=?, name_cn=?, infobox=?, summary=?, date=?, tags=?, raw_tags=?, meta_tags=?,"
      + " score=?, rating_count=?, heat=?, rank=?, image=? WHERE id=?",
    ).run(
      String(subject.name ?? ""), String(subject.name_cn ?? ""), String(subject.infobox ?? ""),
      String(subject.summary ?? ""), String(subject.date ?? ""), JSON.stringify(tagNames),
      JSON.stringify(rawTags), JSON.stringify(subject.meta_tags ?? []),
      Number(rating.score ?? 0), Number(rating.total ?? 0),
      heat || Number(current?.heat ?? 0), Number(rating.rank ?? 0),
      image || String(current?.image ?? ""), subjectId,
    );
    // 更新 0 行 = 库里没有这个条目（被裁剪或已删除）：不算失败，但也不必排队索引。
    if (!result.changes) return true;
    if (this.search) {
      this.db.query<never, [number, number]>(
        "INSERT INTO bangumi_index_pending (subject_id, queued_at, attempts) VALUES (?,?,0)"
        + " ON CONFLICT(subject_id) DO UPDATE SET queued_at = excluded.queued_at",
      ).run(subjectId, now);
    }
    return true;
  }

  /** 缺图才下载：只在「有图床、有上游、且这张图还没缓存」时发一次请求。 */
  private async ensureImage(raw: string): Promise<void> {
    if (!raw || !this.images || !this.imageSource) return;
    const path = bangumiImageCachePath(raw);
    if (!path || this.images.has(path)) return;
    await this.waitForSlot();
    try {
      const response = await this.fetcher(`${this.imageSource}${path}`, {
        headers: { Accept: "image/avif", "User-Agent": "BakaGame/1.0" },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!response.ok) return;
      const bytes = new Uint8Array(await response.arrayBuffer());
      // 只认 avif：上游异常时不要把 jpeg / 错误页写进图床（坏字节入库就不会再重下）。
      if (!hasAvifMagic(bytes)) return;
      this.images.put(path, bytes, "image/avif");
    } catch {
      // 缺一张图不是可用性问题：下轮刷新会再试。
    }
  }

  /** 把待同步队列里的条目批量写进索引；失败计数，超过上限就丢弃。 */
  async flushIndex(limit = DEFAULT_ROUND_LIMIT): Promise<number> {
    const pending = this.db.query<{ subject_id: number; attempts: number }, [number]>(
      "SELECT subject_id, attempts FROM bangumi_index_pending ORDER BY queued_at ASC LIMIT ?",
    ).all(limit);
    if (!pending.length) return 0;
    // 没有配置索引时队列根本不该存在（入队处已挡），这里只兜底清理。
    if (!this.search) {
      this.db.exec("DELETE FROM bangumi_index_pending");
      return 0;
    }
    const ids = pending.map((row) => Number(row.subject_id));
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.query(
      `SELECT id,name,name_cn,aliases,tags,meta_tags,date,score,rating_count,heat,rank,type FROM subjects WHERE id IN (${placeholders})`,
    ).all(...ids) as Array<Record<string, unknown>>;
    try {
      await this.search.updateSubjects(rows.map((row) => this.search!.toSubjectDocument(row)));
      // 队列里的条目若已被裁掉（上游删了 / 被剔除），这里一并清掉：留着只会每轮重试。
      for (const id of ids) this.db.query("DELETE FROM bangumi_index_pending WHERE subject_id = ?").run(id);
      return rows.length;
    } catch (error) {
      this.logger?.warn?.(`索引同步失败：${error instanceof Error ? error.message : String(error)}`);
      for (const row of pending) {
        const attempts = Number(row.attempts) + 1;
        if (attempts >= MAX_INDEX_ATTEMPTS) {
          this.db.query("DELETE FROM bangumi_index_pending WHERE subject_id = ?").run(Number(row.subject_id));
          continue;
        }
        this.db.query("UPDATE bangumi_index_pending SET attempts = ? WHERE subject_id = ?").run(attempts, Number(row.subject_id));
      }
      return 0;
    }
  }

  private failuresOf(subjectId: number): number {
    const row = this.db.query<{ failures: number }, [number]>("SELECT failures FROM bangumi_refresh WHERE subject_id = ?").get(subjectId);
    return Number(row?.failures ?? 0);
  }

  /** 连续失败的指数退避：1h → 2h → 4h … 封顶一周。 */
  private backoffFor(failures: number): number {
    return Math.min(MAX_BACKOFF_MS, HOUR_MS * 2 ** Math.max(0, failures - 1));
  }

  /** 记录一次尝试的结果（成功清零失败计数，失败则退避）。 */
  private mark(subjectId: number, now: number, tier: number, failures: number, nextAt: number): void {
    this.db.query<never, [number, number, number, number, number]>(
      "INSERT INTO bangumi_refresh (subject_id, tier, refreshed_at, failures, next_at) VALUES (?,?,?,?,?)"
      + " ON CONFLICT(subject_id) DO UPDATE SET tier = excluded.tier, refreshed_at = excluded.refreshed_at,"
      + " failures = excluded.failures, next_at = excluded.next_at",
    ).run(subjectId, tier, now, failures, nextAt);
  }

  /** 等到一个属于自己的请求时隙：限速就靠这一个点，所有回源都得先过它。 */
  private async waitForSlot(): Promise<void> {
    const gap = 1_000 / this.rate;
    const now = this.now();
    const slot = Math.max(this.nextSlotAt, now);
    this.nextSlotAt = slot + gap;
    const wait = slot - now;
    if (wait > 0) await this.sleep(wait);
  }

  /** 运维视角的快照：排障时最想知道的就是「现在跑多快、有没有停」。 */
  stats(): { running: boolean; paused: boolean; rate: number; players: number; refreshed: number; pendingIndex: number } {
    const refreshed = Number((this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM bangumi_refresh").get())?.n ?? 0);
    const pendingIndex = Number((this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM bangumi_index_pending").get())?.n ?? 0);
    return { running: this.running, paused: this.paused, rate: this.rate, players: this.players, refreshed, pendingIndex };
  }
}
