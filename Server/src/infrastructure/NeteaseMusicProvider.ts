import { AppError } from "../domain/Errors";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { LRUCache } from "lru-cache";
import PQueue from "p-queue";
import { parseYrc as amllParseYrc } from "@applemusic-like-lyrics/lyric";
import { describeError, type EventLogger } from "./EventLogger";
import { isCreditLyricLine, parseTTML, sanitizeLyrics } from "./LyricLines";
import { countServerMetric } from "./Sentry";
import type {
  SongDetails,
  SongAlbumSearchResult,
  SongArtistSearchResult,
  SonGuessrVipTier,
  SongEncyclopedia,
  SonGuessrMusicAccount,
  SongLyricLine,
  SongPlaylistInfo,
  SongSearchResult,
  SongChorus,
} from "../shared/Index";

type ApiResponse = { body?: unknown } | unknown;
type ApiFunction = (params: Record<string, unknown>) => Promise<ApiResponse>;
type ApiModule = Record<string, unknown>;

/**
 * 房间侧的取歌凭据有两种形状：只登录了一端时是裸字符串（`MUSIC_U=…`、`qm_keyst=…`），
 * 两端同时在房时是 `{ netease, qq }` 组合包，由聚合 provider 拆给各自上游。
 */
export type MusicCookieInput = string | Partial<Record<"netease" | "qq", string>>;

/** 把凭据窄化成组合包形态；裸字符串与非对象凭据都走 `false` 分支。 */
const isCookieRecord = (cookie: unknown): cookie is Record<string, unknown> =>
  typeof cookie === "object" && cookie !== null;

/**
 * 音乐上游适配层契约。实现有网易云、QQ 音乐与把两者合起来的聚合 provider。
 *
 * **每玩家配额隔离的前置条件由调用方承担，不在本接口的方法签名里。**
 * `NeteaseMusicProvider` 用 `musicIpScope`（一个 AsyncLocalStorage）给匿名请求按玩家分出口 IP
 * 与限流配额，作用域必须在**整条调用链的最外层**建立 —— 应用层的做法见
 * `SonGuessrService.execute`。从作用域外调用本接口的匿名请求不会失败，但会落到共享的
 * `anonymous` 出口、和所有同样无域的请求挤在同一份配额里（一人打满、全服 405）。
 * 这条降级现在是可观测的：每次调用计数，并按固定间隔补一条告警。
 * 有意使用共享出口的后台任务（预热、缓存维护）用 `runWithAnonymousMusicIpScope` 显式声明，
 * 那是设计如此而不是配置错误，不该混进告警。带房主凭证的请求不受影响：scope 由凭证决定。
 */
/** 音源平台。URN 前缀即平台名（见 `MusicUrn`）。 */
export type MusicPlatform = "netease" | "qq";

export interface MusicSearchOptions {
  /**
   * 池内至少有一个会员账号的平台。只有 QQ 用得上：会员专享曲目拿到非会员账号时
   * 取不到直链，结果需标「不可播放」；网易云走解灰兜底，不按会员档判可用性。
   */
  vipPlatforms?: readonly MusicPlatform[];
  /**
   * 共有曲目代表哪一侧的平台顺序。默认网易云先于 QQ；只有 QQ 账号的房间传入
   * `["qq", "netease"]`，避免把共有曲目默认归到本房没有直接凭据的一侧。
   */
  platformPreference?: readonly MusicPlatform[];
}

export interface MusicProvider {
  search(
    keyword: string,
    limit?: number,
    cookie?: MusicCookieInput,
    options?: MusicSearchOptions
  ): Promise<SongSearchResult[]>;
  /**
   * 取完整歌曲（含音频与歌词）。`allowFailover=false` 只允许解析本 ID 所属平台，
   * 供调用方按已知备用音源逐个尝试时避免每失败一次就重新按歌名跨平台搜索。
   */
  getSong(
    songId: string,
    cookie?: MusicCookieInput,
    options?: { allowFailover?: boolean }
  ): Promise<SongDetails>;
  refreshSongAudio?(songId: string, cookie?: MusicCookieInput): Promise<string>;
  getSongMetadata(songId: string, cookie?: MusicCookieInput): Promise<SongDetails>;
  getSongPopularity?(songId: string, cookie?: MusicCookieInput): Promise<number | undefined>;
  getSongChorus?(songId: string, cookie?: MusicCookieInput): Promise<SongChorus | undefined>;
  getAmllTtmlLyrics?(songId: string): Promise<string | undefined>;
  searchAmllTtmlLyrics?(songName: string, artistName?: string): Promise<string | undefined>;
  createQrLogin?(platform?: "netease" | "qq", type?: "qq" | "wx" | "mobile"): Promise<MusicQrLogin>;
  checkQrLogin?(
    key: string,
    platform?: "netease" | "qq",
    type?: "qq" | "wx" | "mobile"
  ): Promise<MusicQrLoginCheck>;
  getLoginStatus?(
    cookie: string,
    platform?: "netease" | "qq",
    options?: { forceRefresh?: boolean }
  ): Promise<MusicLoginSession>;
  uploadDeviceInfo?(cookie: string, deviceName?: string): Promise<boolean>;
  getPlaylistSongs?(
    playlistId: string,
    cookie?: MusicCookieInput
  ): Promise<{ info: SongPlaylistInfo; songs: SongSearchResult[] }>;
  searchArtists?(
    keyword: string,
    limit?: number,
    cookie?: MusicCookieInput,
    options?: MusicSearchOptions
  ): Promise<SongArtistSearchResult[]>;
  getArtistSongs?(artistId: string, cookie?: MusicCookieInput): Promise<SongSearchResult[]>;
  /** 按关键词检索专辑（供「专辑型 Bangumi 条目」取曲目用，见 `SongAlbumSearchResult`）。 */
  searchAlbums?(
    keyword: string,
    limit?: number,
    cookie?: MusicCookieInput,
    options?: MusicSearchOptions
  ): Promise<SongAlbumSearchResult[]>;
  /** 取整张专辑的曲目。 */
  getAlbumSongs?(albumId: string, cookie?: MusicCookieInput): Promise<SongSearchResult[]>;
}

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

export interface MusicLoginSession {
  cookie: string;
  account: SonGuessrMusicAccount;
}

export interface MusicQrLogin {
  key: string;
  qrUrl: string;
  qrImage: string;
}

export interface MusicQrLoginCheck {
  status: "waiting" | "scanned" | "expired" | "authorized";
  message: string;
  session?: MusicLoginSession;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

// 对象键序无关的稳定序列化：用于把 cookie 对象映射成稳定的 IP scope，
// 避免 JSON.stringify 受插入顺序影响导致同一登录态算出不同 IP。
const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
};

const readString = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
};

const readNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

type ChinaIpRange = { start: number; end: number; count: number };

// 中国 IP 段真相源复用 Enhanced API 包内 `data/china_ip_ranges.txt`（4147 条 CIDR）。
// 早前自写的 `116.25-94.x.x` 随机拼接并不保证落在真实 CN 网段，网易云按出口 IP
// 绑定登录态时会因此判定为异地登录，是「设备还在但凭证失效」的根因之一。
// 这里刻意绕开包内 `util/index.js`，因为它会在模块加载时连带引入其 `logger`，
// 每次生成都会向 stdout 打印带 ANSI 色的 [INFO] 行，污染本项目的结构化日志。
const CHINA_IP_CIDR_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

// CN IP 段数据来自依赖包。**不能写死 `../../node_modules/...`**：本仓库是 pnpm
// workspace，依赖会提升到仓库根（`<root>/node_modules`），Server 下并不存在
// `Server/node_modules`，写死路径会让 parseChinaIpRanges 静默拿到空串，
// 随机出口 IP 退化成兜底单段。这里走 Node 的模块解析，两种安装布局都能命中
// （独立安装时命中 Server/node_modules，workspace 提升时命中根 node_modules）。
const requireFromHere = createRequire(import.meta.url);
const chinaIpRangeFile = (): string => {
  const packageFile = requireFromHere.resolve("@neteasecloudmusicapienhanced/api/package.json");
  return resolve(dirname(packageFile), "data/china_ip_ranges.txt");
};

export const parseChinaIpRanges = (content: string): ChinaIpRange[] => {
  const ranges: ChinaIpRange[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const matched = CHINA_IP_CIDR_PATTERN.exec(line);
    if (!matched) continue;
    const octets = matched.slice(1, 5).map(Number);
    if (octets.some((octet) => octet > 255)) continue;
    const prefix = Number(matched[5]);
    if (prefix > 32) continue;
    const base = octets.reduce((acc, octet) => (acc << 8) + octet, 0) >>> 0;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const start = (base & mask) >>> 0;
    const end = (start | (~mask >>> 0)) >>> 0;
    ranges.push({ start, end, count: end - start + 1 });
  }
  return ranges;
};

