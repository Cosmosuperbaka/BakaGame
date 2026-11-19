import { AppError } from "../../../domain/Errors";
import { asRecord, readNumber } from "../../JsonReaders";
import { createMusicQueue, type MusicQueueTuning } from "../UpstreamQueueFactory";
import type { UpstreamRequestQueue } from "../UpstreamRequestQueue";
import { audioCacheScope } from "./QQCookie";
import { readString } from "./QQResponse";
import type { QQMusicProviderOptions } from "./QQTypes";

/**
 * QQ 音乐上游的限流响应码集合。
 *
 * CGI 网关以 HTTP 层 429 / 503 表达限流；与网易云同口径同时检查响应封面的 `status`
 * 与 `body.code`。上游没有公开的限流码表，匿名限流更多表现为连续失败或空结果，
 * 由匿名熔断（streak 计数）兜底，这里只认明确形态。
 */
const QQ_RATE_LIMIT_CODES: ReadonlySet<number> = new Set([429, 503]);
const QQ_RATE_LIMIT_FALLBACK_MESSAGE = "QQ音乐请求过于频繁，请稍候再试";

const isQqRateLimitCode = (code: number | undefined) =>
  code !== undefined && QQ_RATE_LIMIT_CODES.has(code);

/** 带凭据请求的排队执行函数：登录与歌词模块只依赖这个签名，不碰队列本身。 */
export type QQCallUpstream = <T>(cookie: string | undefined, task: () => Promise<T>) => Promise<T>;

/** QQ 音乐上游的两条队列（已登录与匿名）与限流判定；匿名熔断状态在熔断器里。 */
export class QQUpstream {
  private readonly requestQueue: UpstreamRequestQueue;
  private readonly anonymousQueue: UpstreamRequestQueue;

  constructor(
    private readonly options: QQMusicProviderOptions,
    private readonly now: () => number,
    random: { nextFloat?: () => number }
  ) {
    this.requestQueue = this.createQueue(
      random,
      { ...options, maxConcurrentRequests: options.maxConcurrentRequests ?? 4 },
      {
        queueFull: "QQ音乐请求排队过多，请稍后重试",
        queueTimeout: "QQ音乐请求等待超时，请稍后重试",
        requestTimeout: "QQ音乐请求超时，请稍后重试",
      },
      "QQ音乐接口触发限流退避"
    );
    this.anonymousQueue = this.createQueue(
      random,
      { ...options, maxConcurrentRequests: options.anonymousMaxConcurrentRequests ?? 1 },
      {
        queueFull: "QQ音乐匿名请求排队过多，请稍后重试",
        queueTimeout: "QQ音乐匿名请求等待超时，请稍后重试",
        requestTimeout: "QQ音乐匿名请求超时，请稍后重试",
      },
      "QQ音乐匿名请求触发限流退避"
    );
  }

  private createQueue(
    random: { nextFloat?: () => number },
    tuning: MusicQueueTuning,
    messages: { queueFull: string; queueTimeout: string; requestTimeout: string },
    cooldownLog: string
  ): UpstreamRequestQueue {
    return createMusicQueue({
      now: this.now,
      random,
      tuning,
      messages: { ...messages, rateLimitFallback: QQ_RATE_LIMIT_FALLBACK_MESSAGE },
      isRateLimitError: (error) => this.isRateLimitError(error),
      readRateLimitMessage: (error, fallback) => this.readUpstreamMessage(error, fallback),
      onRateLimitCooldown: ({
        strikes,
        cooldownDurationMs,
        cooldownUntil,
        droppedQueuedRequests,
        reason,
      }) => {
        this.options.logger?.warn?.(cooldownLog, {
          strikes,
          cooldownDurationMs,
          cooldownUntil: new Date(cooldownUntil).toISOString(),
          droppedQueuedRequests,
          reason,
        });
      },
    });
  }

  /** 任一队列正在冷却，或（含排队时）有请求在排队。 */
  isCoolingDown(): boolean {
    return this.requestQueue.isCoolingDown() || this.anonymousQueue.isCoolingDown();
  }

  hasQueued(): boolean {
    return this.requestQueue.queuedCount > 0 || this.anonymousQueue.queuedCount > 0;
  }

  /** 匿名队列排队执行一次不带凭据的请求（预热探测用）。 */
  scheduleAnonymous<T>(task: () => Promise<T>): Promise<T> {
    return this.anonymousQueue.scheduleRequest(task);
  }

  private queueFor(cookie?: string): UpstreamRequestQueue {
    return cookie ? this.requestQueue : this.anonymousQueue;
  }

  /** QQ 上游限流判定：封面 `status` 与 `body.code` 同时覆盖（口径与网易云一致）。 */
  private isRateLimitError(error: unknown): boolean {
    const record = asRecord(error);
    return (
      isQqRateLimitCode(readNumber(record.status)) ||
      isQqRateLimitCode(readNumber(asRecord(record.body).code))
    );
  }

  private readUpstreamMessage(error: unknown, fallback: string): string {
    const body = asRecord(asRecord(error).body);
    return readString(body.message) ?? readString(body.msg) ?? fallback;
  }

  /** 排队执行一次 QQ 音乐上游请求；正常 resolve 的限流形状响应转成业务异常。 */
  async callUpstream<T>(cookie: string | undefined, task: () => Promise<T>): Promise<T> {
    // 带凭据的请求按账号指纹记限流退避：一个号撞限流只冷却它自己，
    // 池里其它账号照常工作；匿名请求仍共用一条退避。
    const response = await this.queueFor(cookie).scheduleRequest(
      task,
      cookie ? `account:${audioCacheScope(cookie)}` : undefined
    );
    if (this.isRateLimitError(response)) {
      const record = asRecord(response);
      const bodyCode = readNumber(asRecord(record.body).code);
      throw new AppError(
        "MUSIC_API_RATE_LIMITED",
        this.readUpstreamMessage(response, QQ_RATE_LIMIT_FALLBACK_MESSAGE),
        {
          // 限流码可能出现在 HTTP 状态上（429/503），也可能在 HTTP 200 的 body 里，
          // 报错时优先带上真正命中限流集合的那个。
          upstreamCode: isQqRateLimitCode(bodyCode) ? bodyCode : readNumber(record.status),
        }
      );
    }
    return response;
  }
}
