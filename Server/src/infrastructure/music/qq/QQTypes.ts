import type { EventLogger } from "../../EventLogger";

export interface QQMusicProviderOptions {
  logger?: EventLogger;
  now?: () => number;
  /** 随机源（注入以便确定性测试）：限流退避抖动。 */
  random?: { nextFloat?: () => number };
  /** 单个 provider 允许同时访问 QQ 音乐上游的请求数（匿名请求另有独立并发位）。 */
  maxConcurrentRequests?: number;
  /** 两次上游请求启动之间的最小间隔。 */
  minRequestIntervalMs?: number;
  /** 首次遇到上游限流后的冷却时间；连续限流会指数增长。 */
  rateLimitCooldownMs?: number;
  maxRateLimitCooldownMs?: number;
  /** 等待队列的容量和最长停留时间，避免限流恢复后集中补发陈旧请求。 */
  maxQueuedRequests?: number;
  queueTimeoutMs?: number;
  /** 已开始执行的单个上游请求的运行时限，默认取公共常量。 */
  requestTimeoutMs?: number;
  /** 匿名请求单独限流，避免补充音源挤占已登录账号的并发位。 */
  anonymousMaxConcurrentRequests?: number;
  /** 匿名检索的等待上限；超时只影响这次补充，不阻塞另一侧音源。 */
  anonymousSearchTimeoutMs?: number;
  /** 匿名检索缓存时长；公共检索结果可以跨房间复用，压低上游请求量。 */
  anonymousSearchCacheTtlMs?: number;
  /** 公共缓存（检索 / 元数据）的条目数上限。 */
  cacheMaxEntries?: number;
  /** 公共缓存的字节总量上限。 */
  cacheMaxBytes?: number;
  /** AMLL 歌词缓存的条目数上限。 */
  amllCacheMaxEntries?: number;
  amllMaxConcurrentRequests?: number;
  amllMaxQueuedRequests?: number;
  amllRequestTimeoutMs?: number;
  amllFetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  fetchAmllLyrics?: (id: string) => Promise<string | undefined>;
  fetchAmllSearchLyrics?: (songName: string, artistName?: string) => Promise<string | undefined>;
}
