import { AppError } from "../domain/Errors";
import { randomUUID } from "node:crypto";
import { LRUCache } from "lru-cache";
import { describeError, type EventLogger } from "./EventLogger";
import { isCreditLyricLine, parseTTML, sanitizeLyrics } from "./LyricLines";
import { readChinaIpRanges } from "./ChinaIpRanges";
import { IP_SCOPE_ANONYMOUS, MusicIpScopeRegistry } from "./MusicIpScope";
import { AmllLyricClient } from "./AmllLyricClient";
import {
  adoptVerbatimLyrics,
  mergeTranslations,
  parseLrc,
  parseYrc,
  readLyricSources,
  type LyricChainInput,
} from "./NeteaseLyricParse";
import { MusicCache } from "./MusicCache";
import { UpstreamRequestQueue } from "./UpstreamRequestQueue";
import { asArray, asRecord, readNumber, readString } from "./JsonReaders";
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

// 保持既有 API 边界：下列符号历史上从本文件导出，拆分到独立模块后仍从这里可导入。
export { parseChinaIpRanges, randomChineseIp, readChinaIpRanges } from "./ChinaIpRanges";
export { musicIpScope, runWithAnonymousMusicIpScope } from "./MusicIpScope";
export { parseLrc, parseYrc, mergeTranslations } from "./NeteaseLyricParse";

type ApiResponse = { body?: unknown } | unknown;
type ApiFunction = (params: Record<string, unknown>) => Promise<ApiResponse>;
type ApiModule = Record<string, unknown>;

/**
 * 房间侧的取歌凭据有两种形状：只登录了一端时是裸字符串（`MUSIC_U=…`、`qm_keyst=…`），
 * 两端同时在房时是 `{ netease, qq }` 组合包，由聚合 provider 拆给各自上游。
 */
