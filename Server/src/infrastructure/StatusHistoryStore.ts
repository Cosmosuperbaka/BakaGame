import { and, eq, gte, sql } from "drizzle-orm";
import { beijingDay } from "../domain/BeijingDay";
import {
  PUBLIC_STATUS_COMPONENT_IDS,
  PUBLIC_STATUS_HISTORY_DAYS,
  PUBLIC_STATUS_UPTIME_DAYS,
  type PublicStatusCell,
  type PublicStatusComponentId,
  type PublicStatusHistory,
  type PublicStatusHistoryEntry,
  type PublicStatusSnapshot,
  type PublicStatusUptime,
} from "../shared/Status";
import type { Database } from "./db/Database";
import {
  addSample,
  cellFigures,
  emptyCount,
  latencyOf,
  ratioOf,
  sumCounts,
  type StatusCount,
} from "./StatusCounts";
import { statusDaily } from "./db/Schema";

/** 日格与窗口可用率都只由计数派生，算法见 StatusCounts。 */
const toCell = (day: string, count: StatusCount): PublicStatusCell => ({
  day,
  ...cellFigures(count),
});

const windowRatio = (counts: StatusCount[], days: number): PublicStatusUptime => ({
  days,
  ratio: ratioOf(counts.slice(-days)),
});

export interface StatusHistoryStoreOptions {
  /** 本进程的部署环境标记：开发与生产共用一个库时，账本按它分行。 */
  environment: string;
  /** 未配置数据库时省略：计数只留在内存里，重启即丢，页面仍能出当前状态与本次运行的条带。 */
  database?: Database;
  now?: () => number;
  /** 保留天数，默认取页面展示的最大窗口。 */
  retentionDays?: number;
}

/**
 * 公开状态页的历史账本。
 *
 * 30 天 × 10 个组件最多 300 条计数，整份放在内存里读，页面与 WS 每次取历史都不碰数据库；
 * 落库只发生在定时 flush 与停机前，写的是「当日累计」的绝对值而不是增量——
 * 本进程是这张表在所属环境下的唯一写入方，所以只要先把库里的旧账读回来并与内存求和，
 * 绝对值就不会重复计数；读回之前不写，否则会把旧账整格覆盖。
 *
 * 没有探测就不写行：「那一天没有数据」由缺行表达，页面读作无数据，而不是拿 0% 冒充全挂。
 */
export class StatusHistoryStore {
  private readonly environment: string;
  private readonly database?: Database;
  private readonly now: () => number;
  private readonly retentionDays: number;
  /** componentId → 北京时间自然日 → 计数。 */
  private readonly days = new Map<PublicStatusComponentId, Map<string, StatusCount>>();
  private readonly dirty = new Set<string>();
  private loading: Promise<void> | undefined;
  private loaded = false;
  private loadFailed = false;

  constructor(options: StatusHistoryStoreOptions) {
    this.environment = options.environment;
    this.database = options.database;
    this.now = options.now ?? Date.now;
    this.retentionDays = options.retentionDays ?? PUBLIC_STATUS_HISTORY_DAYS;
    for (const id of PUBLIC_STATUS_COMPONENT_IDS) this.days.set(id, new Map());
  }

  /**
   * 启动时把窗口内的既有账读回来。失败原样抛给调用方告警：读不到历史只意味着条带为空，
   * 不影响服务启动，但必须留下信号——吞掉就会把「账本坏了」读成「历史本来就是空的」。
   *
   * 读回来的行与加载期间已经记下的样本**求和**，不是覆盖：采样器不等它，启动几秒内的样本
   * 会先进内存，覆盖就把它们丢了。并发与重复调用共用同一次读取，成功后不再重复累加。
   */
  async load(): Promise<void> {
    if (!this.database || this.loaded) return;
    this.loading ??= this.readLedger()
      .then(() => {
        this.loaded = true;
        this.loadFailed = false;
      })
      .catch((error: unknown) => {
        this.loadFailed = true;
        throw error;
      })
      .finally(() => {
        this.loading = undefined;
      });
    await this.loading;
  }

