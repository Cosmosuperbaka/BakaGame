import PQueue from "p-queue";
import type { AppError } from "../domain/Errors";

const DEFAULT_MAX_CONCURRENT_REQUESTS = 3;
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 100;
/**
 * 限流退避起点。网易云的限流窗口是**分钟级**，秒级起步会让「冷却一结束就重试」变成撞墙循环，
 * 把一次限流放大成近一分钟的全服不可用。起点直接对齐实测的恢复窗口下界。
 */
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
/** 退避上限：覆盖长限流窗口，避免期间被反复唤醒、等级空转。 */
const DEFAULT_MAX_RATE_LIMIT_COOLDOWN_MS = 600_000;
const DEFAULT_MAX_QUEUED_REQUESTS = 64;
const DEFAULT_QUEUE_TIMEOUT_MS = 8_000;

/** 限流退避发生时的上下文，供调用方做 IP 轮换与结构化告警。 */
interface RateLimitCooldownInfo {
  error: unknown;
  scope?: string;
  strikes: number;
  cooldownDurationMs: number;
  cooldownUntil: number;
  droppedQueuedRequests: number;
  reason: string;
}

interface UpstreamRequestQueueOptions {
  now: () => number;
  /** 随机源（注入以便确定性测试）；缺省回落 `Math.random`。 */
  random?: { nextFloat?: () => number };
  /** 同时访问上游的请求数。 */
  maxConcurrentRequests?: number;
  /** 两次上游请求启动之间的最小间隔。 */
  minRequestIntervalMs?: number;
  /** 首次遇到上游限流后的冷却时间；连续限流会指数增长。 */
  rateLimitCooldownMs?: number;
  maxRateLimitCooldownMs?: number;
  /** 等待队列的容量和最长停留时间，避免限流恢复后集中补发陈旧请求。 */
  maxQueuedRequests?: number;
  queueTimeoutMs?: number;
  /** 本地队列拥塞（排队过多）时的用户可见文案。 */
  queueFullMessage: string;
  /** 本地队列拥塞（等待超时）时的用户可见文案。 */
  queueTimeoutMessage: string;
  /** 限流文案的初始值；后续被 `readRateLimitMessage` 从响应里读出的值覆盖。 */
  rateLimitFallbackMessage: string;
  /** 判定一次结果 / 错误是否上游限流；平台各自的响应形态差异由调用方收口。 */
  isRateLimitError: (error: unknown) => boolean;
  /** 从限流错误里读人话文案；读不出时回落上一条。 */
  readRateLimitMessage?: (error: unknown, fallback: string) => string;
  /** 进入限流退避时的附加处理（如轮换出口 IP）与结构化告警。 */
  onRateLimitCooldown?: (info: RateLimitCooldownInfo) => void;
  /** 构造本地拥塞错误（排队过多 / 等待超时）。 */
  createBusyError: (message: string, retryAfterMs: number) => AppError;
  /** 构造上游限流错误（含冷却期内的快速拒绝）。 */
  createRateLimitError: (message: string, retryAfterMs: number) => AppError;
}

/**
 * 音乐上游请求的排队、冷却与错误退避。队列与退避本身平台中立；平台专有的错误分类
 * （什么算限流、什么算致命）与错误构造由调用方通过回调注入。
 */
export class UpstreamRequestQueue {
  private readonly queue: PQueue;
  private readonly pendingRejections = new Map<number, (error: unknown) => void>();
  private requestIdCounter = 0;
  private readonly maxConcurrentRequests: number;
  private readonly minRequestIntervalMs: number;
  private readonly rateLimitCooldownMs: number;
  private readonly maxRateLimitCooldownMs: number;
  private readonly maxQueuedRequests: number;
  private readonly queueTimeoutMs: number;
  private cooldownUntil = 0;
  private rateLimitStrikes = 0;
  private lastRateLimitAt = 0;
  private lastRateLimitMessage: string;
  private readonly queueFullMessage: string;
  private readonly queueTimeoutMessage: string;
  private readonly now: () => number;
  private readonly random: { nextFloat?: () => number };
  private readonly isRateLimitError: (error: unknown) => boolean;
  private readonly readRateLimitMessage?: (error: unknown, fallback: string) => string;
  private readonly onRateLimitCooldown?: (info: RateLimitCooldownInfo) => void;
  private readonly createBusyError: (message: string, retryAfterMs: number) => AppError;
  private readonly createRateLimitError: (message: string, retryAfterMs: number) => AppError;

  constructor(options: UpstreamRequestQueueOptions) {
    this.now = options.now;
    this.random = options.random ?? { nextFloat: () => Math.random() };
    this.maxConcurrentRequests = Math.max(
      1,
      options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS
    );
    this.minRequestIntervalMs = Math.max(
      0,
      options.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS
    );
    this.rateLimitCooldownMs = Math.max(
      0,
      options.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS
    );
    this.maxRateLimitCooldownMs = Math.max(
      this.rateLimitCooldownMs,
      options.maxRateLimitCooldownMs ?? DEFAULT_MAX_RATE_LIMIT_COOLDOWN_MS
    );
    this.maxQueuedRequests = Math.max(1, options.maxQueuedRequests ?? DEFAULT_MAX_QUEUED_REQUESTS);
    this.queueTimeoutMs = Math.max(1, options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS);
    this.lastRateLimitMessage = options.rateLimitFallbackMessage;
    this.queueFullMessage = options.queueFullMessage;
    this.queueTimeoutMessage = options.queueTimeoutMessage;
    this.isRateLimitError = options.isRateLimitError;
    this.readRateLimitMessage = options.readRateLimitMessage;
    this.onRateLimitCooldown = options.onRateLimitCooldown;
    this.createBusyError = options.createBusyError;
    this.createRateLimitError = options.createRateLimitError;
    this.queue = new PQueue({
      concurrency: this.maxConcurrentRequests,
      ...(this.minRequestIntervalMs > 0
        ? { interval: this.minRequestIntervalMs, intervalCap: 1 }
        : {}),
    });
  }