const intToIp = (value: number): string =>
  [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(".");

export const readChinaIpRanges = (): ChinaIpRange[] => {
  try {
    const path = chinaIpRangeFile();
    return existsSync(path) ? parseChinaIpRanges(readFileSync(path, "utf8")) : [];
  } catch {
    return [];
  }
};

// 兜底：仅在 CN IP 段数据缺失/损坏时生效，保证不至于完全无法出网。
const FALLBACK_CHINA_IP_RANGES: ChinaIpRange[] = [
  { start: 0x74000000, end: 0x74ffffff, count: 0x1000000 }, // 116.0.0.0/8
];

// 生成落在真实 CN 网段内的随机 IP；random 可注入以便确定性测试。
export const randomChineseIp = (
  ranges: readonly ChinaIpRange[],
  random?: { nextFloat?: () => number }
): string => {
  const rand = random?.nextFloat ?? Math.random;
  const usable = ranges.length > 0 ? ranges : FALLBACK_CHINA_IP_RANGES;
  const total = usable.reduce((sum, range) => sum + range.count, 0);
  let offset = Math.floor(rand() * total);
  let chosen = usable[usable.length - 1];
  for (const range of usable) {
    if (offset < range.count) {
      chosen = range;
      break;
    }
    offset -= range.count;
  }
  return intToIp((chosen.start + Math.floor(rand() * chosen.count)) >>> 0);
};

/** 二维码会话的有效期：开完不扫的会话超过这个时长就丢弃，避免分桶无限堆积。 */
const QR_LOGIN_SCOPE_TTL_MS = 10 * 60_000;
const SEARCH_CACHE_TTL_MS = 6 * 60 * 60_000;
const SONG_METADATA_CACHE_TTL_MS = 24 * 60 * 60_000;
const SONG_LYRICS_CACHE_TTL_MS = 24 * 60 * 60_000;
const SONG_WIKI_CACHE_TTL_MS = 3 * 24 * 60 * 60_000;
const COLLECTION_CACHE_TTL_MS = 6 * 60 * 60_000;
/** 歌单单页曲目上限：`playlist_track_all` 的 limit 上限就是 1000。 */
const PLAYLIST_PAGE_SIZE = 1000;
/**
 * 歌单翻页硬上限（50000 首）。正常歌单远达不到，仅作兜底：
 * 上游对超范围 offset 若仍返回整页，没有上界就会一直翻下去。
 */
const PLAYLIST_MAX_PAGES = 50;
const ARTIST_SONGS_CACHE_TTL_MS = 24 * 60 * 60_000;
const POPULARITY_CACHE_TTL_MS = 6 * 60 * 60_000;
const SONG_CHORUS_CACHE_TTL_MS = 3 * 24 * 60 * 60_000;
const AUDIO_URL_CACHE_TTL_MS = 10 * 60_000;
const DEFAULT_CACHE_MAX_ENTRIES = 512;
const DEFAULT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 3;
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 100;
/**
 * 限流退避起点。实测网易云的限流窗口是**分钟级**（生产日志中的恢复点 179s / 231s / 237s / 1452s），
 * 而 5 秒起步会让「冷却一结束就重试」变成撞墙循环：strikes=1 之后 5.2~7.0s 就升到 2 级，
 * 20 秒内把冷却推到 60 秒 —— 本意是止损，实际把一次限流放大成近一分钟的全服不可用。
 * 起点直接对齐实测窗口下界。
 */
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
/** 退避上限：覆盖实测最长恢复窗口的一半以上，避免长限流期间被反复唤醒、等级空转。 */
const DEFAULT_MAX_RATE_LIMIT_COOLDOWN_MS = 600_000;
const DEFAULT_MAX_QUEUED_REQUESTS = 64;
const DEFAULT_QUEUE_TIMEOUT_MS = 8_000;
/**
 * 网易云「操作频繁」的响应码集合。
 *
 * - `405` 歌曲类接口的通用限流；
 * - `406` **登录链路限流**：实测 `login_qr_key` 第 20 次触发，文案与 405 完全一致
 *   （「操作频繁，请稍候再试」）。只认 405 会漏判整条扫码链路 —— 表现为房主扫码时
 *   一直撞墙、既不退避也不提示。
 * - `429` / `503` 同一语义的其它表现形式（文档记录 503 即「IP 高频错误」）。
 *
 * 判定必须同时覆盖 `body.code` 与 HTTP status：Enhanced API 的不同端点可能 resolve 一个
 * 带 code 的 body，也可能 reject 一个带 status 的错误。
 */
const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([405, 406, 429, 503]);

const isRateLimitCode = (code: number | undefined) =>
  code !== undefined && RATE_LIMIT_CODES.has(code);

/**
 * 不该继续尝试后备端点的「全局性失败」。
 *
 * 这两种错误与具体端点无关：换一个兼容接口再排一次队，要么同样被上游拒绝，
 * 要么只是把本地队列堵得更久。只有其余失败（端点缺失、参数不被接受等）才值得换端点重试。
 */
const NON_RETRYABLE_API_ERROR_CODES: ReadonlySet<string> = new Set([
  "MUSIC_API_RATE_LIMITED",
  "MUSIC_API_BUSY",
]);

/**
 * 玩家级 IP 归属。
 *
 * 匿名请求没有 cookie 可以区分身份，历史上全部落在同一个 `"anonymous"` scope 上，
 * 于是所有玩家的请求共享同一个伪装 IP、也就共享同一份限流配额 —— 一个人把配额打满，
 * 全服跟着 405（生产日志里 48 分钟 2527 次搜索正是这么累积出来的）。
 *
 * 应用层在处理每条 WS 命令时把连接标识放进这个作用域，这里就能让不同玩家的匿名请求
 * 各自持有独立 IP。用 `AsyncLocalStorage` 而不是给十几个 provider 方法加参数：
 * 调用链很深（execute → search/getSong/getPlaylistSongs → call → scheduleRequest），
 * 逐个透传签名会把「玩家身份」这一件事扩散到每一层。
 */
export const musicIpScope = new AsyncLocalStorage<string>();

/** 匿名（无 cookie、且不在玩家作用域内）请求的 IP 归属，主要覆盖预热与后台任务。 */
const IP_SCOPE_ANONYMOUS = "anonymous";

/**
 * 显式声明「本次调用属于后台任务，按共享匿名出口工作」。
 *
 * 与「忘记包作用域」区分开是有意为之：后者是一条新调用链的配置错误，要靠告警暴露；
 * 前者是设计如此（预热、缓存维护没有玩家上下文），不该占用同一条告警的额度。
 */
export const runWithAnonymousMusicIpScope = <T>(task: () => Promise<T>): Promise<T> =>
  musicIpScope.run(IP_SCOPE_ANONYMOUS, task);

/**
 * 伪装出口 IP 的缓存上限。
 *
 * 每个玩家一个 scope，房间多、进出频繁时条目会持续增长；超限按插入顺序淘汰最老的。
 * 256 足以覆盖同时在线规模，被淘汰的玩家下次请求重新分配一个 IP 即可（无正确性影响）。
 */
const IP_SCOPE_MAX_ENTRIES = 256;

/**
 * 「缺少玩家作用域」这条降级的告警最小间隔。
 *
 * 满载时每条匿名请求都会命中它，逐条 warn 会把日志刷成噪声、反而盖掉真正的故障；
 * 口径与服务端采集链路的故障上报一致：每一次都计数，聚合告警按间隔限频。
 */
const IP_SCOPE_FALLBACK_WARN_INTERVAL_MS = 60_000;
/** 无域调用次数指标：告警限频之后仍然能看出「这条链路一直在降级」。 */
const IP_SCOPE_FALLBACK_METRIC = "bakagame.music.ip_scope_fallback";
/**
 * 登录态校验结果的复用窗口。
 *
 * 房间接入（`song.auth.useCookie`）与开局复验都要读同一份账号状态，而玩家反复进出房间时
 * 凭据并没有变化。网易云文档明确要求登录成功后复用凭据、不要高频重复调用登录接口，
 * 因此成功校验的结果在短时间内复用；校验失败不入缓存，下一次请求照常回源。
 */
const LOGIN_STATUS_REUSE_TTL_MS = 60_000;
/** 登录态复用缓存的条目上限；每个玩家一份，超出按 LRU 淘汰。 */
const LOGIN_STATUS_CACHE_MAX_ENTRIES = 64;

/**
 * 解灰音源优先级。包内 `matchID` 不传 `source` 时按 modules 目录的字母序尝试，`bugpk` 恰好排在最前，
 * 而它对没有自有音源的歌曲会返回网易云官方灰链兜底（`/song/media/outer/url`）：字符串非空所以被当成
 * 「解灰成功」，实际播放器只会拿到下载页 HTML，还会短路掉后面真正可用的音源。
 * 这里显式指定顺序：实测可用的多平台音源 `unm` 放最前，其余快速失败的放中间，慢且易伪解灰的 `bugpk` 压到最后。
 */
const UNBLOCK_SOURCE_ORDER = [
  "unm",
  "ddyr",
  "gdmusic",
  "byfuns",
  "msls",
  "oi",
  "qijieya",
  "bugpk",
] as const;
/** 单个解灰音源的最长等待。 */
const DEFAULT_UNBLOCK_SOURCE_TIMEOUT_MS = 4_000;
/** 一次解灰尝试的总预算；用尽后不再换源，直接判定解灰失败。 */
const DEFAULT_UNBLOCK_TOTAL_BUDGET_MS = 12_000;

/**
 * 给上游 Promise 加一个上界。
 *
 * 解灰音源（尤其第三方聚合站）存在「请求被丢弃、返回的 Promise 永不 settle」的情况（实测约每 5~10 次一遇）。
 * 一旦在 `await` 上无限等待，自动出题会永久停在 `automaticRoundLoading`：房间再也开不了下一轮，
 * 客户端因为对长任务发的是 `timeout: 0`，连超时提示都没有，只会一直显示「出题中」。
 *
 * 必须同时给原 Promise 挂上 `catch`：它在超时之后才拒绝时，若没有处理器就会变成
 * unhandledRejection —— Bun 会直接终止整个进程（实测 exit=1）。
 */
const settleWithin = async <T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

type CacheEntry = {
  value: unknown;
  softExpireAt: number;
  hardExpireAt: number;
  lastAccessAt: number;
  hits: number;
  priority: number;
  size: number;
};

const cloneCacheValue = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

const normalizeHttpsUrl = (value: unknown): string | undefined => {
  const raw = readString(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    // 网易云接口仍可能返回 HTTP 图片或音频；HTTPS 页面会将其作为混合内容直接拦截或告警。
    if (url.protocol === "http:") url.protocol = "https:";
    return url.toString();
  } catch {
    return raw.startsWith("http://") ? `https://${raw.slice(7)}` : raw;
  }
};

const normalizeAudioUrl = normalizeHttpsUrl;

/**
 * 识别「伪解灰」：解灰结果指回网易云官方外链 `/song/media/outer/url`。
 * 该外链只对未受限歌曲有效，受限歌曲会 302 到下载页 HTML（`content-type: text/html`），
 * 播放器必然报错。解灰只在官方明确受限（无地址 / 试听片段 / 404）时才触发，
 * 因此在这个语境下拿到该形态一律视为解灰失败，应继续尝试下一个音源，不得写入缓存或广播。
 */
const isNeteaseFallbackUrl = (raw: string): boolean => {
  try {
    const url = new URL(raw);
    if (url.hostname !== "music.163.com") return false;
    return url.pathname.startsWith("/song/media/outer/url");
  } catch {
    return false;
  }
};

const responseBody = (response: ApiResponse): Record<string, unknown> => {
  const record = asRecord(response);
  return asRecord("body" in record ? record.body : response);
};

const responseCookie = (response: ApiResponse): string | undefined => {
  const record = asRecord(response);
  const body = responseBody(response);
  const bodyCookie = readString(body.cookie);
  if (bodyCookie) return bodyCookie;
  const cookies = asArray(record.cookie)
    .map(readString)
    .filter((entry): entry is string => Boolean(entry));
  return cookies.length > 0 ? cookies.join(";") : undefined;
};

const responseCode = (body: Record<string, unknown>): number | undefined => {
  const direct = readNumber(body.code);
  if (direct !== undefined) return direct;
  return readNumber(asRecord(body.data).code);
};

const responseMessage = (body: Record<string, unknown>, fallback: string) =>
  readString(body.message ?? body.msg) ??
  readString(asRecord(body.data).message ?? asRecord(body.data).msg) ??
  fallback;

const musicLoginError = (body: Record<string, unknown>, fallback: string) => {
  const code = responseCode(body);
  const risk = code === 8810 || code === 10004;
  return new AppError(
    risk ? "MUSIC_LOGIN_RISK" : "MUSIC_LOGIN_FAILED",
    risk ? "网易云已拦截当前网络环境的登录请求，请稍后重试" : responseMessage(body, fallback),
    { upstreamCode: code }
  );
};

const readLoginAccount = (body: Record<string, unknown>): SonGuessrMusicAccount => {
  const data = asRecord(dataRecord(body));
  const profile = asRecord(body.profile ?? data.profile);
  const nickname = readString(profile.nickname) ?? "网易云用户";
  return {
    userId: readString(profile.userId ?? profile.id),
    nickname,
    avatarUrl: normalizeHttpsUrl(profile.avatarUrl ?? profile.avatar),
  };
};

const dataRecord = (body: Record<string, unknown>) => asRecord(body.data);

const readVipAccount = (
  raw: unknown,
  account: SonGuessrMusicAccount,
  now = Date.now()
): SonGuessrMusicAccount => {
  const body = asRecord(raw);
  const data = asRecord(body.data ?? raw);
  const memberships = [
    asRecord(data.associator),
    asRecord(data.musicPackage),
    asRecord(data.redplus),
    asRecord(data.albumVip),
  ];
  const active = memberships.filter((membership) => {
    const code = readNumber(membership.vipCode ?? membership.vipType ?? membership.code) ?? 0;
    const expireTime = readNumber(membership.expireTime ?? membership.expire ?? membership.endTime);
    return code > 0 && (expireTime === undefined || expireTime > now);
  });
  const vipType = active
    .map((membership) => readNumber(membership.vipCode ?? membership.vipType ?? membership.code))
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => right - left)[0];
  const vipExpireTime = active
    .map((membership) =>
      readNumber(membership.expireTime ?? membership.expire ?? membership.endTime)
    )
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => right - left)[0];
  // 展示档位按网易云客户端的优先级取：超级黑胶 > 黑胶 > 音乐包，到期时间跟着这一档走。
  const tiers: Array<[SonGuessrVipTier, Record<string, unknown>]> = [
    ["svip", asRecord(data.redplus)],
    ["vip", asRecord(data.associator)],
    ["musicPackage", asRecord(data.musicPackage)],
  ];
  const shown = tiers.find(([, membership]) => active.includes(membership));
  const level = readNumber(data.redVipLevel);
  const tierFields: Partial<SonGuessrMusicAccount> = shown
    ? {
        vipTier: shown[0],
        vipExpireTime:
          readNumber(shown[1].expireTime ?? shown[1].expire ?? shown[1].endTime) ?? vipExpireTime,
        ...(shown[0] !== "musicPackage" &&
        level !== undefined &&
        Number.isInteger(level) &&
        level >= 1
          ? { vipLevel: Math.min(level, 7) }
          : {}),
      }
    : {};
  return {
    ...account,
    vipStatus: active.length > 0 ? "vip" : "nonVip",
    vipType,
    vipExpireTime,
    ...tierFields,
  };
};

