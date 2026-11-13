import type { Database } from "bun:sqlite";
import { isAppError } from "../domain/Errors";
import { bangumiImageCachePath } from "./BangumiImagePaths";
import { hasAvifMagic } from "./BangumiImageService";
import type { ImageStore } from "./BangumiImageStore";
import type { BangumiSearchIndex } from "./BangumiSearchIndex";
import { BangumiUpstream } from "./BangumiUpstream";

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

import { subjectColumnsFromApi, type ApiSubject } from "./BangumiApiTypes";
import { IndexQueue } from "./updater/IndexQueue";
import {
  DAY_MS,
  DEFAULT_REFRESH_TIERS,
  RefreshPlanner,
  type RefreshTier,
} from "./updater/RefreshPlanner";
import type { SubjectUpdaterLogger } from "./updater/UpdaterLogger";
import {
  readDatasetStatus,
  type BangumiDatasetStatus,
  type MaintenanceRun,
} from "./BangumiMirrorStatus";

/** 单轮刷新上限：一轮跑太久会让按需更新排不到。 */
const DEFAULT_ROUND_LIMIT = 1_000;
/** 错误摘要的长度上限：给后台看个大概，完整上下文在日志里。 */
const MAX_ERROR_SUMMARY = 200;
/** 两轮之间的间隔。 */
const DEFAULT_ROUND_DELAY_MS = 60_000;
/** 按需队列上限：异常流量下不能让内存无限涨。 */
const MANUAL_QUEUE_LIMIT = 512;
/** 命中 nsfw 的条目：数据集构建期就是剔除 nsfw 的，上游翻脸时至少别再碰它。 */
const NSFW_RETRY_MS = 30 * DAY_MS;
/** 单次回源超时。 */
const UPSTREAM_TIMEOUT_MS = 8_000;

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
  images?: ImageStore;
  tiers?: RefreshTier[];
  roundLimit?: number;
  roundDelayMs?: number;
  fetcher?: typeof fetch;
  /** 已构造好的上游出站部件；注入后不再按 `fetcher` 另建，让各处出站共用冷却与限速时隙。 */
  upstream?: BangumiUpstream;
  logger?: SubjectUpdaterLogger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** 循环自身的状态：只含内存里的量，后台状态页跨线程读。 */
export interface UpdaterRuntimeStatus {
  running: boolean;
  paused: boolean;
  rate: number;
  players: number;
  startedAt: number | null;
  lastRound: { at: number; refreshed: number; error: string | null } | null;
}

/** 摘要会展示给管理员：抹掉上游地址与本机路径，排障细节留在日志里。 */
const redactError = (message: string): string =>
  message
    .replace(/https?:\/\/\S+|(?:[A-Za-z]:)?[\\/][^\s：]+/g, "<已隐藏>")
    .slice(0, MAX_ERROR_SUMMARY);

export class SubjectUpdater {
  private readonly db: Database;
  private readonly base: string;
  private readonly search?: BangumiSearchIndex;
  private readonly images?: ImageStore;
  private readonly imageSource: string;
  private readonly minRate: number;
  private readonly maxRate: number;
  private readonly playerScale: number;
  private readonly planner: RefreshPlanner;
  private readonly indexQueue: IndexQueue;
  private readonly roundLimit: number;
  private readonly roundDelayMs: number;
  private readonly upstream: BangumiUpstream;
  private readonly logger?: SubjectUpdaterLogger;
  private readonly now: () => number;

  private players = 0;
  private running = false;
  private paused = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** 玩家看过的条目：下一轮优先刷新。 */
  private readonly manual = new Set<number>();
  private lastRound: { at: number; refreshed: number; error: string | null } | undefined;
  private startedAt: number | null = null;

