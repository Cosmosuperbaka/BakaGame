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
  type PublicStatusLevel,
  type PublicStatusSnapshot,
  type PublicStatusUptime,
} from "../shared/Status";
import type { Database } from "./db/Database";
import { statusDaily } from "./db/Schema";

/** 一个组件在一天之内的探测计数。 */
interface DayCount {
  total: number;
  operational: number;
  degraded: number;
  unknown: number;
}

const emptyCount = (): DayCount => ({ total: 0, operational: 0, degraded: 0, unknown: 0 });

const addLevel = (count: DayCount, level: PublicStatusLevel): void => {
  count.total += 1;
  count[level] += 1;
};

/**
 * 日格与窗口可用率都只由计数派生。可用率的分母只算有结论的样本（operational+degraded）：
 * 内部组件探测失败已经记成 degraded，unknown 只表示「没有结论」（未接入监测或监测本身取不到），
 * 它不进分母——既不把「没接入」压成 0%，也不把真故障抬高。
 */
const toCell = (day: string, count: DayCount): PublicStatusCell => {
  const decided = count.operational + count.degraded;
  return {
    day,
    total: count.total,
    ratio: decided > 0 ? count.operational / decided : null,
    level:
      count.total === 0
        ? "unknown"
        : count.degraded > 0
          ? "degraded"
          : count.operational > 0
            ? "operational"
            : "unknown",
  };
};

const windowRatio = (counts: DayCount[], days: number): PublicStatusUptime => {
  const window = counts.slice(-days);
  const operational = window.reduce((sum, count) => sum + count.operational, 0);
  const degraded = window.reduce((sum, count) => sum + count.degraded, 0);
  const decided = operational + degraded;
  return { days, ratio: decided > 0 ? operational / decided : null };
};

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
 * 本进程是这张表在所属环境下的唯一写入方，绝对值让重启后的 `load()` 直接覆盖回同一份账，不会重复计数。
 *
 * 没有探测就不写行：「那一天没有数据」由缺行表达，页面读作无数据，而不是拿 0% 冒充全挂。
 */
export class StatusHistoryStore {
  private readonly environment: string;
  private readonly database?: Database;
  private readonly now: () => number;
  private readonly retentionDays: number;
  /** componentId → 北京时间自然日 → 计数。 */
  private readonly days = new Map<PublicStatusComponentId, Map<string, DayCount>>();
  private readonly dirty = new Set<string>();

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
   */
  async load(): Promise<void> {
    if (!this.database) return;
    const cutoff = beijingDay(this.now() - (this.retentionDays - 1) * 86_400_000);
    await this.database.ready;
    const rows = await this.database.db
      .select()
      .from(statusDaily)
      .where(and(eq(statusDaily.environment, this.environment), gte(statusDaily.day, cutoff)));
    for (const row of rows) {
      const bucket = this.days.get(row.componentId as PublicStatusComponentId);
      if (!bucket) continue;
      bucket.set(row.day, {
        total: row.total,
        operational: row.operational,
        degraded: row.degraded,
        unknown: row.unknown,
      });
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
      addLevel(count, component.level);
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
    if (!this.database || this.dirty.size === 0) return;
    const values: {
      environment: string;
      componentId: string;
      day: string;
      total: number;
      operational: number;
      degraded: number;
      unknown: number;
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
      await this.database.ready;
      await this.database.db
        .insert(statusDaily)
        .values(values)
        .onDuplicateKeyUpdate({
          set: {
            total: sql`values(${statusDaily.total})`,
            operational: sql`values(${statusDaily.operational})`,
            degraded: sql`values(${statusDaily.degraded})`,
            unknown: sql`values(${statusDaily.unknown})`,
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