const artistNames = (song: Record<string, unknown>): string => {
  const artists = asArray(song.ar ?? song.artists ?? song.artist);
  const names = artists
    .map((entry) => readString(asRecord(entry).name) ?? readString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return names.join(" / ") || "未知歌手";
};

const normalizeSong = (value: unknown): SongSearchResult | undefined => {
  const song = asRecord(value);
  const id = readString(song.id);
  const title = readString(song.name ?? song.title);
  if (!id || !title) return undefined;

  const album = asRecord(song.al ?? song.album);
  const privilege = asRecord(song.privilege);
  const fee = readNumber(song.fee ?? privilege.fee);
  // 版本关系（1=原唱 / 2=翻唱）只有详情接口稳定返回，检索结果里通常缺席。
  // 必须原样带出去：它是「原版优先」排序在验证阶段唯一能用的硬信号。
  const originCover = asRecord(song.originSongSimpleData);
  return {
    id,
    title,
    artist: artistNames(song),
    album: readString(album.name),
    pictureUrl: normalizeHttpsUrl(album.picUrl ?? album.pic),
    durationMs: readNumber(song.dt ?? song.duration),
    requiresVip: fee === 1,
    originCoverType: readNumber(song.originCoverType),
    originSongId: readString(originCover.songId),
  };
};

export const parseLrc = (raw: string): SongLyricLine[] => {
  const lines: Array<Omit<SongLyricLine, "endTime">> = [];
  const timePattern = /\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g;

  for (const sourceLine of raw.split(/\r?\n/)) {
    const timestamps = [...sourceLine.matchAll(timePattern)];
    const text = sourceLine.replace(timePattern, "").trim();
    if (!text || timestamps.length === 0) continue;

    for (const timestamp of timestamps) {
      const minutes = Number(timestamp[1]);
      const seconds = Number(timestamp[2]);
      const milliseconds = Number((timestamp[3] ?? "0").padEnd(3, "0"));
      lines.push({
        time: minutes * 60_000 + seconds * 1_000 + milliseconds,
        text,
      });
    }
  }

  lines.sort((left, right) => left.time - right.time);
  return lines.map((line, index) => ({
    ...line,
    endTime: lines[index + 1]?.time ?? line.time + 5_000,
  }));
};

export const parseYrc = (raw: string): SongLyricLine[] => {
  const amllLines = amllParseYrc(raw);
  return amllLines
    .map((line) => {
      const text =
        line.words && line.words.length > 0
          ? line.words
              .map((w) => w.word)
              .join("")
              .trim()
          : "";
      const hasTranslation = Boolean(line.translatedLyric);
      return {
        time: line.startTime,
        endTime: line.endTime,
        text,
        words:
          line.words && line.words.length > 0
            ? line.words.map((w) => ({
                startTime: w.startTime,
                endTime: w.endTime,
                word: w.word,
                romanWord: hasTranslation ? undefined : w.romanWord || undefined,
              }))
            : undefined,
        translatedLyric: line.translatedLyric || undefined,
        romanLyric: hasTranslation ? undefined : line.romanLyric || undefined,
        isBG: line.isBG || undefined,
        isDuet: line.isDuet || undefined,
      };
    })
    .filter((line) => line.text.length > 0);
};

const pickNearestLyric = (candidates: SongLyricLine[], time: number): string | undefined => {
  let best: SongLyricLine | undefined;
  let minDiff = 1500;
  for (const candidate of candidates) {
    const diff = Math.abs(candidate.time - time);
    if (diff >= minDiff) continue;
    minDiff = diff;
    best = candidate;
  }
  return best?.text.trim() || undefined;
};

/**
 * 将外文歌曲的翻译与音译歌词合并到主歌词行中。
 * 支持依据时间戳误差 <= 1500ms 智能就近匹配。
 * 规范铁律：当歌词具备翻译时，彻底清空注音（romanLyric 与 words.romanWord），仅呈现翻译。
 */
export const mergeTranslations = (
  lines: SongLyricLine[],
  translationRaw?: string,
  romanRaw?: string
): SongLyricLine[] => {
  if (!translationRaw && !romanRaw) return lines;

  const transLines = translationRaw
    ? parseLrc(translationRaw).filter((l) => !isCreditLyricLine(l.text))
    : [];
  const romanLines = romanRaw ? parseLrc(romanRaw).filter((l) => !isCreditLyricLine(l.text)) : [];

  if (transLines.length === 0 && romanLines.length === 0) return lines;

  return lines.map((line) => {
    let translatedLyric = line.translatedLyric;
    let romanLyric = line.romanLyric;

    if (!translatedLyric && transLines.length > 0) {
      translatedLyric = pickNearestLyric(transLines, line.time);
    }

    if (!romanLyric && romanLines.length > 0) {
      romanLyric = pickNearestLyric(romanLines, line.time);
    }

    // 核心规范：当行存在翻译时，屏蔽注音（仅显示翻译）
    if (translatedLyric) {
      romanLyric = undefined;
    }

    const words = line.words?.map((w) => ({
      ...w,
      romanWord: translatedLyric ? undefined : w.romanWord,
    }));

    return {
      ...line,
      words: words || line.words,
      translatedLyric: translatedLyric || undefined,
      romanLyric: romanLyric || undefined,
    };
  });
};

const readWiki = (raw: unknown): SongEncyclopedia & { language?: string } => {
  const tags = new Set<string>();
  const aliases = new Set<string>();
  let summary: string | undefined;
  let language: string | undefined;

  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    const record = asRecord(value);
    if (Object.keys(record).length === 0) return;

    const title = readString(record.title ?? record.name ?? record.key)?.toLowerCase();
    const content = readString(record.content ?? record.text ?? record.value);
    if (title && content) {
      if (title.includes("语种") || title.includes("语言") || title.includes("language")) {
        language = content;
      } else if (title.includes("别名") || title.includes("alias")) {
        content
          .split(/[、,，/]/)
          .map((item) => item.trim())
          .filter(Boolean)
          .forEach((item) => aliases.add(item));
      } else if (
        title.includes("曲风") ||
        title.includes("流派") ||
        title.includes("标签") ||
        title.includes("genre") ||
        title.includes("tag")
      ) {
        content
          .split(/[、,，/]/)
          .map((item) => item.trim())
          .filter(Boolean)
          .forEach((item) => tags.add(item));
      } else if (
        !summary &&
        (title.includes("简介") || title.includes("介绍") || title.includes("summary"))
      ) {
        summary = content;
      }
    }

    const metaList = asArray(record.wikiSubMetaVos ?? record.tags);
    metaList.forEach((entry) => {
      const text = readString(asRecord(entry).text ?? asRecord(entry).name ?? entry);
      if (text && !isCreditLyricLine(text)) tags.add(text);
    });

    Object.values(record).forEach(visit);
  };

  visit(raw);
  return {
    summary,
    aliases: aliases.size ? [...aliases] : undefined,
    tags: [...tags],
    language,
  };
};

/** 四级歌词优先链共享的输入：本曲元数据、各级原文与其译文、音译。 */
type LyricChainInput = {
  id: string;
  song: SongSearchResult;
  yrc?: string;
  lrc?: string;
  yrcTrans?: string;
  yrcRoma?: string;
  lrcTrans?: string;
  lrcRoma?: string;
};

/**
 * 读出歌词响应里的原文字段。
 *
 * 译文与音译各有两个来源（ytlrc 与 tlyric、yromalrc 与 romalrc）：逐字歌词优先 y 开头的
 * 那份，行级歌词优先普通那份，两边互为备选。
 */
const readLyricSources = (
  id: string,
  song: SongSearchResult,
  lyricBody: Record<string, unknown>
): LyricChainInput => {
  const ytlrcRaw = readString(asRecord(lyricBody.ytlrc).lyric);
  const tlyricRaw = readString(asRecord(lyricBody.tlyric).lyric);
  const yromalrcRaw = readString(asRecord(lyricBody.yromalrc).lyric);
  const romalrcRaw = readString(asRecord(lyricBody.romalrc).lyric);

  return {
    id,
    song,
    yrc: readString(asRecord(lyricBody.yrc).lyric),
    lrc: readString(asRecord(lyricBody.lrc).lyric),
    yrcTrans: ytlrcRaw || tlyricRaw,
    yrcRoma: yromalrcRaw || romalrcRaw,
    lrcTrans: tlyricRaw || ytlrcRaw,
    lrcRoma: romalrcRaw || yromalrcRaw,
  };
};

/** 逐字歌词只有真的带 `words` 时间轴才算命中，否则继续降级到下一优先级。 */
const adoptVerbatimLyrics = (
  parsed: SongLyricLine[],
  input: LyricChainInput
): SongLyricLine[] | undefined =>
  parsed.length > 0 && parsed.some((line) => line.words && line.words.length > 0)
    ? sanitizeLyrics(mergeTranslations(parsed, input.yrcTrans, input.yrcRoma), input.song)
    : undefined;

export class NeteaseMusicProvider implements MusicProvider {
  private apiPromise?: Promise<ApiModule>;
  private readonly randomCNIP: boolean;
  private anonymousCookie?: string;
  private readonly cache: LRUCache<string, CacheEntry>;
  private readonly loginStatusCache: LRUCache<string, MusicLoginSession>;
  private readonly refreshers = new Map<
    string,
    { ttlMs: number; loader: () => Promise<unknown> }
  >();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly ipByScope = new Map<string, string>();
  private readonly chinaIpRanges = readChinaIpRanges();
  // 扫码登录是一次多条请求的会话：二维码创建、轮询、设备上报、状态校验必须共用同一个出口 IP。
  // 网易云把登录凭证绑定在登录时的客户端 IP 上，会话中途换 IP 会直接导致刚拿到的 MUSIC_U 失效。
  //
  // 必须按「二维码 unikey」分桶，不能是单个字段：两个房间的房主在相近时间扫码时，
  // 后发起者会覆盖前者，于是先完成的那位拿到的是别人的会话 IP（永久错绑），
  // 后完成的那位则压根没绑上登录握手时的 IP。
  private readonly qrLoginScopes = new Map<string, { scope: string; createdAt: number }>();
  private readonly amllQueue: PQueue;
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
  private lastRateLimitMessage = "操作频繁，请稍候再试";
  // 首条「缺少玩家作用域」告警必须在第一次降级时就发出，所以初值设为「早就过期的间隔之前」。
  private lastIpScopeFallbackWarnAt = Number.NEGATIVE_INFINITY;

