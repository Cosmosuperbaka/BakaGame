import { LRUCache } from "lru-cache";
import { runWithAnonymousMusicIpScope } from "./MusicIpScope";

/**
 * 音乐上游数据的软/硬双 TTL 缓存：软过期后台静默刷新、硬过期回源，带并发去重与
 * 按字节的上限。平台中立：键、TTL 与加载器由调用方注入，平台专有的刷新与告警
 * 语义（如日志文案）通过回调传入。
 */
const DEFAULT_CACHE_MAX_ENTRIES = 512;
const DEFAULT_CACHE_MAX_BYTES = 32 * 1024 * 1024;

type CacheEntry = {
  value: unknown;
  softExpireAt: number;
  hardExpireAt: number;
  lastAccessAt: number;
  hits: number;
  priority: number;
  size: number;
};

const cloneCacheValue = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

interface MusicCacheOptions {
  /** 条目数上限。 */
  maxEntries?: number;
  /** 字节总量上限（按序列化后长度估算）。 */
  maxBytes?: number;
  now: () => number;
  /** 上游忙态（限流冷却 / 本地排队拥塞）时跳过主动刷新与维护，避免雪崩。 */
  isUpstreamBusy: () => boolean;
  /** 后台刷新失败的告警出口；文案由调用方注入，保持各平台自己的日志口径。 */
  onRefreshFailure?: (key: string, error: unknown) => void;
}

export class MusicCache {
  private readonly cache: LRUCache<string, CacheEntry>;
  private readonly refreshers = new Map<
    string,
    {
      ttlMs: number;
      loader: () => Promise<unknown>;
      ttlForResult?: (value: unknown) => number;
    }
  >();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  private readonly isUpstreamBusy: () => boolean;
  private readonly onRefreshFailure?: (key: string, error: unknown) => void;
  private lastUserRequestAt: number;
  private readonly maintenanceTimer: ReturnType<typeof setInterval>;

  constructor(options: MusicCacheOptions) {
    this.cache = new LRUCache<string, CacheEntry>({
      max: Math.max(1, options.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES),
      maxSize: Math.max(1, options.maxBytes ?? DEFAULT_CACHE_MAX_BYTES),
      sizeCalculation: (entry) => entry.size,
    });
    this.now = options.now;
    this.isUpstreamBusy = options.isUpstreamBusy;
    this.onRefreshFailure = options.onRefreshFailure;
    this.lastUserRequestAt = this.now();
    this.maintenanceTimer = setInterval(() => {
      void this.runCacheMaintenance();
    }, 60_000);
    (this.maintenanceTimer as unknown as { unref?: () => void }).unref?.();
  }

