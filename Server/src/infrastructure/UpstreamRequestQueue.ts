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

/**
 * 未声明出口作用域时的退避键。
 *
 * 上游按请求方声称的出口 IP（网易云）或账号判定限流，每个 `player:` / `host:` 作用域是
 * 一条独立的配额线；把它们塞进同一个冷却会让一个号的 405 停掉全服所有请求。没传作用域的
 * 调用方（QQ 的两条队列已按凭据 / 匿名拆开）保持整条队列共用一次退避的旧行为。
 */
const GLOBAL_COOLDOWN_SCOPE = "*";

/** 冷却表条目上限：scope 数量与在线玩家 / 账号同量级，超出按插入顺序淘汰最老的。 */
const MAX_COOLDOWN_SCOPES = 512;

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

/** 一个出口作用域当前这一轮限流退避。 */
interface CooldownState {
  until: number;
  strikes: number;
  lastLimitAt: number;
  message: string;
}

/**
 * 一个已受理、尚未开始执行的请求。
 *
 * `settle` / `fail` 直接结算调用方的 Promise，而不是把 p-queue 的返回 Promise 交给调用方：
 * 一个作用域触发限流时要把其它作用域的等待请求从 p-queue 里清掉再重新入队，
 * 调用方必须始终挂在同一个可结算的句柄上，否则重新入队后就再也没人收到结果。
 */
interface PendingRequest {
  scope?: string;
  task: () => Promise<unknown>;
  /** 已开始执行的任务不再重排；执行中遇到限流由结果 / 异常路径结算。 */
  started: boolean;
  /** 排队计时只覆盖等待期，任务真正开始时停掉。 */
  stopQueueTimer: () => void;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

/**
 * 音乐上游请求的排队、冷却与错误退避。队列与退避本身平台中立；平台专有的错误分类
 * （什么算限流、什么算致命）与错误构造由调用方通过回调注入。
 *
 * **冷却按出口作用域记账，不是进程级开关。** 网易云按请求方声称的 IP 计配额，一个账号
 * 撞到 405 只说明那条出口打满了，别的 player / host 作用域仍有自己的配额。旧实现用
 * 一个全局 `cooldownUntil`，任何一个号的 405 都会让所有房间一起报「操作频繁」，玩家
 * 少、房间集中在一个号上时尤其明显。
 */
export class UpstreamRequestQueue {
  private readonly queue: PQueue;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private requestIdCounter = 0;
  private readonly maxConcurrentRequests: number;
  private readonly minRequestIntervalMs: number;
  private readonly rateLimitCooldownMs: number;
  private readonly maxRateLimitCooldownMs: number;
  private readonly maxQueuedRequests: number;
  private readonly queueTimeoutMs: number;
  private readonly cooldowns = new Map<string, CooldownState>();
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

  /**
   * 是否有任意作用域正在退避（含快速拒绝窗口）。
   * 缓存预刷新只读这一条：上游正在限流时不做任何主动回源，宁可少刷新。
   */
  isCoolingDown(): boolean {
    const now = this.now();
    for (const state of this.cooldowns.values()) if (now < state.until) return true;
    return false;
  }

  /** 仍在本地排队等待执行的请求数。 */
  get queuedCount(): number {
    return this.queue.size;
  }

