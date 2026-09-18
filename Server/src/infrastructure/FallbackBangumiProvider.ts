import type { AnimeAutoFilters, BangumiSubjectDetails, BangumiSubjectSearchResult } from "../shared/Index";
import type { BangumiDataProvider } from "./LocalBangumiProvider";

/**
 * 本地数据集降级后重新探测的冷却期。
 * 本地 sqlite 查询比网络回源快两个数量级（实测 p50 2ms vs 500~960ms），
 * 因此一次抖动绝不能把整个进程永久钉死在网络回源上；但也不能每次请求都重试本地
 * （超时型失败每次要等满 10s），所以用冷却期在两者之间取平衡。
 */
export const BANGUMI_LOCAL_RETRY_COOLDOWN_MS = 5 * 60_000;

/** 只需 warn 即可，避免为一个降级告警把基础设施日志器整体拖进来。 */
export interface BangumiFallbackLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface FallbackBangumiProviderOptions {
  local: BangumiDataProvider;
  remote: BangumiDataProvider;
  logger?: BangumiFallbackLogger;
  now?: () => number;
}

/**
 * 本地数据库不可用时自动切换到网络 API，并在冷却期后重新探测本地。
 *
 * 降级与恢复都必须留痕：这条链路只影响延迟不影响正确性，静默降级会让
 * 「查询慢了 250 倍」在生产上完全不可观测。
 */
export class FallbackBangumiProvider implements BangumiDataProvider {
  private readonly local: BangumiDataProvider;
  private readonly remote: BangumiDataProvider;
  private readonly logger?: BangumiFallbackLogger;
  private readonly now: () => number;
  /** 0 表示本地可用；非 0 表示降级到该时刻为止，到点后重新尝试本地。 */
  private localRetryAt = 0;

  constructor({ local, remote, logger, now = Date.now }: FallbackBangumiProviderOptions) {
    this.local = local;
    this.remote = remote;
    this.logger = logger;
    this.now = now;
  }

  searchSubjects(keyword: string, limit?: number, filters?: AnimeAutoFilters): Promise<BangumiSubjectSearchResult[]> {
    return this.run(() => this.local.searchSubjects(keyword, limit, filters), () => this.remote.searchSubjects(keyword, limit, filters));
  }

  getSubject(subjectId: string): Promise<BangumiSubjectDetails> {
    return this.run(() => this.local.getSubject(subjectId), () => this.remote.getSubject(subjectId));
  }

  chooseRandomSubject(filters?: AnimeAutoFilters, random?: () => number): Promise<BangumiSubjectDetails> {
    return this.run(() => this.local.chooseRandomSubject(filters, random), () => this.remote.chooseRandomSubject(filters, random));
  }

  resolveCharacterImage(characterId: number): Promise<string | undefined> {
    return this.run(() => this.local.resolveCharacterImage(characterId), () => this.remote.resolveCharacterImage(characterId));
  }

  async close(): Promise<void> {
    await Promise.all([
      typeof (this.local as unknown as { close?: () => unknown }).close === "function" ? (this.local as unknown as { close: () => unknown }).close() : undefined,
      typeof (this.remote as unknown as { close?: () => unknown }).close === "function" ? (this.remote as unknown as { close: () => unknown }).close() : undefined,
    ]);
  }

  private async run<T>(localCall: () => Promise<T>, remoteCall: () => Promise<T>): Promise<T> {
    if (this.now() < this.localRetryAt) return remoteCall();
    try {
      const value = await localCall();
      if (this.localRetryAt !== 0) {
        this.localRetryAt = 0;
        this.logger?.warn("Bangumi 本地数据集已恢复，改回本地查询");
      }
      return value;
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code !== "BANGUMI_DATA_UNAVAILABLE" && code !== "BANGUMI_QUERY_TIMEOUT") throw error;
      // 冷却期内的连续失败不重复告警，避免把真正的问题淹在日志里。
      if (this.localRetryAt === 0) {
        this.logger?.warn("Bangumi 本地数据集不可用，暂改网络回源", {
          code,
          retryInMs: BANGUMI_LOCAL_RETRY_COOLDOWN_MS,
        });
      }
      this.localRetryAt = this.now() + BANGUMI_LOCAL_RETRY_COOLDOWN_MS;
      return remoteCall();
    }
  }
}