export type MusicCookieInput = string | Partial<Record<"netease" | "qq", string>>;

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
/**
 * 网易云「操作频繁」的响应码集合。
 *
 * - `405` 歌曲类接口的通用限流；
 * - `406` **登录链路限流**，文案与 405 完全一致，只认 405 会漏判整条扫码链路 ——
 *   表现为房主扫码时一直撞墙、既不退避也不提示；
 * - `429` / `503` 同一语义的其它表现形式。
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
 * 这里显式指定顺序：多平台音源 `unm` 放最前，能快速失败的放中间，慢且易伪解灰的 `bugpk` 压到最后。
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
 * 解灰音源（尤其第三方聚合站）存在「请求被丢弃、返回的 Promise 永不 settle」的情况。
 * 一旦在 `await` 上无限等待，自动出题会永久停在 `automaticRoundLoading`：房间再也开不了下一轮，
 * 客户端因为对长任务发的是 `timeout: 0`，连超时提示都没有。
 *
 * 必须同时给原 Promise 挂上 `catch`：它在超时之后才拒绝时，若没有处理器就会变成
 * unhandledRejection —— Bun 会直接终止整个进程。
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

export class NeteaseMusicProvider implements MusicProvider {
  private apiPromise?: Promise<ApiModule>;
  private readonly randomCNIP: boolean;
  private anonymousCookie?: string;
  private readonly loginStatusCache: LRUCache<string, MusicLoginSession>;
  private readonly ipScopes: MusicIpScopeRegistry;
  private readonly musicCache: MusicCache;
  private readonly requestQueue: UpstreamRequestQueue;
  private readonly amllClient: AmllLyricClient;

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

  constructor(private readonly options: NeteaseMusicProviderOptions = {}) {
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
    this.randomCNIP = options.randomCNIP ?? true;
    this.loginStatusCache = new LRUCache<string, MusicLoginSession>({
      max: LOGIN_STATUS_CACHE_MAX_ENTRIES,
      ttl: LOGIN_STATUS_REUSE_TTL_MS,
    });
    this.ipScopes = new MusicIpScopeRegistry({
      now: this.now,
      random: this.random,
      chinaIpRanges: readChinaIpRanges(),
      platformKey: "netease",
      logger: this.logger,
    });
    this.requestQueue = new UpstreamRequestQueue({
      now: this.now,
      random: this.random,
      maxConcurrentRequests: options.maxConcurrentRequests,
      minRequestIntervalMs: options.minRequestIntervalMs,
      rateLimitCooldownMs: options.rateLimitCooldownMs,
      maxRateLimitCooldownMs: options.maxRateLimitCooldownMs,
      maxQueuedRequests: options.maxQueuedRequests,
      queueTimeoutMs: options.queueTimeoutMs,
      queueFullMessage: "网易云请求排队过多，请稍后重试",
      queueTimeoutMessage: "网易云请求等待超时，请稍后重试",
      rateLimitFallbackMessage: "操作频繁，请稍候再试",
      isRateLimitError: (error) => this.isRateLimitError(error),
      readRateLimitMessage: (error, fallback) => responseMessage(responseBody(error), fallback),
      onRateLimitCooldown: ({
        scope,
        strikes,
        cooldownDurationMs,
        cooldownUntil,
        droppedQueuedRequests,
        reason,
      }) => {
        // 限流后顺手刷新该 scope 的伪装 IP，退避结束的请求换一个出口（见 Registry.rotateScopeIp）。
        this.ipScopes.rotateScopeIp(scope);
        this.logger?.warn("网易云接口触发限流退避", {
          strikes,
          cooldownDurationMs,
          cooldownUntil: new Date(cooldownUntil).toISOString(),
          droppedQueuedRequests,
          rotatedScope: scope,
          reason,
        });
      },
      createBusyError: (message, retryAfterMs) =>
        new AppError("MUSIC_API_BUSY", message, { retryAfterMs }),
      createRateLimitError: (message, retryAfterMs) =>
        new AppError("MUSIC_API_RATE_LIMITED", message, { upstreamCode: 405, retryAfterMs }),
    });
    this.musicCache = new MusicCache({
      maxEntries: options.cacheMaxEntries,
      maxBytes: options.cacheMaxBytes,
      now: this.now,
      isUpstreamBusy: () => this.requestQueue.isCoolingDown() || this.requestQueue.queuedCount > 0,
      onRefreshFailure: (key, error) => {
        this.logger?.warn("网易云缓存预刷新失败", { key, error: describeError(error) });
      },
    });
    // AMLL 官方歌词库是独立后端：并发、超时与缓存边界统一收口在共享客户端里，
    // 这里只注入网易云的 ID 查询参数名与 provider 共享缓存。
    this.amllClient = new AmllLyricClient({
      idQueryParam: "ncmMusicId",
      cacheTtlMs: SONG_LYRICS_CACHE_TTL_MS,
      cache: this.musicCache,
      logger: this.logger,
      maxConcurrentRequests: options.amllMaxConcurrentRequests,
      maxQueuedRequests: options.amllMaxQueuedRequests,
      requestTimeoutMs: options.amllRequestTimeoutMs,
      fetcher: options.amllFetcher,
      fetchById: options.fetchAmllLyrics,
      fetchBySearch: options.fetchAmllSearchLyrics,
    });
  }

  async search(
    keyword: string,
    limit = 20,
    cookie?: MusicCookieInput
  ): Promise<SongSearchResult[]> {
    const normalized = keyword.trim();
    if (!normalized) return [];
    const normalizedLimit = Math.max(1, Math.min(limit, 50));
    return this.musicCache.cached(
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
    this.musicCache.invalidate(key);
    return this.loadAudioUrl(id, cookie, true);
  }

  async getSongMetadata(songId: string, cookie?: MusicCookieInput): Promise<SongDetails> {
    const id = songId.trim();
    if (!id) throw new AppError("INVALID_SONG", "歌曲 ID 不能为空");
    return this.musicCache.cached(
      this.cacheKey("metadata", undefined, id),
      SONG_METADATA_CACHE_TTL_MS,
      () => this.loadSong(id, false, cookie)
    );
  }

  async getSongPopularity(songId: string, cookie?: MusicCookieInput): Promise<number | undefined> {
    const id = songId.trim();
    if (!id) return undefined;
    return this.musicCache.cached(
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
    return this.musicCache.cached(
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
    return this.amllClient.getTtmlLyrics(id, { songId: id });
  }

  async searchAmllTtmlLyrics(songName: string, artistName?: string): Promise<string | undefined> {
    const title = songName.trim();
    if (!title) return undefined;
    return this.amllClient.searchTtmlLyrics(title, artistName, { title });
  }

  async getPlaylistSongs(playlistId: string, cookie?: MusicCookieInput) {
    const id = playlistId.trim();
    if (!/^\d+$/.test(id)) throw new AppError("INVALID_PLAYLIST", "歌单 ID 无效");
    return this.musicCache.cached(
      this.cacheKey("playlist", cookie, id),
      COLLECTION_CACHE_TTL_MS,
      async () => {
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

        // 单页装不下的歌单必须继续翻页，否则尾部曲目永远进不了题库。
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
      }
    );
  }

  async searchArtists(keyword: string, limit = 20, cookie?: MusicCookieInput) {
    const normalized = keyword.trim();
    if (!normalized) return [];
    const normalizedLimit = Math.max(1, Math.min(limit, 50));
    return this.musicCache.cached(
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
    return this.musicCache.cached(
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
    return this.musicCache.cached(
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
    return this.musicCache.cached(
      this.cacheKey("album-songs", undefined, id),
      COLLECTION_CACHE_TTL_MS,
      async () => {
        const response = await this.call(["album"], { id }, cookie);
        const body = responseBody(response);
        const album = asRecord(body.album ?? body);
        // 曲目在**顶层** `body.songs`。`body.album.songs` 虽然存在，但在单曲 / 同名专辑上
        // 常是**空数组**——用 `??` 读它会拿到 `[]` 而不会回退到顶层，专辑路径会整条失效。
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

    this.ipScopes.setLoginScope(key, scope);
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
      this.ipScopes.deleteLoginScope(key);
      throw error;
    }
  }

  async checkQrLogin(keyValue: string): Promise<MusicQrLoginCheck> {
    const key = keyValue.trim();
    if (!key) throw new AppError("INVALID_LOGIN", "二维码登录密钥不能为空");
    // 本次轮询只认自己那个二维码对应的会话 IP，别人同时扫码不会串到这里。
    const scope = this.ipScopes.getLoginScope(key);
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
    this.ipScopes.bindSessionIp(cookie, scope);
    try {
      await this.uploadDeviceInfo(cookie, this.deviceName, scope);
      const session = await this.getLoginStatus(cookie, scope);
      return { status: "authorized", message, session };
    } finally {
      this.ipScopes.deleteLoginScope(key);
    }
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

    const detailResponse = await this.musicCache.cached(
      this.cacheKey("song-detail", undefined, id),
      SONG_METADATA_CACHE_TTL_MS,
      () => this.call(["song_detail"], { ids: id }, cookie)
    );
    const detailBody = responseBody(detailResponse);
    const rawSong = asArray(detailBody.songs)[0];
    const base = normalizeSong(rawSong);
    if (!base) throw new AppError("SONG_NOT_FOUND", "未找到歌曲信息");

    const wikiPromise = this.musicCache.cached(
      this.cacheKey("song-wiki", undefined, id),
      SONG_WIKI_CACHE_TTL_MS,
      () => this.callOptional(["song_wiki_summary", "song_wiki_home"], { id }, cookie)
    );
    const lyricPromise = includeResources
      ? this.musicCache.cached(
          this.cacheKey("song-lyrics", undefined, id),
          SONG_LYRICS_CACHE_TTL_MS,
          () => this.call(["lyric_new", "lyric"], { id }, cookie)
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
   * 冷进程第一次触碰音乐链路要顺序支付「动态导入接口包 + 注册匿名令牌 + 首个上游请求的
   * DNS/TCP 建连」，不预热会让第一位进房玩家替整个进程垫付，房间徽标长时间停在「本机已登录」。
   * 预热失败不阻断业务：只记告警，调用方照旧走惰性加载并重试。
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
    const value = await this.musicCache.cached(
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
        // 一旦被出成题目，玩家会在片段播完后对着静音猜歌，而服务端不会报任何错。
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
      const response = await this.requestQueue.scheduleRequest(
        () =>
          (api.register_anonimous as ApiFunction)({
            crypto: "weapi",
            cookie: {},
            randomCNIP: this.randomCNIP,
            ...(this.randomCNIP ? { realIP: this.ipScopes.ensureScopeIp(IP_SCOPE_ANONYMOUS) } : {}),
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
    const ipScope = this.ipScopes.resolveIpScope(cookie, loginScope, names);
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
    const response = await this.requestQueue.scheduleRequest(
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
    // 同一份 cookie 原文映射到同一个缓存 scope（sha256 前 16 位），与 IP scope 的口径一致。
    const scope = this.ipScopes.cookieFingerprint(cookie) || "anonymous";
    return [namespace, scope, ...parts].map(String).join(":");
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
    const scope = ipScope ?? this.ipScopes.resolveIpScope(cookie, loginScope);
    return {
      ...params,
      // 始终显式传入 cookie，阻止 Enhanced API 从进程环境变量 NETEASE_COOKIE 偷读旧凭据。
      cookie: requestCookie ?? {},
      // 伪装 IP 按 scope 稳定：同一玩家、同一凭证在各自作用域内复用同一个 IP，不同玩家各持一个，
      // 避免全部请求把配额挤在同一个出口上。
      ...(randomCNIP ? { realIP: this.ipScopes.ensureScopeIp(scope) } : {}),
      randomCNIP,
    };
  }
}