  readonly deviceName: string;
  private readonly generalUnblockEnabled: () => boolean;
  /**
   * 现读解灰开关，并把结果同步回 `process.env.ENABLE_GENERAL_UNBLOCK`：
   * 上游封装库读的是那一份，不同步的话后台改了这里、上游那边仍按旧值走。
   */
  private readonly readGeneralUnblock = (): boolean => {
    const enabled = this.generalUnblockEnabled();
    if (
      typeof process !== "undefined" &&
      process.env &&
      process.env.ENABLE_GENERAL_UNBLOCK !== String(enabled)
    ) {
      process.env.ENABLE_GENERAL_UNBLOCK = String(enabled);
    }
    return enabled;
  };
  private readonly logger?: EventLogger;
  private readonly now: () => number;
  private readonly random: { nextFloat?: () => number };
  private readonly maintenanceTimer: ReturnType<typeof setInterval>;
  private lastUserRequestAt: number;

  constructor(private readonly options: NeteaseMusicProviderOptions = {}) {
    this.amllQueue = new PQueue({
      concurrency: Math.max(1, options.amllMaxConcurrentRequests ?? 3),
    });
    this.deviceName = options.deviceName?.trim() || "BakaGame";
    const unblockOption = options.enableGeneralUnblock;
    this.generalUnblockEnabled =
      typeof unblockOption === "function"
        ? unblockOption
        : () =>
            unblockOption ??
            (typeof process !== "undefined" && process.env?.ENABLE_GENERAL_UNBLOCK !== undefined
              ? process.env.ENABLE_GENERAL_UNBLOCK === "true"
              : true);
    this.readGeneralUnblock();
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? { nextFloat: () => Math.random() };
    this.lastUserRequestAt = this.now();
    this.randomCNIP = options.randomCNIP ?? true;
    this.cache = new LRUCache<string, CacheEntry>({
      max: Math.max(1, options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES),
      maxSize: Math.max(1, options.cacheMaxBytes ?? DEFAULT_CACHE_MAX_BYTES),
      sizeCalculation: (entry) => entry.size,
    });
    this.loginStatusCache = new LRUCache<string, MusicLoginSession>({
      max: LOGIN_STATUS_CACHE_MAX_ENTRIES,
      ttl: LOGIN_STATUS_REUSE_TTL_MS,
    });
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
    this.queue = new PQueue({
      concurrency: this.maxConcurrentRequests,
      ...(this.minRequestIntervalMs > 0
        ? { interval: this.minRequestIntervalMs, intervalCap: 1 }
        : {}),
    });
    this.maintenanceTimer = setInterval(() => {
      void this.runCacheMaintenance();
    }, 60_000);
    (this.maintenanceTimer as unknown as { unref?: () => void }).unref?.();
  }

  async search(
    keyword: string,
    limit = 20,
    cookie?: MusicCookieInput
  ): Promise<SongSearchResult[]> {
    const normalized = keyword.trim();
    if (!normalized) return [];
    const normalizedLimit = Math.max(1, Math.min(limit, 50));
    return this.cached(
      this.cacheKey("search", cookie, normalized.toLocaleLowerCase(), normalizedLimit),
      SEARCH_CACHE_TTL_MS,
      async () => {
        const response = await this.call(
          ["cloudsearch", "search"],
          {
            keywords: normalized,
            limit: normalizedLimit,
            type: 1,
          },
          cookie
        );
        const body = responseBody(response);
        const result = asRecord(body.result);
        return asArray(result.songs)
          .map(normalizeSong)
          .filter((song): song is SongSearchResult => Boolean(song));
      }
    );
  }

  async getSong(songId: string, cookie?: MusicCookieInput): Promise<SongDetails> {
    const id = songId.trim();
    if (!id) throw new AppError("INVALID_SONG", "歌曲 ID 不能为空");
    return this.loadSong(id, true, cookie);
  }

  async refreshSongAudio(songId: string, cookie?: MusicCookieInput): Promise<string> {
    const id = songId.trim();
    if (!id) throw new AppError("INVALID_SONG", "歌曲 ID 不能为空");
    const key = this.cacheKey("audio", cookie, id);
    this.cache.delete(key);
    this.refreshers.delete(key);
    return this.loadAudioUrl(id, cookie, true);
  }

  async getSongMetadata(songId: string, cookie?: MusicCookieInput): Promise<SongDetails> {
    const id = songId.trim();
    if (!id) throw new AppError("INVALID_SONG", "歌曲 ID 不能为空");
    return this.cached(this.cacheKey("metadata", undefined, id), SONG_METADATA_CACHE_TTL_MS, () =>
      this.loadSong(id, false, cookie)
    );
  }

  async getSongPopularity(songId: string, cookie?: MusicCookieInput): Promise<number | undefined> {
    const id = songId.trim();
    if (!id) return undefined;
    return this.cached(
      this.cacheKey("popularity", undefined, id),
      POPULARITY_CACHE_TTL_MS,
      async () => {
        const response = await this.callOptional(["song_red_count"], { id }, cookie);
        if (!response) return undefined;
        const body = responseBody(response);
        const data = asRecord(body.data);
        return readNumber(data.count ?? body.count);
      }
    );
  }

  async getSongChorus(songId: string, cookie?: MusicCookieInput): Promise<SongChorus | undefined> {
    const id = songId.trim();
    if (!id) return undefined;
    return this.cached(
      this.cacheKey("song-chorus", undefined, id),
      SONG_CHORUS_CACHE_TTL_MS,
      async () => {
        const response = await this.callOptional(["song_chorus"], { id }, cookie);
        if (!response) return undefined;
        const body = responseBody(response);
        const list = asArray(body.chorus ?? asRecord(body.data).chorus ?? body.data);
        const item = asRecord(list[0]);
        const startTime = readNumber(item.startTime);
        if (startTime === undefined) return undefined;
        const endTime = readNumber(item.endTime);
        return {
          startTime,
          ...(endTime !== undefined && endTime > startTime ? { endTime } : {}),
        };
      }
    );
  }

  async getAmllTtmlLyrics(songId: string): Promise<string | undefined> {
    const id = songId.trim();
    if (!id) return undefined;
    return this.loadAmllLyrics(
      this.cacheKey("song-amll-ttml", undefined, id),
      { songId: id },
      async (signal) => {
        if (this.options.fetchAmllLyrics) return this.options.fetchAmllLyrics(id);
        const json = await this.requestAmllJson(`get?ncmMusicId=${encodeURIComponent(id)}`, signal);
        return this.readAmllLyrics(json);
      }
    );
  }

  async searchAmllTtmlLyrics(songName: string, artistName?: string): Promise<string | undefined> {
    const title = songName.trim();
    if (!title) return undefined;
    return this.loadAmllLyrics(
      this.cacheKey("song-amll-search-ttml", undefined, `${title}:${artistName ?? ""}`),
      { title },
      async (signal) => {
        if (this.options.fetchAmllSearchLyrics)
          return this.options.fetchAmllSearchLyrics(title, artistName);
        const query = artistName ? `${title} ${artistName}` : title;
        const json = await this.requestAmllJson(
          `search?q=${encodeURIComponent(query)}&pageSize=5`,
          signal
        );
        if (!json) return undefined;
        const items = asRecord(json.data).items;
        if (!Array.isArray(items)) throw new Error("AMLL 搜索响应无效");
        if (!items.length) return undefined;
        const id = asRecord(items[0]).id;
        if (typeof id !== "string" && typeof id !== "number") throw new Error("AMLL 搜索条目无效");
        return this.readAmllLyrics(
          await this.requestAmllJson(`get?id=${encodeURIComponent(String(id))}`, signal)
        );
      }
    );
  }