  /**
   * 排队执行一次上游请求。
   *
   * `ipScope` 是本次请求使用的出口归属（玩家 / 凭证 / 登录会话）：限流一旦发生，就只让
   * 这个作用域进入退避并刷新它的 IP，其它作用域继续按各自的配额工作。
   */
  scheduleRequest<T>(task: () => Promise<T>, ipScope?: string): Promise<T> {
    const cooling = this.activeCooldown(ipScope);
    if (cooling) {
      return Promise.reject(this.rateLimitError(cooling));
    }
    if (this.pendingRequests.size >= this.maxQueuedRequests) {
      return Promise.reject(this.busyError(this.queueFullMessage));
    }

    const id = ++this.requestIdCounter;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      const fail = (error: unknown) => settle(() => reject(error as Error));
      const timeoutTimer = setTimeout(() => {
        if (!this.pendingRequests.has(id)) return;
        this.pendingRequests.delete(id);
        fail(this.busyError(this.queueTimeoutMessage));
      }, this.queueTimeoutMs);
      const pending: PendingRequest = {
        scope: ipScope,
        task,
        started: false,
        stopQueueTimer: () => clearTimeout(timeoutTimer),
        resolve: (value) => settle(() => resolve(value as T)),
        reject: fail,
      };
      this.pendingRequests.set(id, pending);
      this.enqueuePending(id);
    });
  }

  /** 把一条等待中的请求交给 p-queue；清队重排时用同一个 id 反复调用即可。 */
  private enqueuePending(id: number): void {
    void this.queue
      .add(async () => {
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        pending.stopQueueTimer();
        pending.started = true;
        this.pendingRequests.delete(id);

        // 排队期间该作用域已进入退避：不再打上游，直接按限流结算。
        const cooling = this.activeCooldown(pending.scope);
        if (cooling) {
          pending.reject(this.rateLimitError(cooling));
          return;
        }

        try {
          const result = await pending.task();
          if (this.isRateLimitError(result)) {
            this.enterRateLimitCooldown(result, pending.scope);
          }
          pending.resolve(result);
        } catch (error) {
          if (this.isRateLimitError(error)) {
            this.enterRateLimitCooldown(error, pending.scope);
          }
          pending.reject(error);
        }
      })
      .catch(() => {
        /* 任务异常已在内部结算，p-queue 的返回 Promise 不再需要结果 */
      });
  }

  /**
   * 进入限流退避。
   *
   * `ipScope` 是触发本次限流的请求所属的出口归属。上游按它计配额，同一出口继续重试只会
   * 继续被拒，换一个伪装 IP 才能立刻恢复，因此退避时顺手刷新该作用域（见 `rotateScopeIp`）。
   *
   * 同一波并发请求会一起返回 405：第一个已经把作用域推进冷却后，其余迟到的失败不再
   * 各记一档。否则 `getSong` 这种一次并发五六条的调用会把 60s 直接顶成 4 分钟。
   */
  private enterRateLimitCooldown(error: unknown, ipScope?: string) {
    const now = this.now();
    const key = ipScope ?? GLOBAL_COOLDOWN_SCOPE;
    const previous = this.cooldowns.get(key);
    if (previous && now < previous.until) return;

    this.lastRateLimitMessage =
      this.readRateLimitMessage?.(error, this.lastRateLimitMessage) ?? this.lastRateLimitMessage;
    if (previous && now - previous.lastLimitAt > this.maxRateLimitCooldownMs) {
      previous.strikes = 0;
    }
    const strikes = Math.min((previous?.strikes ?? 0) + 1, 8);
    const baseDuration = Math.min(
      this.maxRateLimitCooldownMs,
      this.rateLimitCooldownMs * 2 ** (strikes - 1)
    );
    // 注入微量随机 Jitter 抖动，防止限流恢复瞬间突发惊群重连
    const jitter = Math.floor((this.random.nextFloat?.() ?? Math.random()) * (baseDuration * 0.05));
    const duration = Math.min(this.maxRateLimitCooldownMs, baseDuration + jitter);
    const state: CooldownState = {
      until: Math.max(previous?.until ?? 0, now + duration),
      strikes,
      lastLimitAt: now,
      message: this.lastRateLimitMessage,
    };
    this.cooldowns.set(key, state);
    this.pruneCooldowns(now);

    // 只结算触发本次限流的作用域里还在排队的请求；其它作用域的请求先清出 p-queue，
    // 再按原顺序放回去 —— 一个账号打满额度不代表别的出口也被上游拒绝了。
    const requeue: number[] = [];
    let droppedQueuedRequests = 0;
    for (const [id, pending] of [...this.pendingRequests]) {
      if (pending.started) continue;
      const affected = ipScope === undefined || pending.scope === ipScope;
      if (affected) {
        this.pendingRequests.delete(id);
        droppedQueuedRequests += 1;
        pending.reject(this.rateLimitError(state));
      } else {
        requeue.push(id);
      }
    }
    this.queue.clear();
    for (const id of requeue) this.enqueuePending(id);

    this.onRateLimitCooldown?.({
      error,
      scope: ipScope,
      strikes,
      cooldownDurationMs: duration,
      cooldownUntil: state.until,
      droppedQueuedRequests,
      reason: this.lastRateLimitMessage,
    });
  }

  /** 取某个作用域当下生效的退避：全局键会兜住所有请求，作用域键只兜住自己。 */
  private activeCooldown(ipScope?: string): CooldownState | undefined {
    const now = this.now();
    const global = this.cooldowns.get(GLOBAL_COOLDOWN_SCOPE);
    if (global && now < global.until) return global;
    if (!ipScope) return undefined;
    const scoped = this.cooldowns.get(ipScope);
    return scoped && now < scoped.until ? scoped : undefined;
  }

  /** 清掉已到期的条目并限制表大小；被淘汰的作用域下次请求重新分配 IP 即可。 */
  private pruneCooldowns(now: number) {
    for (const [scope, state] of this.cooldowns) {
      if (scope !== GLOBAL_COOLDOWN_SCOPE && now >= state.until) this.cooldowns.delete(scope);
    }
    while (this.cooldowns.size > MAX_COOLDOWN_SCOPES) {
      const oldest = this.cooldowns.keys().next().value;
      if (oldest === undefined) break;
      this.cooldowns.delete(oldest);
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

  /** 指定作用域的限流错误；未给出状态时用最近一次读到的上游文案。 */
  private rateLimitError(state?: CooldownState) {
    const retryAfterMs = state ? Math.max(0, state.until - this.now()) : 0;
    return this.createRateLimitError(state?.message ?? this.lastRateLimitMessage, retryAfterMs);
  }
}
