import { AppError } from "../../domain/Errors";
import {
  UpstreamRequestQueue,
  type RateLimitCooldownInfo,
  type UpstreamRequestQueueOptions,
} from "./UpstreamRequestQueue";

/** 两个 provider 的构造选项里原样转给队列的那组调参项。 */
export type MusicQueueTuning = Pick<
  UpstreamRequestQueueOptions,
  | "maxConcurrentRequests"
  | "minRequestIntervalMs"
  | "rateLimitCooldownMs"
  | "maxRateLimitCooldownMs"
  | "maxQueuedRequests"
  | "queueTimeoutMs"
  | "requestTimeoutMs"
>;

export interface MusicQueueSpec {
  now: () => number;
  random: { nextFloat?: () => number };
  tuning: MusicQueueTuning;
  /** 用户可见文案：本地排队过多、排队超时、请求运行超时与限流初始文案。 */
  messages: {
    queueFull: string;
    queueTimeout: string;
    requestTimeout: string;
    rateLimitFallback: string;
  };
  isRateLimitError: (error: unknown) => boolean;
  readRateLimitMessage: (error: unknown, fallback: string) => string;
  onRateLimitCooldown: (info: RateLimitCooldownInfo) => void;
  /** 限流错误里带的上游码；只有平台有固定限流码时才传。 */
  rateLimitUpstreamCode?: number;
}

/**
 * 按统一口径装配音乐上游队列：错误码与错误构造在这里收口，
 * 平台只提供文案、限流判定与退避时的附加处理。
 */
export const createMusicQueue = (spec: MusicQueueSpec): UpstreamRequestQueue =>
  new UpstreamRequestQueue({
    now: spec.now,
    random: spec.random,
    maxConcurrentRequests: spec.tuning.maxConcurrentRequests,
    minRequestIntervalMs: spec.tuning.minRequestIntervalMs,
    rateLimitCooldownMs: spec.tuning.rateLimitCooldownMs,
    maxRateLimitCooldownMs: spec.tuning.maxRateLimitCooldownMs,
    maxQueuedRequests: spec.tuning.maxQueuedRequests,
    queueTimeoutMs: spec.tuning.queueTimeoutMs,
    requestTimeoutMs: spec.tuning.requestTimeoutMs,
    queueFullMessage: spec.messages.queueFull,
    queueTimeoutMessage: spec.messages.queueTimeout,
    requestTimeoutMessage: spec.messages.requestTimeout,
    rateLimitFallbackMessage: spec.messages.rateLimitFallback,
    isRateLimitError: spec.isRateLimitError,
    readRateLimitMessage: spec.readRateLimitMessage,
    onRateLimitCooldown: spec.onRateLimitCooldown,
    createBusyError: (message, retryAfterMs) =>
      new AppError("MUSIC_API_BUSY", message, { retryAfterMs }),
    createRateLimitError: (message, retryAfterMs) =>
      new AppError("MUSIC_API_RATE_LIMITED", message, {
        ...(spec.rateLimitUpstreamCode !== undefined
          ? { upstreamCode: spec.rateLimitUpstreamCode }
          : {}),
        retryAfterMs,
      }),
    createTimeoutError: (message, timeoutMs) =>
      new AppError("MUSIC_API_TIMEOUT", message, { timeoutMs }),
  });