  /** 当前是否处于限流冷却期（含快速拒绝窗口）。 */
  isCoolingDown(): boolean {
    return this.now() < this.cooldownUntil;
  }

  /** 仍在本地排队等待执行的请求数。 */
  get queuedCount(): number {
    return this.queue.size;
  }

  /**
   * 排队执行一次上游请求。
   *
   * `ipScope` 是本次请求使用的伪装出口 IP 的归属标识：限流一旦发生，就刷新该 scope 的 IP，
   * 让下一次请求换一个出口重试（详见 `rotateScopeIp`）。
   */
  scheduleRequest<T>(task: () => Promise<T>, ipScope?: string): Promise<T> {
    if (this.now() < this.cooldownUntil) {
      return Promise.reject(this.rateLimitError());
    }
    if (this.queue.size >= this.maxQueuedRequests) {
      return Promise.reject(this.busyError(this.queueFullMessage));
    }

    const id = ++this.requestIdCounter;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectHandler: ((err: unknown) => void) | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectHandler = reject;
      timeoutTimer = setTimeout(() => {
        if (this.pendingRejections.has(id)) {
          this.pendingRejections.delete(id);
          reject(this.busyError(this.queueTimeoutMessage));
        }
      }, this.queueTimeoutMs);
    });

    this.pendingRejections.set(id, (err) => {
      clearTimeout(timeoutTimer);
      rejectHandler?.(err);
    });

    const executionPromise = this.queue.add(async () => {
      clearTimeout(timeoutTimer);
      if (!this.pendingRejections.has(id)) {
        return;
      }
      this.pendingRejections.delete(id);

      if (this.now() < this.cooldownUntil) {
        throw this.rateLimitError();
      }
      try {
        const result = await task();
        if (this.isRateLimitError(result)) {
          this.enterRateLimitCooldown(result, ipScope);
        }
        return result;
      } catch (error) {
        if (this.isRateLimitError(error)) {
          this.enterRateLimitCooldown(error, ipScope);
        }
        throw error;
      }
    }) as Promise<T>;

    return Promise.race([executionPromise, timeoutPromise]);
  }

  /**
   * 进入限流退避。
   *
   * `ipScope` 是触发本次限流的请求所属的 IP 归属。网易云按请求方声称的 IP 计算配额，
   * 同一 IP 继续重试只会继续被拒，换一个伪装 IP 才能立刻恢复，因此这里顺手刷新该 scope，
   * 让退避结束后的下一次请求从新出口发出，而不是继续撞在同一个已经计满的 IP 上。
   */
  private enterRateLimitCooldown(error: unknown, ipScope?: string) {
    this.lastRateLimitMessage =
      this.readRateLimitMessage?.(error, this.lastRateLimitMessage) ?? this.lastRateLimitMessage;
    const now = this.now();
    if (now - this.lastRateLimitAt > this.maxRateLimitCooldownMs) {
      this.rateLimitStrikes = 0;
    }
    this.rateLimitStrikes = Math.min(this.rateLimitStrikes + 1, 8);
    this.lastRateLimitAt = now;
    const baseDuration = Math.min(
      this.maxRateLimitCooldownMs,
      this.rateLimitCooldownMs * 2 ** (this.rateLimitStrikes - 1)
    );
    // 注入微量随机 Jitter 抖动，防止限流恢复瞬间突发惊群重连
    const jitter = Math.floor((this.random.nextFloat?.() ?? Math.random()) * (baseDuration * 0.05));
    const duration = Math.min(this.maxRateLimitCooldownMs, baseDuration + jitter);
    this.cooldownUntil = Math.max(this.cooldownUntil, now + duration);

    const rejections = Array.from(this.pendingRejections.values());
    this.queue.clear();
    this.pendingRejections.clear();

    this.onRateLimitCooldown?.({
      error,
      scope: ipScope,
      strikes: this.rateLimitStrikes,
      cooldownDurationMs: duration,
      cooldownUntil: this.cooldownUntil,
      droppedQueuedRequests: rejections.length,
      reason: this.lastRateLimitMessage,
    });

    const rejected = this.rateLimitError(this.lastRateLimitMessage);
    for (const reject of rejections) {
      reject(rejected);
    }
  }

  /**
   * 本地队列拥塞（排队过多 / 等待超时）。
   *
   * 与上游限流是两回事：成因是本进程的并发与队列参数，排查方向也完全不同。
   * 两者必须用不同错误码，否则线上看到「限流」时无法区分是网易云真的拒绝了，
   * 还是本地把自己堵死了。
   */
  private busyError(message: string) {
    return this.createBusyError(message, Math.max(0, this.queueTimeoutMs));
  }

  /** 上游限流（含冷却期内的快速拒绝），也可用于拒绝已在队列中、但冷却已开始的请求。 */
  private rateLimitError(message = this.lastRateLimitMessage) {
    return this.createRateLimitError(message, Math.max(0, this.cooldownUntil - this.now()));
  }
}