  async cached<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
    options: {
      force?: boolean;
      priority?: number;
      background?: boolean;
      cacheNegative?: boolean;
      /** 按结果决定实际生效的 TTL：加载前无法区分的场景（如匿名检索的空结果沿用短 TTL）用它覆写。 */
      ttlForResult?: (value: T) => number;
    } = {}
  ): Promise<T> {
    const now = this.now();
    if (!options.background) this.lastUserRequestAt = now;
    const entry = this.cache.get(key);
    if (!options.force && entry) {
      if (now < entry.hardExpireAt) {
        entry.lastAccessAt = now;
        entry.hits += 1;
        if (now >= entry.softExpireAt)
          void this.refreshCacheEntry(
            key,
            ttlMs,
            loader,
            options.priority ?? entry.priority,
            options.ttlForResult as ((value: unknown) => number) | undefined
          );
        return cloneCacheValue(entry.value as T);
      }
      this.cache.delete(key);
      this.refreshers.delete(key);
    }
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) return cloneCacheValue(await existing);

    const allowNegative = options.cacheNegative !== false;
    this.refreshers.set(key, {
      ttlMs,
      loader,
      ttlForResult: options.ttlForResult as ((value: unknown) => number) | undefined,
    });
    const request = loader()
      .then((value) => {
        // 负结果不写缓存：上游抖动可能返回空地址 / 空值，一旦落缓存就会被钉死整个 TTL，
        // 玩家重试也只会拿到同一个空值。`cacheNegative` 缺省为 true 以保持既有缓存语义，
        // 播放地址这类「重试可能成功」的取值显式传 false，只跳过空结果、正常地址照旧缓存。
        const storeResult = allowNegative || Boolean(value);
        if (storeResult) {
          const fetchedAt = this.now();
          const effectiveTtl = Math.max(0, options.ttlForResult?.(value) ?? ttlMs);
          const serializedSize =
            value === undefined ? 32 : Math.max(32, JSON.stringify(value).length * 2);
          this.cache.set(key, {
            value,
            softExpireAt: fetchedAt + effectiveTtl * 0.8,
            hardExpireAt: fetchedAt + Math.max(effectiveTtl, effectiveTtl * 3),
            lastAccessAt: fetchedAt,
            hits: 1,
            priority: options.priority ?? 1,
            size: serializedSize,
          });
        }
        return value;
      })
      .finally(() => {
        if (this.inFlight.get(key) === request) this.inFlight.delete(key);
      });
    this.inFlight.set(key, request);
    return cloneCacheValue(await request);
  }

  /** 立即丢弃一个键的缓存与刷新器（下次读取强制回源）。 */
  invalidate(key: string) {
    this.cache.delete(key);
    this.refreshers.delete(key);
  }

  /**
   * 读一个尚未硬过期的缓存值（克隆后返回）；不统计命中、不触发后台刷新。
   * 供「先探测缓存、未命中才走熔断拦截」这类调用顺序敏感的调用方使用
   * （QQ 匿名检索：熔断期内缓存命中仍要照常服务，不能因熔断把可用结果也吞掉）。
   */
  peek<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry || this.now() >= entry.hardExpireAt) return undefined;
    return cloneCacheValue(entry.value as T);
  }

  private async refreshCacheEntry(
    key: string,
    ttlMs: number,
    loader: () => Promise<unknown>,
    priority: number,
    ttlForResult?: (value: unknown) => number
  ) {
    if (this.inFlight.has(key) || this.isUpstreamBusy()) return;
    try {
      await this.cached(key, ttlMs, loader, {
        priority,
        force: true,
        background: true,
        ttlForResult,
      });
    } catch (error) {
      this.onRefreshFailure?.(key, error);
    }
  }

  private async runCacheMaintenance() {
    if (this.isUpstreamBusy()) return;
    const now = this.now();
    if (now - this.lastUserRequestAt > 30 * 60_000) {
      this.evictIdleCacheEntries(now);
      return;
    }
    const candidates = [...this.cache.entries()]
      .filter(([, entry]) => now >= entry.hardExpireAt || now >= entry.softExpireAt)
      .sort(([, left], [, right]) => right.priority + right.hits - (left.priority + left.hits))
      .slice(0, 4);
    await this.refreshExpiredEntries(now, candidates);
    this.pruneStaleRefreshers();
  }

  /**
   * 后台维护路径。
   *
   * 定时器里没有玩家上下文，但这是设计如此、不是配置错误，所以显式声明走共享匿名出口：
   * 否则每次维护都会被记成「作用域外调用」的降级，把真正需要被发现的新调用链淹成噪声。
   * 该 scope 的配额与退避仍按 `anonymous` 正常计账。
   */
  private refreshExpiredEntries(
    now: number,
    candidates: Iterable<[string, CacheEntry]>
  ): Promise<void> {
    return runWithAnonymousMusicIpScope(async () => {
      for (const [key, entry] of candidates) {
        const refresher = this.refreshers.get(key);
        if (!refresher) {
          this.cache.delete(key);
          continue;
        }
        if (now >= entry.hardExpireAt) this.cache.delete(key);
        await this.refreshCacheEntry(
          key,
          refresher.ttlMs,
          refresher.loader,
          entry.priority,
          refresher.ttlForResult
        );
      }
    });
  }

  /** 长时间没有用户请求：淘汰低命中且久未访问的条目，不做任何主动刷新。 */
  private evictIdleCacheEntries(now: number) {
    for (const [key, entry] of this.cache.entries()) {
      if (entry.hits <= 1 && now - entry.lastAccessAt > 30 * 60_000) {
        this.cache.delete(key);
        this.refreshers.delete(key);
      }
    }
    this.pruneStaleRefreshers();
  }

  /** 刷新器只服务于已缓存或仍在请求中的条目，其余一并回收。 */
  private pruneStaleRefreshers() {
    for (const key of this.refreshers.keys())
      if (!this.cache.has(key) && !this.inFlight.has(key)) this.refreshers.delete(key);
  }
}
