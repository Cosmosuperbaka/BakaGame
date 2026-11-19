import {
  BANGUMI_UPSTREAM_COOLDOWN_MS,
  BANGUMI_UPSTREAM_MAX_COOLDOWN_MS,
} from "../config/Constants";
import { AppError } from "../domain/Errors";
import { BANGUMI_USER_AGENT } from "./BangumiUserAgent";

/**
 * 数据线程对 Bangumi 上游的唯一出站口。
 *
 * 上游按标识头限流，同一个标识下所有出站（新条目发现、更新器、角色补全、猜歌封面回源）
 * 吃的是同一份额度。各处各自限流、互不知道对方被限时，一处收到 429 另一处仍在连续发请求，
 * 冷却形同虚设。所以限速时隙、冷却、超时与标识头都收在这里：任何一处收到限流，
 * 其余各处一起退避。
 *
 * - **玩家请求**（`interactive`）：冷却期内直接失败，不排队等待——玩家等不起。
 * - **后台请求**（`background`）：冷却期内等够再发，冷却一过自动恢复；限流本身不应被记成条目失败。
 * - **限速时隙**：调用方给出速率时，所有请求按同一条时间线排开，间隔不小于一个时隙；
 *   时隙在让出事件循环之前同步占位，并发调用不会穿透。
 *
 * 主线程的在线提供者在另一个线程里，状态无法共享，仍用自己的冷却；它与本部件只共享常量。
 */

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type UpstreamPriority = "interactive" | "background";

export interface UpstreamRequest {
  method?: string;
  /** 调用方的业务头（Accept、Content-Type 等）；标识头由本部件统一补上。 */
  headers?: Record<string, string>;
  body?: string;
  /** 单次请求的超时。 */
  timeoutMs: number;
  priority: UpstreamPriority;
  /** 调用方自己的取消信号（例如整次任务的总预算），与超时任一触发都中止请求。 */
  signal?: AbortSignal;
}

export interface BangumiUpstreamOptions {
  fetcher?: Fetcher;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 当前允许的请求速率（次/秒）；未给出或返回 `undefined` 表示不限速。 */
  rate?: () => number | undefined;
  /** 收到限流且上游没给等待时长时的冷却。 */
  cooldownMs?: number;
}

/** `Retry-After` 取秒数；日期形态与非法值按「没给」处理。 */
const parseRetryAfterMs = (value: string | null): number | undefined => {
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  return Number(value.trim()) * 1_000;
};

export class BangumiUpstream {
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rate?: () => number | undefined;
  private readonly cooldownMs: number;
  /** 冷却截止时刻；0 表示不在冷却。 */
  private cooldownUntil = 0;
  /** 下一个请求时隙的最早时刻：限速靠它排队，比滑动窗口更适合「匀速慢跑」。 */
  private nextSlotAt = 0;

  constructor(options: BangumiUpstreamOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
    this.rate = options.rate;
    this.cooldownMs = options.cooldownMs ?? BANGUMI_UPSTREAM_COOLDOWN_MS;
  }

  /** 距冷却结束还有多久；不在冷却期为 0。 */
  cooldownRemainingMs(): number {
    return Math.max(0, this.cooldownUntil - this.now());
  }

  /**
   * 发一次请求，返回上游的响应（非 2xx 也原样返回，由调用方判断状态码）。
   * 只有两种情况本部件自己抛错：玩家请求撞上冷却、上游回了限流（`BANGUMI_RATE_LIMITED`）。
   */
  async fetch(url: string, request: UpstreamRequest): Promise<Response> {
    await this.waitCooldown(request);
    await this.waitSlot();
    // 等时隙的间隙里别处可能刚收到了限流：再确认一次，别在冷却里发出去。
    await this.waitCooldown(request);

    const signals = [AbortSignal.timeout(request.timeoutMs)];
    if (request.signal) signals.push(request.signal);
    const response = await this.fetcher(url, {
      ...(request.method ? { method: request.method } : {}),
      headers: { ...request.headers, "User-Agent": BANGUMI_USER_AGENT },
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: AbortSignal.any(signals),
    });
    if (response.status === 429) {
      this.enterCooldown(parseRetryAfterMs(response.headers.get("Retry-After")));
      throw this.rateLimitError();
    }
    return response;
  }

  private enterCooldown(retryAfterMs?: number): void {
    const duration = Math.min(retryAfterMs ?? this.cooldownMs, BANGUMI_UPSTREAM_MAX_COOLDOWN_MS);
    this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + duration);
  }

  private rateLimitError(): AppError {
    return new AppError("BANGUMI_RATE_LIMITED", "Bangumi 请求过于频繁，请稍后重试", {
      retryAfterMs: this.cooldownRemainingMs(),
    });
  }

  private async waitCooldown(request: UpstreamRequest): Promise<void> {
    while (this.cooldownRemainingMs() > 0) {
      if (request.priority === "interactive") throw this.rateLimitError();
      const observed = this.cooldownUntil;
      await this.sleep(this.cooldownRemainingMs());
      request.signal?.throwIfAborted();
      // 睡满了就视为冷却已过；睡眠期间若被别处延长了截止时刻，则继续等。
      if (this.cooldownUntil === observed) this.cooldownUntil = 0;
    }
  }

  private async waitSlot(): Promise<void> {
    const rate = this.rate?.();
    if (!rate || rate <= 0) return;
    const now = this.now();
    const slot = Math.max(this.nextSlotAt, now);
    this.nextSlotAt = slot + 1_000 / rate;
    if (slot > now) await this.sleep(slot - now);
  }
}