  private async readLedger(): Promise<void> {
    const database = this.database!;
    const cutoff = beijingDay(this.now() - (this.retentionDays - 1) * 86_400_000);
    await database.ready;
    const rows = await database.db
      .select()
      .from(statusDaily)
      .where(and(eq(statusDaily.environment, this.environment), gte(statusDaily.day, cutoff)));
    for (const row of rows) {
      const bucket = this.days.get(row.componentId as PublicStatusComponentId);
      if (!bucket) continue;
      const stored: StatusCount = {
        total: row.total,
        operational: row.operational,
        degraded: row.degraded,
        unknown: row.unknown,
        latencySum: row.latencySum,
        latencyCount: row.latencyCount,
      };
      const current = bucket.get(row.day);
      bucket.set(row.day, current ? sumCounts(current, stored) : stored);
    }
    this.prune(cutoff);
  }

  /**
   * 一次快照记一笔账。内部组件探测失败已经记成 degraded，unknown 只表示「没有结论」
   * （未接入监测或监测本身取不到）：它仍计数进 total，但不进可用率分母——
   * 既不把「没接入」压成 0%，也不把真故障抬高。
   */
  record(snapshot: PublicStatusSnapshot): void {
    const day = beijingDay(snapshot.observedAt || this.now());
    for (const component of snapshot.components) {
      const bucket = this.days.get(component.id);
      if (!bucket) continue;
      const count = bucket.get(day) ?? emptyCount();
      addSample(count, component.level, component.latencyMs);
      bucket.set(day, count);
      this.dirty.add(`${component.id}|${day}`);
    }
  }

  /**
   * 把当日累计写回库；没有数据库或没有新账时直接返回。
   * 写失败时把这批键放回待写集合再抛出：下一轮 flush 带着仍在内存里的账重试，
   * 不会因为当天之后再无新样本（例如跨过零点的前一天）而永久丢掉那一格。
   */
  async flush(): Promise<void> {
    if (!this.database) return;
    // 写回的是绝对值：历史还没读回来就写，会把库里的旧账整格覆盖。读取在途就等它；
    // 读取失败过就先重试，仍失败则抛出并保持待写集合不动，等下一轮。
    if (this.loading) await this.loading.catch(() => undefined);
    if (this.loadFailed) await this.load();
    if (this.dirty.size === 0) return;
    const values: {
      environment: string;
      componentId: string;
      day: string;
      total: number;
      operational: number;
      degraded: number;
      unknown: number;
      latencySum: number;
      latencyCount: number;
    }[] = [];
    for (const key of this.dirty) {
      const [componentId, day] = key.split("|");
      const count =
        componentId && day
          ? this.days.get(componentId as PublicStatusComponentId)?.get(day)
          : undefined;
      if (!count) continue;
      values.push({
        environment: this.environment,
        componentId: componentId!,
        day: day!,
        ...count,
      });
    }
    const pending = [...this.dirty];
    this.dirty.clear();
    if (values.length === 0) return;
    try {
      const db = await this.database.client();
      await db
        .insert(statusDaily)
        .values(values)
        .onDuplicateKeyUpdate({
          set: {
            total: sql`values(${statusDaily.total})`,
            operational: sql`values(${statusDaily.operational})`,
            degraded: sql`values(${statusDaily.degraded})`,
            unknown: sql`values(${statusDaily.unknown})`,
            latencySum: sql`values(${statusDaily.latencySum})`,
            latencyCount: sql`values(${statusDaily.latencyCount})`,
          },
        });
    } catch (error) {
      for (const key of pending) this.dirty.add(key);
      throw error;
    }
  }

  /** 生成 `days` 天窗口内的历史。缺行的日子补一个 total 0 的格子，页面才能画出连续条带。 */
  read(days = this.retentionDays): PublicStatusHistory {
    const today = beijingDay(this.now());
    const generatedAt = this.now();
    const window: string[] = [];
    for (let index = 0; index < days; index += 1) {
      window.push(beijingDay(generatedAt - (days - 1 - index) * 86_400_000));
    }
    const entries: PublicStatusHistoryEntry[] = [];
    for (const [id, bucket] of this.days) {
      const counts = window.map((day) => bucket.get(day) ?? emptyCount());
      const cells = counts.map((count, index) => toCell(window[index]!, count));
      entries.push({
        id,
        cells,
        latencyMs: latencyOf(counts),
        uptime: PUBLIC_STATUS_UPTIME_DAYS.map((span) => windowRatio(counts, span)),
      });
    }
    this.prune(window[0] ?? today);
    return { days, generatedAt, entries };
  }

  private prune(cutoff: string): void {
    for (const bucket of this.days.values()) {
      for (const day of bucket.keys()) if (day < cutoff) bucket.delete(day);
    }
  }
}