  constructor(options: SubjectUpdaterOptions) {
    this.db = options.db;
    this.base = options.base.replace(/\/+$/, "");
    this.search = options.search;
    this.images = options.images;
    this.imageSource = (options.imageSource ?? "").replace(/\/+$/, "");
    this.minRate = Math.max(1, options.minRate ?? 10);
    this.maxRate = Math.max(this.minRate, options.maxRate ?? 100);
    this.playerScale = options.playerScale ?? 20;
    this.roundLimit = options.roundLimit ?? DEFAULT_ROUND_LIMIT;
    this.roundDelayMs = options.roundDelayMs ?? DEFAULT_ROUND_DELAY_MS;
    this.upstream =
      options.upstream ??
      new BangumiUpstream({
        fetcher: options.fetcher,
        now: options.now,
        sleep: options.sleep,
        rate: () => this.rate,
      });
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.planner = new RefreshPlanner(
      this.db,
      this.now,
      options.tiers ?? DEFAULT_REFRESH_TIERS,
      this.roundLimit
    );
    this.indexQueue = new IndexQueue(this.db, this.search, this.logger);
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
      CREATE TABLE IF NOT EXISTS bangumi_maintenance_runs (
        task TEXT PRIMARY KEY,
        finished_at INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        summary TEXT NOT NULL,
        error TEXT
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
    this.startedAt = this.now();
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, delay);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    // 暂停期间保持 1s 心跳：备份一结束就能立刻接着跑，不用等满一轮。
    if (this.paused) {
      this.schedule(1_000);
      return;
    }
    try {
      const refreshed = await this.runRound();
      this.lastRound = { at: this.now(), refreshed, error: null };
      if (refreshed)
        this.logger?.info?.(`作品刷新：本轮 ${refreshed} 条（速率 ${this.rate.toFixed(1)} req/s）`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastRound = { at: this.now(), refreshed: 0, error: redactError(message) };
      this.logger?.warn?.(`作品刷新轮次失败：${message}`);
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
    for (const item of this.planner.selectDue()) {
      if (this.paused) break;
      if (await this.refresh(Number(item.id), item.tier)) refreshed += 1;
    }
    const manual = [...this.manual];
    this.manual.clear();
    for (const subjectId of manual) {
      if (this.paused) break;
      // 按需只对「确实过期」的条目发请求：玩家翻目录会连续点开一批作品，
      // 不做这道闸门的话，热门条目会被重复刷新，白耗上游配额。
      if (!this.planner.isStale(subjectId)) continue;
      if (await this.refresh(subjectId)) refreshed += 1;
    }
    await this.flushIndex();
    return refreshed;
  }


  /** 把库里现有作品登记为「此刻已刷新」，细则见刷新计划。 */
  markDatasetFresh(): number {
    return this.planner.markDatasetFresh();
  }

  /** 把待同步队列里的条目批量写进索引。 */
  flushIndex(limit = DEFAULT_ROUND_LIMIT): Promise<number> {
    return this.indexQueue.flush(limit);
  }

  /** 玩家请求触发的按需更新：只登记，真正的请求排在下一轮（异步、不挡查询）。 */
  requestRefresh(subjectId: number): void {
    if (!Number.isInteger(subjectId) || subjectId <= 0) return;
    if (this.manual.size >= MANUAL_QUEUE_LIMIT) return;
    this.manual.add(subjectId);
  }




  /** 刷新单个作品：拉详情 → 覆盖落库 → 入索引待同步队列。返回是否成功。 */
  async refresh(subjectId: number, tier = 0): Promise<boolean> {
    if (!Number.isInteger(subjectId) || subjectId <= 0) return false;
    const now = this.now();
    let ok = false;
    try {
      const response = await this.upstream.fetch(`${this.base}/v0/subjects/${subjectId}`, {
        headers: { Accept: "application/json" },
        timeoutMs: UPSTREAM_TIMEOUT_MS,
        priority: "background",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const subject = (await response.json()) as ApiSubject;
      // nsfw 守卫：数据集构建期就剔除了 nsfw 条目，上游一旦把某条翻成 nsfw，
      // 这里绝不把它写进来 —— 只记状态、长期不再尝试。
      if (subject.nsfw) {
        this.logger?.warn?.(`作品 ${subjectId} 上游标记 nsfw，跳过本次更新`);
        this.planner.markFailed(subjectId, tier, 0, now + NSFW_RETRY_MS);
        return false;
      }
      ok = this.applySubject(subjectId, subject, now);
      if (ok) await this.ensureImage(String(subject.images?.large ?? ""));
    } catch (error) {
      // 上游限流是全局状态，不是这个条目的错：不记失败、不推退避，条目留在到期集合里下轮再来。
      if (isAppError(error) && error.code === "BANGUMI_RATE_LIMITED") {
        this.logger?.info?.(`作品 ${subjectId} 因上游限流本次未刷新`);
        return false;
      }
      this.logger?.warn?.(
        `作品 ${subjectId} 刷新失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (ok) this.planner.markRefreshed(subjectId, now, tier);
    else {
      const failures = this.planner.failuresOf(subjectId) + 1;
      this.planner.markFailed(subjectId, tier, failures, now + this.planner.backoffFor(failures));
    }
    return ok;
  }

  /** 覆盖式更新：上游是权威，除了类型与 nsfw（数据集的裁剪依据）之外全量覆盖。 */
  private applySubject(subjectId: number, subject: ApiSubject, now: number): boolean {
    const columns = subjectColumnsFromApi(subject);

    // 上游没给的字段保持原值：匿名接口偶尔缺 collection / images，拿 0 或空串覆盖
    // 会把一条热门作品的封面和热度抹掉 —— 比不更新更糟。
    const current = this.db
      .query<{ heat: number; image: string }, [number]>(
        "SELECT heat, image FROM subjects WHERE id = ?"
      )
      .get(subjectId);
    const result = this.db
      .query<
        never,
        [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          number,
          number,
          number,
          number,
          string,
          number,
        ]
      >(
        "UPDATE subjects SET name=?, name_cn=?, infobox=?, summary=?, date=?, tags=?, raw_tags=?, meta_tags=?," +
          " score=?, rating_count=?, heat=?, rank=?, image=? WHERE id=?"
      )
      .run(
        columns.name,
        columns.nameCn,
        columns.infobox,
        columns.summary,
        columns.date,
        JSON.stringify(columns.tagNames),
        JSON.stringify(columns.rawTags),
        JSON.stringify(columns.metaTags),
        columns.score,
        columns.ratingCount,
        columns.heat || Number(current?.heat ?? 0),
        columns.rank,
        columns.image || String(current?.image ?? ""),
        subjectId
      );
    // 更新 0 行 = 库里没有这个条目（被裁剪或已删除）：不算失败，但也不必排队索引。
    if (!result.changes) return true;
    this.indexQueue.enqueue(subjectId, now);
    return true;
  }

  /** 缺图才下载：只在「有图床、有上游、且这张图还没缓存」时发一次请求。 */
  private async ensureImage(raw: string): Promise<void> {
    if (!raw || !this.images || !this.imageSource) return;
    const path = bangumiImageCachePath(raw);
    if (!path || this.images.has(path)) return;
    try {
      const response = await this.upstream.fetch(`${this.imageSource}${path}`, {
        headers: { Accept: "image/avif" },
        timeoutMs: UPSTREAM_TIMEOUT_MS,
        priority: "background",
      });
      if (!response.ok) return;
      const bytes = new Uint8Array(await response.arrayBuffer());
      // 只认 avif：上游异常时不要把 jpeg / 错误页写进图床（坏字节入库就不会再重下）。
      if (!hasAvifMagic(bytes)) return;
      await this.images.put(path, bytes, "image/avif");
    } catch (error) {
      // 缺一张图不是可用性问题：下轮刷新会再试。但要留一笔：R2 通道断了在这条路径上否则完全不可见。
      this.logger?.warn?.(
        `封面写入图床失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }






  /**
   * 记下维护任务的结果。存进数据集而不是内存：每日任务只在固定时刻跑，部署重启后
   * 内存里的结果就没了，后台会一直显示「从未运行」。留痕失败不影响任务本身。
   */
  recordMaintenanceRun(run: Omit<MaintenanceRun, "finishedAt">): void {
    try {
      this.db
        .query<never, [string, number, number, string, string | null]>(
          "INSERT INTO bangumi_maintenance_runs (task, finished_at, ok, summary, error) VALUES (?,?,?,?,?)" +
            " ON CONFLICT(task) DO UPDATE SET finished_at = excluded.finished_at, ok = excluded.ok," +
            " summary = excluded.summary, error = excluded.error"
        )
        .run(
          run.task,
          this.now(),
          run.ok ? 1 : 0,
          run.summary,
          run.error === null ? null : redactError(run.error)
        );
    } catch (error) {
      this.logger?.warn?.(
        `维护结果留痕失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /** 循环自身的状态，给后台状态页。 */
  runtime(): UpdaterRuntimeStatus {
    return {
      running: this.running,
      paused: this.paused,
      rate: this.rate,
      players: this.players,
      startedAt: this.startedAt,
      lastRound: this.lastRound ?? null,
    };
  }

  /** 运维视角的快照：排障时最想知道的就是「现在跑多快、有没有停」。 */
  stats(): UpdaterRuntimeStatus & BangumiDatasetStatus {
    return { ...this.runtime(), ...readDatasetStatus(this.db, this.now()) };
  }
}
