import type { EventLogger } from "../../EventLogger";

export type ApiResponse = { body?: unknown } | unknown;
export type ApiFunction = (params: Record<string, unknown>) => Promise<ApiResponse>;
export type ApiModule = Record<string, unknown>;

export interface NeteaseMusicProviderOptions {
  loadApi?: () => Promise<ApiModule>;
  logger?: EventLogger;
  now?: () => number;
  random?: { nextFloat?: () => number };
  /** 网易云登录设备展示名称，默认 BakaGame。 */
  deviceName?: string;
  /** 通过 Enhanced API 的随机中国出口降低网易云安全风控误判。默认开启。 */
  randomCNIP?: boolean;
  /** 单个 provider 允许同时访问网易云的请求数。 */
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
  cacheMaxEntries?: number;
  cacheMaxBytes?: number;
  /** 是否开启全局音乐解灰，默认开启。针对无版权、VIP试听或无可用地址的歌曲自动尝试匹配跨平台可用音源。传函数则每次请求现读（运行期设置走这条）。 */
  enableGeneralUnblock?: boolean | (() => boolean);
  /** 单个解灰音源的最长等待，默认 4000ms；上游存在永不 settle 的请求，必须设上界。 */
  unblockSourceTimeoutMs?: number;
  /** 一次解灰尝试的总预算，默认 12000ms；用尽后不再换源。 */
  unblockTotalBudgetMs?: number;
  /** AMLL 独立于网易云风控队列；预算包含等待和搜索的两步请求。 */
  amllMaxConcurrentRequests?: number;
  amllMaxQueuedRequests?: number;
  amllRequestTimeoutMs?: number;
  amllFetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  /** 自定义 AMLL 官方 TTML 歌词检索实现（单元测试注入用）。 */
  fetchAmllLyrics?: (id: string) => Promise<string | undefined>;
  /** 自定义 AMLL 官方 TTML 歌曲名检索实现（单元测试注入用）。 */
  fetchAmllSearchLyrics?: (songName: string, artistName?: string) => Promise<string | undefined>;
}
