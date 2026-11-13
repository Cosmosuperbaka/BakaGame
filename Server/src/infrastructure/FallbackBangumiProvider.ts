import type {
  AnimeAutoFilters,
  BangumiSubjectDetails,
  BangumiSubjectSearchResult,
} from "../shared/Index";
import type { BangumiDataProvider } from "./BangumiDataProvider";

/**
 * 本地数据集降级后重新探测的冷却期。
 * 本地 sqlite 查询比网络回源快几个数量级，因此一次抖动绝不能把整个进程永久钉死在
 * 网络回源上；但也不能每次请求都重试本地（超时型失败每次要等满查询超时窗口），
 * 所以用冷却期在两者之间取平衡。
 */
export const BANGUMI_LOCAL_RETRY_COOLDOWN_MS = 5 * 60_000;

/**
 * 查询超时（区别于数据不可用）要在窗口内累计到这个次数才算本地真的出了问题：一次慢查询
 * 可能只是线程恰好被一次备份或批处理占着，不值得让整个进程转网络回源五分钟。
 * 窗口要比单次查询超时（20 秒）长得多，否则「连续两次」永远凑不齐。
 */
const TIMEOUT_DEGRADE_THRESHOLD = 2;
const TIMEOUT_WINDOW_MS = 60_000;

/** 只需 warn 即可，避免为一个降级告警把基础设施日志器整体拖进来。 */
export interface BangumiFallbackLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

/** 查询链路的现状，给后台状态页；计数只算本进程启动以来，重启清零。 */
export interface BangumiProviderStatus {
  mode: "local" | "remote";
  /** 冷却结束、下一次重新探测本地的时刻；走本地时为空。 */
  retryAt: number | null;
  degradedCount: number;
  lastDegradedAt: number | null;
  lastErrorCode: string | null;
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
 * 本地故障在生产上完全不可观测。
 */
export class FallbackBangumiProvider implements BangumiDataProvider {
  private readonly local: BangumiDataProvider;
  private readonly remote: BangumiDataProvider;
  private readonly logger?: BangumiFallbackLogger;
  private readonly now: () => number;
  /** 0 表示本地可用；非 0 表示降级到该时刻为止，到点后重新尝试本地。 */
  private localRetryAt = 0;
  private degradedCount = 0;
  private lastDegradedAt: number | null = null;
  private lastErrorCode: string | null = null;
  /** 窗口内的查询超时时刻。 */
  private recentTimeouts: number[] = [];

  constructor({ local, remote, logger, now = Date.now }: FallbackBangumiProviderOptions) {
    this.local = local;
    this.remote = remote;
    this.logger = logger;
    this.now = now;
  }

  searchSubjects(
    keyword: string,
    limit?: number,
    filters?: AnimeAutoFilters
  ): Promise<BangumiSubjectSearchResult[]> {
    return this.run(
      () => this.local.searchSubjects(keyword, limit, filters),
      () => this.remote.searchSubjects(keyword, limit, filters)
    );
  }

  getSubject(subjectId: string): Promise<BangumiSubjectDetails> {
    return this.run(
      () => this.local.getSubject(subjectId),
      () => this.remote.getSubject(subjectId)
    );
  }

  chooseRandomSubject(
    filters?: AnimeAutoFilters,
    random?: () => number
  ): Promise<BangumiSubjectDetails> {
    return this.run(
      () => this.local.chooseRandomSubject(filters, random),
      () => this.remote.chooseRandomSubject(filters, random)
    );
  }

  resolveCharacterImage(characterId: number): Promise<string | undefined> {
    return this.run(
      () => this.local.resolveCharacterImage(characterId),
      () => this.remote.resolveCharacterImage(characterId)
    );
  }

  resolveSubjectImage(subjectId: string): Promise<string | undefined> {
    return this.run(
      () => this.local.resolveSubjectImage(subjectId),
      () => this.remote.resolveSubjectImage(subjectId)
    );
  }

  status(): BangumiProviderStatus {
    return {
      mode: this.localRetryAt === 0 ? "local" : "remote",
      retryAt: this.localRetryAt === 0 ? null : this.localRetryAt,
      degradedCount: this.degradedCount,
      lastDegradedAt: this.lastDegradedAt,
      lastErrorCode: this.lastErrorCode,
    };
  }

  async close(): Promise<void> {
    await Promise.all([this.local.close?.(), this.remote.close?.()]);
  }

  private async run<T>(localCall: () => Promise<T>, remoteCall: () => Promise<T>): Promise<T> {
    if (this.now() < this.localRetryAt) return remoteCall();
    try {
      const value = await localCall();
      this.recentTimeouts = [];
      if (this.localRetryAt !== 0) {
        this.localRetryAt = 0;
        this.logger?.warn("Bangumi 本地数据集已恢复，改回本地查询");
      }
      return value;
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code !== "BANGUMI_DATA_UNAVAILABLE" && code !== "BANGUMI_QUERY_TIMEOUT") throw error;
      this.lastErrorCode = code ?? null;
      // 零星的单次超时只让本次请求走网络，不进入冷却。
      if (code === "BANGUMI_QUERY_TIMEOUT" && !this.timeoutsReachedThreshold()) return remoteCall();
      // 冷却期内的连续失败不重复告警，避免把真正的问题淹在日志里。
      if (this.localRetryAt === 0) {
        this.degradedCount += 1;
        this.lastDegradedAt = this.now();
        this.logger?.warn("Bangumi 本地数据集不可用，暂改网络回源", {
          code,
          retryInMs: BANGUMI_LOCAL_RETRY_COOLDOWN_MS,
        });
      }
      this.localRetryAt = this.now() + BANGUMI_LOCAL_RETRY_COOLDOWN_MS;
      return remoteCall();
    }
  }

  /** 记一次查询超时，并判断窗口内是否已累计到降级阈值。 */
  private timeoutsReachedThreshold(): boolean {
    const current = this.now();
    this.recentTimeouts = this.recentTimeouts.filter((at) => current - at < TIMEOUT_WINDOW_MS);
    this.recentTimeouts.push(current);
    return this.recentTimeouts.length >= TIMEOUT_DEGRADE_THRESHOLD;
  }
}
