/**
 * 通用滑动窗口限流器。
 *
 * 原本定义在 `transport/routes/System.ts`，业务侧（application 层）要用它做
 * 按连接的上游调用配额时就会出现 application → transport 的反向依赖，
 * 因此下沉到这里，两边各自引用。
 */

/** 一次配额判定的完整产出：够写限流响应头，也够算出最早可重试的时刻。 */
export interface RateLimitVerdict {
  allowed: boolean;
  /** 被拒时距最早一次请求出窗还有多少毫秒；放行时为 0。 */
  retryAfterMs: number;
  /** 配额恢复（最早那次请求滑出窗口）的绝对毫秒时刻。 */
  resetAt: number;
  /** 决定本次结果的桶的额度与剩余额度。 */
  limit: number;
  remaining: number;
}

/**
 * 同时记账的桶键上限。键来自客户端可影响的输入（来源地址标头、连接号）时，
 * 只回收过期键等于让对方按需扩张内存；满了就挤掉最久没被用到的键——
 * 少记一笔配额是可接受的降级，无界增长不是。
 */
const DEFAULT_MAX_TRACKED_KEYS = 10_000;

export class SlidingWindowRateLimiter {
  private readonly windows = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly maxKeys: number;

  constructor(options: { windowMs?: number; maxRequests?: number; maxKeys?: number } = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxRequests = options.maxRequests ?? 60;
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_TRACKED_KEYS;
  }

  public consume(key: string, now = Date.now()): RateLimitVerdict {
    const windowStart = now - this.windowMs;
    // Map 按最后一次获准请求排序；每次最多回收 64 个已过期 key。
    // 不淘汰仍有配额记录的 key，否则高基数攻击会绕过限流。
    let inspected = 0;
    for (const [expiredKey, timestamps] of this.windows) {
      if (++inspected > 64 || timestamps.some((timestamp) => timestamp > windowStart)) break;
      this.windows.delete(expiredKey);
    }
    // 过期回收只覆盖「键都凉了」的情况：键数已达上限时按插入顺序（最久未被用到）挤掉一个。
    if (this.windows.size >= this.maxKeys && !this.windows.has(key)) {
      const oldest = this.windows.keys().next().value;
      if (oldest !== undefined) this.windows.delete(oldest);
    }
    const timestamps = (this.windows.get(key) ?? []).filter((t) => t > windowStart);
    // 窗口是滑动的：最早那次请求出窗的一刻就是配额开始恢复的一刻。
    const resetAt = (timestamps[0] ?? now) + this.windowMs;
    if (timestamps.length >= this.maxRequests) {
      this.windows.set(key, timestamps);
      return {
        allowed: false,
        retryAfterMs: Math.max(1, resetAt - now),
        resetAt,
        limit: this.maxRequests,
        remaining: 0,
      };
    }
    timestamps.push(now);
    this.windows.delete(key);
    this.windows.set(key, timestamps);

    return {
      allowed: true,
      retryAfterMs: 0,
      resetAt,
      limit: this.maxRequests,
      remaining: this.maxRequests - timestamps.length,
    };
  }

  public allow(key: string, now = Date.now()): boolean {
    return this.consume(key, now).allowed;
  }

  /** 当前记账的桶键数量；容量不变量测试用，业务代码不得据此判定。 */
  public get trackedKeys(): number {
    return this.windows.size;
  }

  public reset(): void {
    this.windows.clear();
  }
}

const GLOBAL_BUCKET = "__global__";

/**
 * 三层桶：单客户端 / 回源 peer / 全局，口径与打点、Sentry 隧道、账号入口一致。
 *
 * 单客户端桶按 ESA 托管转换写入的真实 IP 分桶，否则同一节点后面的所有玩家共享一个桶，
 * 按用户计预算会退化成按节点计。peer 桶只封顶「伪造标头自造新桶」这条滥用路径，
 * 因此给到单客户端额度的十倍：一个节点服务的用户量远大于单个用户的请求量。
 * `consume` 返回第一个被拒的桶，响应头才说得出「是谁的额度用完了」。
 */
export class ThreeTierRateLimiter {
  private readonly ipLimiter: SlidingWindowRateLimiter;
  private readonly peerLimiter: SlidingWindowRateLimiter;
  private readonly globalLimiter: SlidingWindowRateLimiter;

  constructor(
    options: {
      windowMs?: number;
      ipMaxRequests?: number;
      peerMaxRequests?: number;
      globalMaxRequests?: number;
      /** 单客户端与 peer 两个桶各自最多记多少个键；全局桶只有一个键，不受影响。 */
      maxKeys?: number;
    } = {}
  ) {
    const windowMs = options.windowMs ?? 60_000;
    const ipMaxRequests = options.ipMaxRequests ?? 60;
    this.ipLimiter = new SlidingWindowRateLimiter({
      windowMs,
      maxRequests: ipMaxRequests,
      maxKeys: options.maxKeys,
    });
    this.peerLimiter = new SlidingWindowRateLimiter({
      windowMs,
      maxRequests: options.peerMaxRequests ?? ipMaxRequests * 10,
      maxKeys: options.maxKeys,
    });
    this.globalLimiter = new SlidingWindowRateLimiter({
      windowMs,
      maxRequests: options.globalMaxRequests ?? 1000,
    });
  }

  public consume(ip: string, peerIp = ip, now = Date.now()): RateLimitVerdict {
    const global = this.globalLimiter.consume(GLOBAL_BUCKET, now);
    if (!global.allowed) return global;
    const peer = this.peerLimiter.consume(peerIp, now);
    if (!peer.allowed) return peer;
    return this.ipLimiter.consume(ip, now);
  }

  public allow(ip: string, peerIp = ip, now = Date.now()): boolean {
    return this.consume(ip, peerIp, now).allowed;
  }

  public reset(): void {
    this.ipLimiter.reset();
    this.peerLimiter.reset();
    this.globalLimiter.reset();
  }
}
