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

export class SlidingWindowRateLimiter {
  private readonly windows = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(options: { windowMs?: number; maxRequests?: number } = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxRequests = options.maxRequests ?? 60;
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

  constructor(options: {
    windowMs?: number;
    ipMaxRequests?: number;
    peerMaxRequests?: number;
    globalMaxRequests?: number;
  } = {}) {
    const windowMs = options.windowMs ?? 60_000;
    const ipMaxRequests = options.ipMaxRequests ?? 60;
    this.ipLimiter = new SlidingWindowRateLimiter({ windowMs, maxRequests: ipMaxRequests });
    this.peerLimiter = new SlidingWindowRateLimiter({
      windowMs,
      maxRequests: options.peerMaxRequests ?? ipMaxRequests * 10,
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
