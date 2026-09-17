/**
 * 通用滑动窗口限流器。
 *
 * 原本定义在 `transport/routes/System.ts`，业务侧（application 层）要用它做
 * 按连接的上游调用配额时就会出现 application → transport 的反向依赖，
 * 因此下沉到这里，两边各自引用。
 */
export class SlidingWindowRateLimiter {
  private readonly windows = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(options: { windowMs?: number; maxRequests?: number } = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxRequests = options.maxRequests ?? 60;
  }

  public allow(key: string, now = Date.now()): boolean {
    const windowStart = now - this.windowMs;
    const timestamps = (this.windows.get(key) ?? []).filter((t) => t > windowStart);
    if (timestamps.length >= this.maxRequests) {
      this.windows.set(key, timestamps);
      return false;
    }
    timestamps.push(now);
    this.windows.set(key, timestamps);

    if (this.windows.size > 1000) {
      for (const [k, ts] of this.windows.entries()) {
        const valid = ts.filter((t) => t > windowStart);
        if (valid.length === 0) {
          this.windows.delete(k);
        } else {
          this.windows.set(k, valid);
        }
      }
    }

    return true;
  }

  public reset(): void {
    this.windows.clear();
  }
}