  private async loadAmllLyrics(
    key: string,
    context: Record<string, string>,
    loader: (signal: AbortSignal) => Promise<string | undefined>
  ): Promise<string | undefined> {
    try {
      // 瞬态失败 reject cached loader，当次降级但不固化为空；只有确定缺失缓存 undefined。
      return await this.cached(key, SONG_LYRICS_CACHE_TTL_MS, async () => {
        if (this.amllQueue.size >= (this.options.amllMaxQueuedRequests ?? 64))
          throw new Error("AMLL 请求排队过多");
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(new Error("AMLL 请求超时")),
          Math.max(1, this.options.amllRequestTimeoutMs ?? 3_000)
        );
        try {
          return await this.amllQueue.add(
            async () => {
              const lyrics = await loader(controller.signal);
              controller.signal.throwIfAborted();
              if (lyrics !== undefined && !parseTTML(lyrics).length)
                throw new Error("AMLL TTML 歌词无效");
              return lyrics;
            },
            { signal: controller.signal }
          );
        } finally {
          clearTimeout(timer);
        }
      });
    } catch (error) {
      this.options.logger?.warn?.("获取 AMLL 歌词失败", { ...context, ...describeError(error) });
      return undefined;
    }
  }

  private async requestAmllJson(
    path: string,
    signal: AbortSignal
  ): Promise<Record<string, unknown> | undefined> {
    const response = await (this.options.amllFetcher ?? fetch)(
      `https://api.amll.dev/v1/lyrics/${path}`,
      {
        signal,
        headers: { "User-Agent": "BakaGame-Songuessr/1.0" },
      }
    );
    signal.throwIfAborted();
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`AMLL 请求失败（${response.status}）`);
    const json = asRecord(await response.json());
    signal.throwIfAborted();
    if (json.status === 404) return undefined;
    if (json.status !== 200) throw new Error("AMLL 返回无效状态");
    return json;
  }

  private readAmllLyrics(json: Record<string, unknown> | undefined): string | undefined {
    if (!json) return undefined;
    const lyrics = asRecord(json.data).lyrics;
    if (typeof lyrics !== "string") throw new Error("AMLL 返回无效歌词");
    if (!lyrics.trim()) throw new Error("AMLL 返回空歌词");
    return lyrics.trim();
  }

  async getPlaylistSongs(playlistId: string, cookie?: MusicCookieInput) {
    const id = playlistId.trim();
    if (!/^\d+$/.test(id)) throw new AppError("INVALID_PLAYLIST", "歌单 ID 无效");
    return this.cached(this.cacheKey("playlist", cookie, id), COLLECTION_CACHE_TTL_MS, async () => {
      const songs: SongSearchResult[] = [];
      const seenIds = new Set<string>();
      let name: string | undefined;
      let songCount: number | undefined;

      const collect = (rawSongs: unknown[]): number => {
        let added = 0;
        for (const raw of rawSongs) {
          const song = normalizeSong(raw);
          if (!song || seenIds.has(song.id)) continue;
          seenIds.add(song.id);
          songs.push(song);
          added += 1;
        }
        return added;
      };

      const firstResponse = await this.call(
        ["playlist_track_all", "playlist_detail"],
        {
          id,
          limit: PLAYLIST_PAGE_SIZE,
          offset: 0,
        },
        cookie
      );
      const firstBody = responseBody(firstResponse);
      const firstPlaylist = asRecord(firstBody.playlist ?? asRecord(firstBody.data).playlist);
      name = readString(firstPlaylist.name);
      songCount = readNumber(firstPlaylist.trackCount ?? firstPlaylist.trackNumber);
      const firstAdded = collect(
        asArray(firstBody.songs ?? firstPlaylist.tracks ?? asRecord(firstBody.data).songs)
      );

      // `playlist_track_all` 不返回歌单名与曲目总数，必须再取一次详情补上。
      if (!name || songCount === undefined) {
        const detailResponse = await this.callOptional(["playlist_detail"], { id }, cookie);
        if (detailResponse) {
          const detail = asRecord(responseBody(detailResponse).playlist);
          name = name ?? readString(detail.name);
          songCount = songCount ?? readNumber(detail.trackCount ?? detail.trackNumber);
        }
      }

      // 单页装不下的歌单必须继续翻页：此前固定 `limit: 1000, offset: 0`，
      // 超过 1000 首的歌单尾部曲目永远进不了题库（实测 1201 首只读到 1000 首）。
      // `playlist_detail` 不支持 offset（每页都返回同一份 tracks），
      // 因此用「本页是否带来新歌曲」兜底判定，避免重复整页；翻页失败不丢弃已取到的部分。
      for (let page = 1; page < PLAYLIST_MAX_PAGES && firstAdded > 0; page += 1) {
        if (songCount !== undefined && songs.length >= songCount) break;
        const response = await this.callOptional(
          ["playlist_track_all", "playlist_detail"],
          {
            id,
            limit: PLAYLIST_PAGE_SIZE,
            offset: page * PLAYLIST_PAGE_SIZE,
          },
          cookie
        );
        if (!response) break;
        const body = responseBody(response);
        const rawSongs = asArray(
          body.songs ?? asRecord(body.playlist).tracks ?? asRecord(body.data).songs
        );
        const added = collect(rawSongs);
        if (added === 0 || rawSongs.length < PLAYLIST_PAGE_SIZE) break;
      }

      return {
        info: { id, name: name ?? `歌单 ${id}`, songCount: songCount ?? songs.length },
        songs,
      };
    });
  }

  async searchArtists(keyword: string, limit = 20, cookie?: MusicCookieInput) {
    const normalized = keyword.trim();
    if (!normalized) return [];
    const normalizedLimit = Math.max(1, Math.min(limit, 50));
    return this.cached(
      this.cacheKey("artist-search", undefined, normalized.toLocaleLowerCase(), normalizedLimit),
      SEARCH_CACHE_TTL_MS,
      async () => {
        const response = await this.call(
          ["cloudsearch", "search"],
          {
            keywords: normalized,
            limit: normalizedLimit,
            type: 100,
          },
          cookie
        );
        const body = responseBody(response);
        const result = asRecord(body.result);
        return asArray(result.artists ?? result.artist)
          .map((value): SongArtistSearchResult | undefined => {
            const artist = asRecord(value);
            const id = readString(artist.id);
            const name = readString(artist.name);
            if (!id || !name) return undefined;
            const avatarUrl = normalizeHttpsUrl(artist.picUrl ?? artist.img1v1Url);
            return avatarUrl ? { id, name, avatarUrl } : { id, name };
          })
          .filter((artist): artist is SongArtistSearchResult => artist !== undefined);
      }
    );
  }

  async getArtistSongs(artistId: string, cookie?: MusicCookieInput) {
    const id = artistId.trim();
    if (!/^\d+$/.test(id)) throw new AppError("INVALID_ARTIST", "歌手 ID 无效");
    return this.cached(
      this.cacheKey("artist-songs", undefined, id),
      ARTIST_SONGS_CACHE_TTL_MS,
      async () => {
        const response = await this.call(
          ["artist_songs", "artist_top_song"],
          {
            id,
            limit: 1000,
            offset: 0,
            order: "hot",
          },
          cookie
        );
        const body = responseBody(response);
        return asArray(body.songs ?? asRecord(body.data).songs ?? body.hotSongs)
          .map(normalizeSong)
          .filter((song): song is SongSearchResult => Boolean(song));
      }
    );
  }

  /**
   * 按关键词检索专辑。
   *
   * 用途：Bangumi 的 character / image / theme / ost 等关联条目经常是**整张专辑**
   * （条目名就是专辑名，如《マジンブーン オリジナルサウンドトラック2》），
   * 拿专辑名当歌名走单曲检索必然一无所获 —— 必须「先搜专辑、再取专辑曲目」。
   */
  async searchAlbums(
    keyword: string,
    limit = 10,
    cookie?: MusicCookieInput
  ): Promise<SongAlbumSearchResult[]> {
    const normalized = keyword.trim();
    if (!normalized) return [];
    const normalizedLimit = Math.max(1, Math.min(limit, 30));
    return this.cached(
      this.cacheKey("album-search", undefined, normalized.toLocaleLowerCase(), normalizedLimit),
      SEARCH_CACHE_TTL_MS,
      async () => {
        // cloudsearch 的 type 枚举：1 单曲 / 10 专辑 / 100 歌手 / 1000 歌单。
        const response = await this.call(
          ["cloudsearch", "search"],
          {
            keywords: normalized,
            limit: normalizedLimit,
            type: 10,
          },
          cookie
        );
        const body = responseBody(response);
        const result = asRecord(body.result);
        return asArray(result.albums ?? result.album)
          .map((value): SongAlbumSearchResult | undefined => {
            const album = asRecord(value);
            const id = readString(album.id);
            const name = readString(album.name);
            if (!id || !name) return undefined;
            const artist = asRecord(album.artist);
            const artistName = readString(artist.name) ?? artistNames(album);
            return {
              id,
              name,
              artist: artistName || undefined,
              pictureUrl: normalizeHttpsUrl(album.picUrl ?? album.pic),
              songCount: readNumber(album.size ?? album.songSize),
            };
          })
          .filter((album): album is SongAlbumSearchResult => album !== undefined);
      }
    );
  }

  /**
   * 取整张专辑的曲目。`/api/v1/album/{id}` 一次返回专辑元信息与全部曲目。
   * 专辑曲目里可能夹着纯音乐、伴奏与翻唱版本，一律交给上层验证阶段筛。
   */
  async getAlbumSongs(albumId: string, cookie?: MusicCookieInput): Promise<SongSearchResult[]> {
    const id = albumId.trim();
    if (!/^\d+$/.test(id)) return [];
    return this.cached(
      this.cacheKey("album-songs", undefined, id),
      COLLECTION_CACHE_TTL_MS,
      async () => {
        const response = await this.call(["album"], { id }, cookie);
        const body = responseBody(response);
        const album = asRecord(body.album ?? body);
        // 曲目在**顶层** `body.songs`。`body.album.songs` 虽然存在，但在单曲 / 同名专辑上
        // 常是**空数组**——用 `??` 读它会拿到 `[]` 而不会回退到顶层，专辑路径会整条失效。
        // 实测《風がそよぐ場所》：album.songs 长度 0、顶层 songs 长度 2。
        return asArray(body.songs ?? album.songs ?? asRecord(body.data).songs)
          .map(normalizeSong)
          .filter((song): song is SongSearchResult => Boolean(song));
      }
    );
  }

  private loginCookie(): Record<string, unknown> {
    return {
      os: "pc",
      appver: "3.1.29.205117",
      osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
      channel: "netease",
      mobilename: this.deviceName,
      model: this.deviceName,
    };
  }

  private loginUserAgent(): string {
    return "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.29.205117";
  }

  async createQrLogin(): Promise<MusicQrLogin> {
    const loginCookie = this.loginCookie();
    const loginUa = this.loginUserAgent();
    // 每次扫码开启一个新的登录会话，并在会话内固定同一个 CN 出口 IP。
    // 沿用上一轮会话的旧 IP 会让「同设备同 IP」的设备指纹失去意义。
    const scope = `qr-login:${randomUUID()}`;
    // 取 unikey 这一步还没有可用于分桶的 key，先把 scope 显式传进去；
    // 拿到 key 后登记到同一个 scope 上，保证整轮握手始终是同一个出口 IP。
    const keyResponse = await this.call(
      ["login_qr_key"],
      { ua: loginUa },
      loginCookie,
      this.randomCNIP,
      true,
      false,
      scope
    );
    const keyBody = responseBody(keyResponse);
    if (responseCode(keyBody) !== 200) throw musicLoginError(keyBody, "无法创建登录二维码");
    const key = readString(asRecord(keyBody.data).unikey ?? keyBody.unikey);
    if (!key) throw new AppError("MUSIC_LOGIN_FAILED", "无法创建登录二维码");

    this.pruneLoginScopes();
    this.qrLoginScopes.set(key, { scope, createdAt: this.now() });
    try {
      const qrResponse = await this.call(
        ["login_qr_create"],
        { key, qrimg: true, platform: this.deviceName, ua: loginUa },
        loginCookie,
        this.randomCNIP,
        true,
        false,
        scope
      );
      const qrBody = responseBody(qrResponse);
      if (responseCode(qrBody) !== 200) throw musicLoginError(qrBody, "无法生成登录二维码");
      const qrData = asRecord(qrBody.data);
      const qrUrl = readString(qrData.qrurl);
      const qrImage = readString(qrData.qrimg);
      if (!qrUrl || !qrImage) throw new AppError("MUSIC_LOGIN_FAILED", "无法生成登录二维码");
      return { key, qrUrl, qrImage };
    } catch (error) {
      this.qrLoginScopes.delete(key);
      throw error;
    }
  }

  /** 丢弃开完二维码却长时间不扫的会话，避免条目无限堆积。 */
  private pruneLoginScopes() {
    const deadline = this.now() - QR_LOGIN_SCOPE_TTL_MS;
    for (const [key, entry] of this.qrLoginScopes) {
      if (entry.createdAt < deadline) this.qrLoginScopes.delete(key);
    }
  }

  async checkQrLogin(keyValue: string): Promise<MusicQrLoginCheck> {
    const key = keyValue.trim();
    if (!key) throw new AppError("INVALID_LOGIN", "二维码登录密钥不能为空");
    // 本次轮询只认自己那个二维码对应的会话 IP，别人同时扫码不会串到这里。
    const scope = this.qrLoginScopes.get(key)?.scope;
    const response = await this.call(
      ["login_qr_check"],
      { key, ua: this.loginUserAgent() },
      this.loginCookie(),
      this.randomCNIP,
      true,
      false,
      scope
    );
    const body = responseBody(response);
    const code = responseCode(body);
    if (code === 8810 || code === 10004) throw musicLoginError(body, "扫码登录失败");
    const message = responseMessage(body, "等待扫码");
    if (code === 800) return { status: "expired", message };
    if (code === 802) return { status: "scanned", message };
    if (code !== 803) return { status: "waiting", message };

    const cookie = responseCookie(response);
    if (!cookie) throw new AppError("MUSIC_LOGIN_FAILED", "扫码成功但未取得登录 Cookie");
    // 先固化会话 IP 再发后续请求：否则设备上报与状态校验会按 cookie 另起一个 IP，
    // 等会话 IP 回填时又切一次 —— 凭证刚建立就漂移，正是登录态反复失效的成因。
    this.bindSessionIp(cookie, scope);
    try {
      await this.uploadDeviceInfo(cookie, this.deviceName, scope);
      const session = await this.getLoginStatus(cookie, scope);
      return { status: "authorized", message, session };
    } finally {
      this.qrLoginScopes.delete(key);
    }
  }

  // 将登录会话使用的 IP 固化到登录后凭证的 scope 上，随后同一凭证稳定复用该 IP。
  private bindSessionIp(cookieValue: string, scope?: string) {
    if (!scope) return;
    const ip = this.ipByScope.get(scope);
    const cookie = cookieValue.trim();
    if (ip && cookie) this.ipByScope.set(this.cookieScope(cookie), ip);
  }

  async uploadDeviceInfo(
    cookieValue: string,
    deviceName = this.deviceName,
    loginScope?: string
  ): Promise<boolean> {
    const cookie = cookieValue.trim();
    if (!cookie) return false;
    const name = deviceName.trim() || this.deviceName;
    try {
      // 设备名上报只走 Enhanced API 的原生 `deviceinfo_center_upload` 模块。历史上该模块在
      // 4.40.x 尚不存在，这里于是回退到直接 import 包内 `util/request.js` + `util/option.js`
      // 自拼 EAPI 请求——那属于「直接导入传递依赖」：上游一改内部目录就整条失效，还会绕开本
      // provider 的限流队列与出口 IP 归属。API 包自 4.41.0 起自带同名模块，行为与自拼请求等价，
      // 回退路径已无必要，移除以免重新引入隐式依赖。
      const response = await this.callOptional(
        ["deviceinfo_center_upload"],
        { deviceName: name },
        `${cookie}; os=pc`,
        this.randomCNIP,
        false,
        loginScope
      );
      return Boolean(response);
    } catch (error) {
      this.logger?.warn("上报网易云设备名称未成功，保持原设备名运行", describeError(error));
      return false;
    }
  }

  async getLoginStatus(cookieValue: string, loginScope?: string): Promise<MusicLoginSession> {
    const cookie = cookieValue.trim();
    if (!cookie) throw new AppError("MUSIC_SESSION_INVALID", "登录 Cookie 不能为空");
    const cacheKey = this.cacheKey("login-status", cookie);
    const reused = this.loginStatusCache.get(cacheKey);
    // 复用期内直接返回同一份校验结果；校验失败不写缓存，所以失效的凭据下一次仍会回源。
    if (reused) return { cookie: reused.cookie, account: { ...reused.account } };
    const session = await this.verifyLoginStatus(cookie, loginScope);
    this.loginStatusCache.set(cacheKey, session);
    return { cookie: session.cookie, account: { ...session.account } };
  }

  private async verifyLoginStatus(cookie: string, loginScope?: string): Promise<MusicLoginSession> {
    // 该校验请求必须携带与登录同源的 IP：历史实现显式关闭 randomCNIP 导致校验请求无 realIP，
    // 网易云按出口 IP 比对后判定为异地调用，正是「设备还在但凭证反复失效」的直接触发点。
    const response = await this.call(
      ["login_status"],
      {},
      cookie,
      this.randomCNIP,
      true,
      false,
      loginScope
    );
    const body = responseBody(response);
    const data = asRecord(body.data);
    const profile = asRecord(body.profile ?? data.profile);
    const nestedCode = readNumber(data.code);
    const userId = readString(profile.userId ?? profile.id);
    if (responseCode(body) !== 200 || (nestedCode !== undefined && nestedCode !== 200) || !userId) {
      throw new AppError("MUSIC_SESSION_INVALID", "网易云登录状态已失效");
    }
    return {
      cookie,
      account: await this.enrichVipAccount(cookie, readLoginAccount(body)),
    };
  }

  private async loadSong(
    songId: string,
    includeResources: boolean,
    cookie?: MusicCookieInput
  ): Promise<SongDetails> {
    const id = songId.trim();
    if (!id) throw new AppError("INVALID_SONG", "歌曲 ID 不能为空");

    const detailResponse = await this.cached(
      this.cacheKey("song-detail", undefined, id),
      SONG_METADATA_CACHE_TTL_MS,
      () => this.call(["song_detail"], { ids: id }, cookie)
    );
    const detailBody = responseBody(detailResponse);
    const rawSong = asArray(detailBody.songs)[0];
    const base = normalizeSong(rawSong);
    if (!base) throw new AppError("SONG_NOT_FOUND", "未找到歌曲信息");

    const wikiPromise = this.cached(
      this.cacheKey("song-wiki", undefined, id),
      SONG_WIKI_CACHE_TTL_MS,
      () => this.callOptional(["song_wiki_summary", "song_wiki_home"], { id }, cookie)
    );
    const lyricPromise = includeResources
      ? this.cached(this.cacheKey("song-lyrics", undefined, id), SONG_LYRICS_CACHE_TTL_MS, () =>
          this.call(["lyric_new", "lyric"], { id }, cookie)
        )
      : Promise.resolve(undefined);
    const popularityPromise = this.getSongPopularity(id, cookie).catch(() => undefined);
    const chorusPromise = includeResources
      ? this.getSongChorus(id, cookie).catch(() => undefined)
      : Promise.resolve(undefined);
    const urlPromise = includeResources ? this.loadAudioUrl(id, cookie) : Promise.resolve("");

    const [wikiResponse, lyricResponse, urlResponse, popularity, chorus] = await Promise.all([
      wikiPromise,
      lyricPromise,
      urlPromise,
      popularityPromise,
      chorusPromise,
    ]);

    const songRecord = asRecord(rawSong);
    const album = asRecord(songRecord.al ?? songRecord.album);
    const publishTime = readNumber(songRecord.publishTime ?? album.publishTime);
    const wiki = readWiki(wikiResponse ? responseBody(wikiResponse) : undefined);

    let audioUrl = "";
    let lyrics: SongLyricLine[] = [];
    if (includeResources) {
      audioUrl = urlResponse;
      lyrics = await this.resolveSongLyrics(
        readLyricSources(id, base, responseBody(lyricResponse))
      );
      if (!audioUrl) throw new AppError("SONG_UNAVAILABLE", "该歌曲暂时没有可用播放地址");
    }

    return {
      ...base,
      audioUrl,
      lyrics,
      releaseYear: publishTime ? new Date(publishTime).getUTCFullYear() : undefined,
      popularity:
        popularity ?? base.popularity ?? readNumber(songRecord.pop ?? songRecord.popularity),
      language: wiki.language,
      encyclopedia: {
        summary: wiki.summary,
        aliases: wiki.aliases,
        tags: wiki.tags,
      },
      chorus,
    };
  }

  /**
   * 按四级优先取歌词：官方 YRC 逐字 → AMLL 按网易云 ID → AMLL 按歌名搜索 → 普通 LRC 兜底。
   *
   * 逐级短路是硬约束：AMLL 是外部服务，前一级命中就绝不能多发后一级的请求。
   */
  private async resolveSongLyrics(input: LyricChainInput): Promise<SongLyricLine[]> {
    const yrc = this.parseNeteaseYrcLyrics(input);
    if (yrc.length > 0) return yrc;

    const byId = await this.withTtmlLyrics(input, () => this.getAmllTtmlLyrics(input.id), {
      log: "解析 AMLL 网易云 ID 匹配 TTML 歌词失败",
      context: { songId: input.id },
    });
    if (byId.length > 0) return byId;

    if (!input.song.title) return this.parseNeteaseLineLyrics(input);
    const byTitle = await this.withTtmlLyrics(
      input,
      () => this.searchAmllTtmlLyrics(input.song.title, input.song.artist),
      { log: "解析 AMLL 歌曲名搜索 TTML 歌词失败", context: { title: input.song.title } }
    );
    return byTitle.length > 0 ? byTitle : this.parseNeteaseLineLyrics(input);
  }

  /** 拉一次 TTML 并解析；上游失败或没有结果都当作「这一级没命中」，只记告警。 */
  private async withTtmlLyrics(
    input: LyricChainInput,
    fetchTtml: () => Promise<string | undefined>,
    failure: { log: string; context: Record<string, unknown> }
  ): Promise<SongLyricLine[]> {
    try {
      const ttmlRaw = await fetchTtml();
      return ttmlRaw ? (adoptVerbatimLyrics(parseTTML(ttmlRaw), input) ?? []) : [];
    } catch (err) {
      this.options.logger?.warn?.(failure.log, { ...failure.context, ...describeError(err) });
      return [];
    }
  }

  /** 优先级 1：网易云官方 YRC 逐字歌词，命中即不碰任何第三方。 */
  private parseNeteaseYrcLyrics(input: LyricChainInput): SongLyricLine[] {
    if (!input.yrc) return [];
    try {
      return adoptVerbatimLyrics(parseYrc(input.yrc), input) ?? [];
    } catch (err) {
      this.options.logger?.warn?.("解析网易云 YRC 歌词失败", {
        songId: input.id,
        ...describeError(err),
      });
      return [];
    }
  }

  /** 优先级 4 兜底：网易云普通 LRC，只有行级时间轴（播放器按行滚动高亮）。 */
  private parseNeteaseLineLyrics(input: LyricChainInput): SongLyricLine[] {
    if (!input.lrc) return [];
    try {
      const merged = mergeTranslations(parseLrc(input.lrc), input.lrcTrans, input.lrcRoma);
      return sanitizeLyrics(merged, input.song);
    } catch (err) {
      this.options.logger?.warn?.("解析网易云 LRC 歌词失败", {
        songId: input.id,
        ...describeError(err),
      });
      return [];
    }
  }

  /**
   * 预热音乐上游：在进程启动阶段就加载 API 模块并注册匿名令牌。
   *
   * 冷进程第一次触碰音乐链路时要顺序支付「动态导入接口包（实测约 1.1 s）+ 注册匿名令牌 +
   * 首个上游请求的 DNS/TCP 建连」，解析器冷启动时实测可达 12 s。保存了本机凭据的玩家一进房间
   * 就会触发 `song.auth.useCookie`，等于替整个进程垫付这笔冷启动，房间徽标也就长时间停在
   * 「本机已登录」。预热失败不阻断业务：只记告警，调用方照旧走惰性加载并重试。
   */
  async warmUp(): Promise<void> {
    try {
      await this.loadApi();
    } catch (error) {
      this.logger?.warn("网易云上游预热失败，将在首次请求时重试", describeError(error));
    }
  }

  private loadApi(): Promise<ApiModule> {
    if (!this.apiPromise) {
      this.apiPromise = (async () => {
        const api = this.options.loadApi
          ? await this.options.loadApi()
          : ((await import("@neteasecloudmusicapienhanced/api")) as ApiModule);
        await this.prepareAnonymousSession(api);
        return api;
      })().catch((error: unknown) => {
        // 拒绝的 Promise 绝不能留在字段上：预热期的一次抖动会把整个进程的音乐链路永久钉死。
        this.apiPromise = undefined;
        throw error;
      });
    }
    return this.apiPromise;
  }

  private async unblockSongAudio(songId: string, cookie?: MusicCookieInput): Promise<string> {
    const sourceTimeoutMs =
      this.options.unblockSourceTimeoutMs ?? DEFAULT_UNBLOCK_SOURCE_TIMEOUT_MS;
    const deadline =
      this.now() + (this.options.unblockTotalBudgetMs ?? DEFAULT_UNBLOCK_TOTAL_BUDGET_MS);

    // 1. 按显式优先级逐个音源调用 song_url_match，跳过伪解灰结果。
    //    必须显式传 source：不传时包内按目录字母序尝试，bugpk 排在最前且会返回网易云灰链兜底，
    //    字符串非空被误判为成功，导致 unm 等真正可用的音源永远得不到机会。
    //    每个音源都必须带上界，否则一个被丢弃的请求就足以把整轮出题钉死（见 settleWithin）。
    for (const source of UNBLOCK_SOURCE_ORDER) {
      if (this.now() >= deadline) break;
      const matchResponse = await settleWithin(
        this.callOptional(["song_url_match"], { id: songId, source }, cookie),
        sourceTimeoutMs,
        undefined
      );
      if (!matchResponse) continue;
      const body = responseBody(matchResponse);
      const url = readString(body.data) ?? readString(body.proxyUrl);
      const normalized = normalizeAudioUrl(url);
      if (normalized && !isNeteaseFallbackUrl(normalized)) return normalized;
    }

    // 2. 尝试 song_url_v1 带 unblock 参数解灰
    const v1Response = await settleWithin(
      this.callOptional(
        ["song_url_v1"],
        { id: songId, level: "standard", unblock: "true" },
        cookie
      ),
      sourceTimeoutMs,
      undefined
    );
    if (v1Response) {
      const body = responseBody(v1Response);
      const songData = asRecord(asArray(body.data)[0]);
      const url = readString(songData.url) ?? readString(songData.proxyUrl);
      const normalized = normalizeAudioUrl(url);
      if (normalized && !isNeteaseFallbackUrl(normalized)) return normalized;
    }

    return "";
  }

  private async loadAudioUrl(
    songId: string,
    cookie?: MusicCookieInput,
    force = false
  ): Promise<string> {
    const key = this.cacheKey("audio", cookie, songId);
    const value = await this.cached(
      key,
      AUDIO_URL_CACHE_TTL_MS,
      async () => {
        const response = await this.call(
          ["song_url", "song_url_v1"],
          {
            id: songId,
            level: "standard",
            br: 320000,
          },
          cookie
        );
        const body = responseBody(response);
        const songData = asRecord(asArray(body.data)[0]);
        // 试听片段（`freeTrialInfo`）不是可用的播放地址，整曲只能由解灰提供。
        // 不能把片段当成结果返回：它同样是 `audio/mpeg` 且能 Range 206，探测起来完全像正常音频，
        // 实测只有约 30 秒（总字节 ÷ 时长折算等效码率仅 13~19 kbps）。一旦被出成题目，
        // 玩家会在片段播完后对着静音猜歌，而服务端不会报任何错。
        const trialOnly = songData.freeTrialInfo != null;
        let audioUrl = trialOnly ? "" : (normalizeAudioUrl(songData.url) ?? "");
        const isRestricted = !audioUrl || trialOnly || songData.code === 404;

        if (isRestricted && this.readGeneralUnblock()) {
          const unblockedUrl = await this.unblockSongAudio(songId, cookie);
          if (unblockedUrl) {
            audioUrl = unblockedUrl;
            this.logger?.info("网易云歌曲解灰成功", { songId, audioUrl });
          }
        }

        return audioUrl;
      },
      { force, priority: 4, cacheNegative: false }
    );
    if (!value) throw new AppError("SONG_UNAVAILABLE", "该歌曲暂时没有可用播放地址");
    return value;
  }

  private async prepareAnonymousSession(api: ApiModule) {
    if (this.anonymousCookie || typeof api.register_anonimous !== "function") return;
    try {
      // 匿名令牌是全进程共享的匿名身份，固定挂在匿名 scope 上，不落进任何玩家的桶。
      const response = await this.scheduleRequest(
        () =>
          (api.register_anonimous as ApiFunction)({
            crypto: "weapi",
            cookie: {},
            randomCNIP: this.randomCNIP,
            ...(this.randomCNIP ? { realIP: this.ensureScopeIp(IP_SCOPE_ANONYMOUS) } : {}),
          }),
        IP_SCOPE_ANONYMOUS
      );
      this.anonymousCookie = responseCookie(response);
    } catch (error) {
      this.logger?.warn("注册网易云匿名令牌未成功，继续以无凭据模式运行", describeError(error));
    }
  }

  private async call(
    names: string[],
    params: Record<string, unknown>,
    cookie?: string | Record<string, unknown>,
    randomCNIP = this.randomCNIP,
    preserveErrorResponse = false,
    includeAnonymousCookie = true,
    loginScope?: string
  ): Promise<ApiResponse> {
    const api = await this.loadApi();
    // 在调度前定好 IP 归属：限流发生时要按同一个 scope 刷新 IP，两处必须一致。
    const ipScope = this.resolveIpScope(cookie, loginScope, names);
    let hasEndpoint = false;
    let lastErrorResponse: ApiResponse | undefined;
    let lastError: unknown;
    for (const name of names) {
      const fn = api[name];
      if (typeof fn !== "function") continue;
      hasEndpoint = true;
      try {
        return await this.invokeApiEndpoint(
          fn as ApiFunction,
          params,
          cookie,
          randomCNIP,
          includeAnonymousCookie,
          loginScope,
          ipScope
        );
      } catch (error) {
        lastError = error;
        // 同一能力可能有多个兼容端点；当前端点运行失败时继续尝试后备实现。
        const preserved = this.classifyEndpointFailure(error);
        if (preserved !== undefined) lastErrorResponse = preserved;
      }
    }
    if (!hasEndpoint) {
      throw new AppError("MUSIC_API_UNAVAILABLE", `音乐 API 缺少接口：${names.join(" / ")}`);
    }
    if (preserveErrorResponse && lastErrorResponse) return lastErrorResponse;
    throw this.upstreamError(lastErrorResponse ?? lastError);
  }

  /** 调用单个端点：正常 resolve 的 405 body 同样转成业务异常。 */
  private async invokeApiEndpoint(
    fn: ApiFunction,
    params: Record<string, unknown>,
    cookie: string | Record<string, unknown> | undefined,
    randomCNIP: boolean,
    includeAnonymousCookie: boolean,
    loginScope: string | undefined,
    ipScope: string | undefined
  ): Promise<ApiResponse> {
    const response = await this.scheduleRequest(
      () =>
        fn(
          this.withCookie(params, cookie, randomCNIP, includeAnonymousCookie, loginScope, ipScope)
        ),
      ipScope
    );
    // Enhanced API 的不同端点可能选择 reject，也可能正常 resolve 一个 405 body。
    // scheduleRequest 内部已统一触发 enterRateLimitCooldown，此处将 405 body 转为业务异常。
    if (this.isRateLimitError(response)) {
      throw this.upstreamError(response);
    }
    return response;
  }

  /**
   * 端点失败分类：不可重试与限流直接中止整次调用，其余只回传可保留的 405 响应。
   * 返回 undefined 表示调用方只需记住 lastError 并继续下一个端点。
   */
  private classifyEndpointFailure(error: unknown): ApiResponse | undefined {
    if (error instanceof AppError && NON_RETRYABLE_API_ERROR_CODES.has(error.code)) throw error;
    if (this.isRateLimitError(error)) throw this.upstreamError(error);
    return "body" in asRecord(error) ? (error as ApiResponse) : undefined;
  }

  private async callOptional(
    names: string[],
    params: Record<string, unknown>,
    cookie?: string | Record<string, unknown>,
    randomCNIP = this.randomCNIP,
    includeAnonymousCookie = true,
    loginScope?: string
  ): Promise<ApiResponse | undefined> {
    try {
      return await this.call(
        names,
        params,
        cookie,
        randomCNIP,
        false,
        includeAnonymousCookie,
        loginScope
      );
    } catch (error) {
      if (error instanceof AppError && error.code === "MUSIC_API_UNAVAILABLE") return undefined;
      if (error instanceof AppError && NON_RETRYABLE_API_ERROR_CODES.has(error.code)) throw error;
      this.logger?.warn("网易云可选接口调用降级", {
        endpoints: names,
        error: describeError(error),
      });
      return undefined;
    }
  }

  private async enrichVipAccount(
    cookie: string,
    account: SonGuessrMusicAccount
  ): Promise<SonGuessrMusicAccount> {
    const response = await this.callOptional(
      ["vip_info_v2", "vip_info"],
      account.userId ? { uid: account.userId } : {},
      cookie
    );
    if (!response) return { ...account, vipStatus: "unknown" };
    const body = responseBody(response);
    if (responseCode(body) !== 200) return { ...account, vipStatus: "unknown" };
    return readVipAccount(body, account, this.now());
  }

  private cacheKey(namespace: string, cookie: unknown, ...parts: unknown[]) {
    const cookieStr =
      typeof cookie === "string"
        ? cookie.trim()
        : isCookieRecord(cookie)
          ? typeof cookie.netease === "string"
            ? cookie.netease.trim()
            : stableStringify(cookie)
          : "";
    const scope = cookieStr
      ? createHash("sha256").update(cookieStr).digest("hex").slice(0, 16)
      : "anonymous";
    return [namespace, scope, ...parts].map(String).join(":");
  }

  private async cached<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
    options: {
      force?: boolean;
      priority?: number;
      background?: boolean;
      cacheNegative?: boolean;
    } = {}
  ): Promise<T> {
    const now = this.now();
    if (!options.background) this.lastUserRequestAt = now;
    const entry = this.cache.get(key);
    const hardTtl = Math.max(ttlMs, ttlMs * 3);
    if (!options.force && entry) {
      if (now < entry.hardExpireAt) {
        entry.lastAccessAt = now;
        entry.hits += 1;
        if (now >= entry.softExpireAt)
          void this.refreshCacheEntry(key, ttlMs, loader, options.priority ?? entry.priority);
        return cloneCacheValue(entry.value as T);
      }
      this.cache.delete(key);
      this.refreshers.delete(key);
    }
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) return cloneCacheValue(await existing);

    const allowNegative = options.cacheNegative !== false;
    this.refreshers.set(key, { ttlMs, loader });
    const request = loader()
      .then((value) => {
        // 负结果不写缓存：上游抖动可能返回空地址 / 空值，一旦落缓存就会被钉死整个 TTL，
        // 玩家重试也只会拿到同一个空值。`cacheNegative` 缺省为 true 以保持既有缓存语义，
        // 播放地址这类「重试可能成功」的取值显式传 false，只跳过空结果、正常地址照旧缓存。
        const storeResult = allowNegative || Boolean(value);
        if (storeResult) {
          const fetchedAt = this.now();
          const serializedSize =
            value === undefined ? 32 : Math.max(32, JSON.stringify(value).length * 2);
          this.cache.set(key, {
            value,
            softExpireAt: fetchedAt + ttlMs * 0.8,
            hardExpireAt: fetchedAt + hardTtl,
            lastAccessAt: fetchedAt,
            hits: 1,
            priority: options.priority ?? 1,
            size: serializedSize,
          });
        }
        return value;
      })
      .finally(() => {
        if (this.inFlight.get(key) === request) this.inFlight.delete(key);
      });
    this.inFlight.set(key, request);
    return cloneCacheValue(await request);
  }

  private async refreshCacheEntry(
    key: string,
    ttlMs: number,
    loader: () => Promise<unknown>,
    priority: number
  ) {
    if (this.inFlight.has(key) || this.now() < this.cooldownUntil || this.queue.size > 0) return;
    try {
      await this.cached(key, ttlMs, loader, { priority, force: true, background: true });
    } catch (error) {
      this.logger?.warn("网易云缓存预刷新失败", { key, error: describeError(error) });
    }
  }

  private async runCacheMaintenance() {
    if (this.queue.size > 0 || this.now() < this.cooldownUntil) return;
    const now = this.now();
    if (now - this.lastUserRequestAt > 30 * 60_000) {
      this.evictIdleCacheEntries(now);
      return;
    }
    const candidates = [...this.cache.entries()]
      .filter(([, entry]) => now >= entry.hardExpireAt || now >= entry.softExpireAt)
      .sort(([, left], [, right]) => right.priority + right.hits - (left.priority + left.hits))
      .slice(0, 4);
    await this.refreshExpiredEntries(now, candidates);
    this.pruneStaleRefreshers();
  }

  /**
   * 后台维护路径。
   *
   * 定时器里没有玩家上下文，但这是设计如此、不是配置错误，所以显式声明走共享匿名出口：
   * 否则每次维护都会被记成「作用域外调用」的降级，把真正需要被发现的新调用链淹成噪声。
   * 该 scope 的配额与退避仍按 `anonymous` 正常计账。
   */
  private refreshExpiredEntries(
    now: number,
    candidates: Iterable<[string, CacheEntry]>
  ): Promise<void> {
    return runWithAnonymousMusicIpScope(async () => {
      for (const [key, entry] of candidates) {
        const refresher = this.refreshers.get(key);
        if (!refresher) {
          this.cache.delete(key);
          continue;
        }
        if (now >= entry.hardExpireAt) this.cache.delete(key);
        await this.refreshCacheEntry(key, refresher.ttlMs, refresher.loader, entry.priority);
      }
    });
  }

  /** 长时间没有用户请求：淘汰低命中且久未访问的条目，不做任何主动刷新。 */
  private evictIdleCacheEntries(now: number) {
    for (const [key, entry] of this.cache.entries()) {
      if (entry.hits <= 1 && now - entry.lastAccessAt > 30 * 60_000) {
        this.cache.delete(key);
        this.refreshers.delete(key);
      }
    }
    this.pruneStaleRefreshers();
  }

  /** 刷新器只服务于已缓存或仍在请求中的条目，其余一并回收。 */
  private pruneStaleRefreshers() {
    for (const key of this.refreshers.keys())
      if (!this.cache.has(key) && !this.inFlight.has(key)) this.refreshers.delete(key);
  }

  /**
   * 排队执行一次上游请求。
   *
   * `ipScope` 是本次请求使用的伪装出口 IP 的归属标识：限流一旦发生，就刷新该 scope 的 IP，
   * 让下一次请求换一个出口重试（详见 `rotateScopeIp`）。
   */
  private scheduleRequest<T>(task: () => Promise<T>, ipScope?: string): Promise<T> {
    if (this.now() < this.cooldownUntil) {
      return Promise.reject(this.rateLimitError());
    }
    if (this.queue.size >= this.maxQueuedRequests) {
      return Promise.reject(this.busyError("网易云请求排队过多，请稍后重试"));
    }

    const id = ++this.requestIdCounter;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectHandler: ((err: unknown) => void) | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectHandler = reject;
      timeoutTimer = setTimeout(() => {
        if (this.pendingRejections.has(id)) {
          this.pendingRejections.delete(id);
          reject(this.busyError("网易云请求等待超时，请稍后重试"));
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
   * `ipScope` 是触发本次限流的请求所属的 IP 归属。网易云按请求方声称的 IP 计算配额
   * （实测：同参数继续打仍全 406，仅更换伪装 IP 即立刻恢复），因此这里顺手刷新该 scope 的 IP，
   * 让退避结束后的下一次请求从新出口发出，而不是继续撞在同一个已经计满的 IP 上。
   */
  private enterRateLimitCooldown(error: unknown, ipScope?: string) {
    const body = responseBody(error);
    this.lastRateLimitMessage = responseMessage(body, this.lastRateLimitMessage);
    this.rotateScopeIp(ipScope);
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

    this.logger?.warn("网易云接口触发限流退避", {
      strikes: this.rateLimitStrikes,
      cooldownDurationMs: duration,
      cooldownUntil: new Date(this.cooldownUntil).toISOString(),
      droppedQueuedRequests: rejections.length,
      rotatedScope: ipScope,
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
   * 历史上两者复用 `MUSIC_API_RATE_LIMITED`，线上看到「限流」时无法区分
   * 是网易云真的拒绝了，还是本地把自己堵死了 —— 必须分开编码。
   */
  private busyError(message: string) {
    return new AppError("MUSIC_API_BUSY", message, {
      retryAfterMs: Math.max(0, this.queueTimeoutMs),
    });
  }

  /** 上游限流（含冷却期内的快速拒绝），也可用于拒绝已在队列中、但冷却已开始的请求。 */
  private rateLimitError(message = this.lastRateLimitMessage) {
    return new AppError("MUSIC_API_RATE_LIMITED", message, {
      upstreamCode: 405,
      retryAfterMs: Math.max(0, this.cooldownUntil - this.now()),
    });
  }

  private upstreamError(error: unknown) {
    if (error instanceof AppError) return error;
    const body = responseBody(error);
    const code = responseCode(body) ?? readNumber(asRecord(error).status);
    const message = responseMessage(
      body,
      error instanceof Error && error.message ? error.message : "网易云音乐接口请求失败，请稍后重试"
    );
    return new AppError(
      isRateLimitCode(code) ? "MUSIC_API_RATE_LIMITED" : "MUSIC_API_FAILED",
      message,
      { upstreamCode: code }
    );
  }

  private isRateLimitError(error: unknown) {
    const body = responseBody(error);
    return (
      isRateLimitCode(responseCode(body)) || isRateLimitCode(readNumber(asRecord(error).status))
    );
  }

  /**
   * 解析一次请求应当使用的 IP 归属，优先级从高到低：
   *
   * 1. `loginScope` —— 扫码登录会话。整条链路（创建二维码 → 轮询 → 设备上报 → 状态校验）
   *    必须共用同一个 IP，否则登录态一建立就漂移。只有**显式属于某个扫码会话**的请求才走它：
   *    旧实现无条件优先全局 qrLoginScope，等于任意一个用户处于扫码等待期时，全进程所有房间、
   *    所有凭证的请求都被强行带上那个会话的 IP，凭证与出口 IP 的绑定被整体破坏。
   * 2. `host:<cookie 摘要>` —— 带房主凭证的请求，沿用登录时固化的那个 IP。
   * 3. `player:<连接标识>` —— 匿名请求按玩家分桶，互不占用对方的限流配额。
   * 4. `anonymous` —— 没有玩家上下文的兜底。走到这一层说明整条调用链没被 `musicIpScope.run`
   *    包住，按降级上报（见 `reportMissingIpScope`），不再静默。
   */
  private resolveIpScope(
    cookie?: string | Record<string, unknown>,
    loginScope?: string,
    endpoints?: readonly string[]
  ) {
    if (loginScope) return loginScope;
    if (this.hasCookie(cookie)) return this.cookieScope(cookie);
    const scope = musicIpScope.getStore();
    if (scope) return scope;
    this.reportMissingIpScope(endpoints);
    return IP_SCOPE_ANONYMOUS;
  }

  /**
   * 「作用域外调用」必须看得见。
   *
   * 它过去和后台预热共用同一条静默回落：新增一条没包作用域的调用链时，现场只看到全服 405，
   * 看不到「所有人的匿名请求又挤回同一个出口」这层原因 —— 而注释里写着的前置条件不会报警。
   * 口径与采集链路故障上报一致：每次降级都计数，聚合告警按固定间隔最多一条。
   * 上下文只带接口名这类无凭据字段。
   */
  private reportMissingIpScope(endpoints?: readonly string[]) {
    countServerMetric(IP_SCOPE_FALLBACK_METRIC, 1);
    const at = this.now();
    if (at - this.lastIpScopeFallbackWarnAt < IP_SCOPE_FALLBACK_WARN_INTERVAL_MS) return;
    this.lastIpScopeFallbackWarnAt = at;
    this.logger?.warn("音乐请求缺少玩家 IP 作用域，已回落共享匿名出口", {
      fallbackScope: IP_SCOPE_ANONYMOUS,
      ...(endpoints?.length ? { endpoints: [...endpoints] } : {}),
    });
  }

  /** cookie 参数是否真的带了凭证；空串与空对象一律按匿名处理，避免落进房主那一桶。 */
  private hasCookie(cookie?: string | Record<string, unknown>) {
    if (typeof cookie === "string") return cookie.trim().length > 0;
    if (cookie && typeof cookie === "object") {
      if (typeof cookie.netease === "string") return cookie.netease.trim().length > 0;
      return Object.keys(cookie).length > 0;
    }
    return false;
  }

  /**
   * 刷新一个 scope 的伪装 IP。
   *
   * 只删缓存、不在这里生成新 IP：下一次请求会按 scope 重新分配，退避期间就不必空转，
   * 没被再次用到的 scope 也不会留下无效条目。
   *
   * 注意这里**不做房主/玩家的区分**：刷新只发生在限流之后，此时该 scope 的配额已经被计满，
   * 继续用同一个 IP 只会持续 405。房主凭证的 IP 由 `bindSessionIp` 固化的语义在限流兜底时
   * 让位给可用性（变更缘由见 `Server/docs/NeteaseMusicApi.md`）。
   */
  private rotateScopeIp(scope?: string) {
    if (!scope) return;
    this.ipByScope.delete(scope);
  }

  // 同一份 cookie 原文必须映射到同一个 IP：Enhanced API 会把 cookie 对象补上随机的
  // _ntes_nuid / NMTID，因此这里对字符串做哈希、对对象做稳定序列化，避免逐请求漂移。
  private cookieScope(cookie?: string | Record<string, unknown>) {
    const cookieStr =
      typeof cookie === "string"
        ? cookie.trim()
        : isCookieRecord(cookie)
          ? typeof cookie.netease === "string"
            ? cookie.netease.trim()
            : stableStringify(cookie)
          : "";
    return cookieStr
      ? `host:${createHash("sha256").update(cookieStr).digest("hex").slice(0, 16)}`
      : IP_SCOPE_ANONYMOUS;
  }

  // 每个 scope 只分配一次 IP、之后持续复用；超限按插入顺序淘汰最老的。
  // IP 被替换的唯一入口是 `rotateScopeIp`（限流兜底），正常路径下同一 scope 不会漂移。
  private ensureScopeIp(scope: string) {
    const existing = this.ipByScope.get(scope);
    if (existing) return existing;
    const ip = randomChineseIp(this.chinaIpRanges, this.random);
    this.ipByScope.set(scope, ip);
    if (this.ipByScope.size > IP_SCOPE_MAX_ENTRIES) {
      const oldest = this.ipByScope.keys().next().value;
      if (oldest !== undefined) this.ipByScope.delete(oldest);
    }
    return ip;
  }

  private withCookie(
    params: Record<string, unknown>,
    cookie?: string | Record<string, unknown>,
    randomCNIP = this.randomCNIP,
    includeAnonymousCookie = true,
    loginScope?: string,
    ipScope?: string
  ): Record<string, unknown> {
    const rawCookie =
      typeof cookie === "object" && cookie !== null && "netease" in cookie
        ? cookie.netease
        : cookie;
    const requestCookie = rawCookie ?? (includeAnonymousCookie ? this.anonymousCookie : undefined);
    // scope 由调用方在调度前算好并透传：限流发生时要按同一个 scope 刷新 IP，两处必须一致。
    const scope = ipScope ?? this.resolveIpScope(cookie, loginScope);
    return {
      ...params,
      // 始终显式传入 cookie，阻止 Enhanced API 从进程环境变量 NETEASE_COOKIE 偷读旧凭据。
      cookie: requestCookie ?? {},
      // 伪装 IP 按 scope 稳定：同一玩家、同一凭证在各自作用域内复用同一个 IP，不同玩家各持一个，
      // 避免全部请求把配额挤在同一个出口上。
      ...(randomCNIP ? { realIP: this.ensureScopeIp(scope) } : {}),
      randomCNIP,
    };
  }
}
