import { and, eq, gte, sql } from "drizzle-orm";
import {
  PUBLIC_STATUS_COMPONENT_IDS,
  PUBLIC_STATUS_REALTIME_WINDOW_MS,
  PUBLIC_STATUS_SAMPLE_INTERVAL_MS,
  PUBLIC_STATUS_SAMPLE_RETENTION_MS,
  type PublicStatusComponentId,
  type PublicStatusRealtime,
  type PublicStatusRealtimeEntry,
  type PublicStatusSampleCell,
  type PublicStatusSnapshot,
} from "../shared/Status";
import type { Database } from "./db/Database";
import {
  addSample,
  cellFigures,
  emptyCount,
  ratioOf,
  sumCounts,
  type StatusCount,
} from "./StatusCounts";
import { statusSample } from "./db/Schema";

/** 格子起点对齐采样间隔：与时钟漂移无关，同一格永远同一起点。 */
export const sampleBucketOf = (time: number): number =>
  Math.floor(time / PUBLIC_STATUS_SAMPLE_INTERVAL_MS) * PUBLIC_STATUS_SAMPLE_INTERVAL_MS;

const toCell = (start: number, count: StatusCount): PublicStatusSampleCell => ({
  start,
  ...cellFigures(count),
});

export interface StatusSampleStoreOptions {
  /** 本进程的部署环境标记，口径与状态历史账本一致。 */
  environment: string;
  database?: Database;
  now?: () => number;
}

/**
 * 状态页实时条带的样本账本：由后台采样器每轮探测记一笔，格子粒度即采样间隔。
 *
 * 与日格账本同构（内存整份、落库写绝对值、缺行即无样本），只是格子更细、保留更短——
 * 窗口外加一栏余量后即裁剪，表大小有界。没有采样器喂数据时它只是空账，页面读作无样本。
 */
export class StatusSampleStore {
  private readonly environment: string;
  private readonly database?: Database;
  private readonly now: () => number;
  /** componentId → 格子起点（UTC 毫秒）→ 累计。 */
  private readonly buckets = new Map<PublicStatusComponentId, Map<number, StatusCount>>();
  private readonly dirty = new Set<string>();
  private loading: Promise<void> | undefined;
  private loaded = false;
  private loadFailed = false;

  constructor(options: StatusSampleStoreOptions) {
    this.environment = options.environment;
    this.database = options.database;
    this.now = options.now ?? Date.now;
    for (const id of PUBLIC_STATUS_COMPONENT_IDS) this.buckets.set(id, new Map());
  }

  /**
   * 启动时把保留窗内的既有账读回来。失败原样抛给调用方告警：条带会从本次运行开始积累，
   * 但不能把「账本坏了」静默成「本来就没有样本」。读回的行与加载期间已记的样本求和而不是覆盖，
   * 口径与日格账本一致。
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
    const cutoff = sampleBucketOf(this.now() - PUBLIC_STATUS_SAMPLE_RETENTION_MS);
    await database.ready;
    const rows = await database.db
      .select()
      .from(statusSample)
      .where(and(eq(statusSample.environment, this.environment), gte(statusSample.bucket, cutoff)));
    for (const row of rows) {
      const bucket = this.buckets.get(row.componentId as PublicStatusComponentId);
      if (!bucket) continue;
      const stored: StatusCount = {
        total: row.total,
        operational: row.operational,
        degraded: row.degraded,
        unknown: row.unknown,
        latencySum: row.latencySum,
        latencyCount: row.latencyCount,
      };
      const current = bucket.get(row.bucket);
      bucket.set(row.bucket, current ? sumCounts(current, stored) : stored);
    }
    this.prune(cutoff);
  }

  /** 一轮采样记一笔：等级进计数，带延迟读数的组件顺带累计延迟。 */
  record(snapshot: PublicStatusSnapshot): void {
    const start = sampleBucketOf(snapshot.observedAt || this.now());
    for (const component of snapshot.components) {
      const bucket = this.buckets.get(component.id);
      if (!bucket) continue;
      const count = bucket.get(start) ?? emptyCount();
      addSample(count, component.level, component.latencyMs);
      bucket.set(start, count);
      this.dirty.add(`${component.id}|${start}`);
    }
  }

  /** 把格子累计写回库；没有数据库或没有新账时直接返回。写失败时这批键放回待写集合再抛出，下一轮重试。 */
  async flush(): Promise<void> {
    if (!this.database) return;
    // 写回的是绝对值：历史还没读回来就写会覆盖库里的旧账，口径同日格账本。
    if (this.loading) await this.loading.catch(() => undefined);
    if (this.loadFailed) await this.load();
    if (this.dirty.size === 0) return;
    const values: {
      environment: string;
      componentId: string;
      bucket: number;
      total: number;
      operational: number;
      degraded: number;
      unknown: number;
      latencySum: number;
      latencyCount: number;
    }[] = [];
    for (const key of this.dirty) {
      const separator = key.lastIndexOf("|");
      const componentId = key.slice(0, separator);
      const bucketStart = Number(key.slice(separator + 1));
      const count = this.buckets.get(componentId as PublicStatusComponentId)?.get(bucketStart);
      if (!count) continue;
      values.push({
        environment: this.environment,
        componentId,
        bucket: bucketStart,
        ...count,
      });
    }
    const pending = [...this.dirty];
    this.dirty.clear();
    if (values.length === 0) return;
    try {
      const db = await this.database.client();
      await db
        .insert(statusSample)
        .values(values)
        .onDuplicateKeyUpdate({
          set: {
            total: sql`values(${statusSample.total})`,
            operational: sql`values(${statusSample.operational})`,
            degraded: sql`values(${statusSample.degraded})`,
            unknown: sql`values(${statusSample.unknown})`,
            latencySum: sql`values(${statusSample.latencySum})`,
            latencyCount: sql`values(${statusSample.latencyCount})`,
          },
        });
    } catch (error) {
      for (const key of pending) this.dirty.add(key);
      throw error;
    }
  }

  /** 生成实时窗口内的条带：只回有样本的格子，页面按窗口边界补空格。 */
  read(): PublicStatusRealtime {
    const now = this.now();
    const windowStart = sampleBucketOf(now - PUBLIC_STATUS_REALTIME_WINDOW_MS);
    const entries: PublicStatusRealtimeEntry[] = [];
    for (const [id, bucket] of this.buckets) {
      const cells: PublicStatusSampleCell[] = [];
      const windowCounts: StatusCount[] = [];
      for (const [start, count] of bucket) {
        if (start < windowStart) continue;
        cells.push(toCell(start, count));
        windowCounts.push(count);
      }
      cells.sort((left, right) => left.start - right.start);
      entries.push({ id, uptime: ratioOf(windowCounts), cells });
    }
    this.prune(sampleBucketOf(now - PUBLIC_STATUS_SAMPLE_RETENTION_MS));
    return {
      intervalMs: PUBLIC_STATUS_SAMPLE_INTERVAL_MS,
      windowMs: PUBLIC_STATUS_REALTIME_WINDOW_MS,
      generatedAt: now,
      entries,
    };
  }

  private prune(cutoff: number): void {
    for (const bucket of this.buckets.values()) {
      for (const start of bucket.keys()) if (start < cutoff) bucket.delete(start);
    }
  }
}
