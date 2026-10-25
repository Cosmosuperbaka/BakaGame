import { createHash } from "node:crypto";
import { AppError } from "../domain/Errors";
import { LRUCache } from "lru-cache";
import { parseQrc as amllParseQrc, parseLrc as amllParseLrc } from "@applemusic-like-lyrics/lyric";
import qqmusic from "qqmusic-api-enhanced";
import { describeError, type EventLogger } from "./EventLogger";
import { parseSongUrn, buildSongUrn } from "./MusicUrn";
import { parseTTML, sanitizeLyrics } from "./LyricLines";
import { asArray, asRecord, readNumber } from "./JsonReaders";
import { MusicCache } from "./MusicCache";
import { UpstreamRequestQueue } from "./UpstreamRequestQueue";
import { AmllLyricClient } from "./AmllLyricClient";
import type {
  MusicCookieInput,
  MusicLoginSession,
  MusicProvider,
  MusicQrLogin,
  MusicQrLoginCheck,
} from "./NeteaseMusicProvider";
import type {
  SongAlbumSearchResult,
  SongArtistSearchResult,
  SongChorus,
  SongDetails,
  SongLyricLine,
  SongPlaylistInfo,
  SongSearchResult,
} from "../shared/SonGuessr";

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

const SEARCH_CACHE_TTL_MS = 60 * 1000;
const ANONYMOUS_SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const ANONYMOUS_SEARCH_TIMEOUT_MS = 4000;
/** 匿名检索连续失败/空结果的上限：达到后短暂停止补充，避免持续打限流中的上游。 */
const ANONYMOUS_FAILURE_THRESHOLD = 3;
const ANONYMOUS_EMPTY_THRESHOLD = 5;
const ANONYMOUS_COOLDOWN_MS = 60 * 1000;
const SONG_METADATA_CACHE_TTL_MS = 10 * 60 * 1000;
const SONG_AUDIO_CACHE_TTL_MS = 5 * 60 * 1000;
const AMLL_LYRICS_CACHE_TTL_MS = 60 * 60 * 1000;
const LOGIN_STATUS_CACHE_TTL_MS = 2 * 60 * 1000;
/** 公共缓存（检索 / 元数据）的条目数上限，与改造前 LRU 一致。 */
const CACHE_MAX_ENTRIES = 1000;
/** AMLL 歌词缓存的条目数上限，与改造前 LRU 一致。 */
const AMLL_CACHE_MAX_ENTRIES = 500;
/** 登录态复用缓存的条目上限；每个玩家一份，超出按 LRU 淘汰。 */
const LOGIN_STATUS_CACHE_MAX_ENTRIES = 512;

/** 歌单单页曲目上限：`playlist_track_all` 的 limit 上限就是 1000（对齐网易云口径）。 */
const PLAYLIST_PAGE_SIZE = 1000;
/**
 * 歌单翻页硬上限（50 页 = 50000 首）。正常歌单远达不到，仅作兜底：
 * 上游对超范围 offset 若仍返回整页，没有上界就会一直翻下去。
 */
const PLAYLIST_MAX_PAGES = 50;

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

/**
 * 给匿名补充检索加等待上限。超时后原请求仍可能完成，因此必须提前挂一个
 * `catch`，否则迟到的拒绝会变成 unhandledRejection（Bun 会终止进程）。
 */
async function withAnonymousTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new AppError("MUSIC_API_TIMEOUT", "QQ 音乐匿名检索超时")),
      timeoutMs
    );
    (timer as { unref?: () => void }).unref?.();
  });
  void task.catch(() => {});
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const stripHtmlTags = (val: unknown): string => {
  if (typeof val !== "string") return "";
  return val.replace(/<[^>]+>/g, "").trim();
};

// QQ 音乐上游返回的是未标注类型的 JSON：通用窄化助手取自 JsonReaders（与网易云
// 同一套约定）；`readString` 留在本地——它不 trim、不接受数字，与通用版语义不同，
// 音频直链与 Cookie 判定依赖这一差异。不引入 any。

/** 按顺序取第一个对象；用于 `data.body / body / data / 顶层` 这类历史形状兜底链。 */
const firstRecord = (...values: unknown[]): Record<string, unknown> => {
  for (const value of values) {
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  }
  return {};
};

/** 列表字段有时直接是数组，有时包一层 `{ items: [...] }`；非对象项归一成空记录。 */
const readRecords = (value: unknown): Record<string, unknown>[] => {
  const list = Array.isArray(value) ? value : asArray(asRecord(value).items);
  return list.map((entry) => asRecord(entry));
};

const readString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

/** 取标量字段并转文本（上游 mid 只可能是字符串或数字）；对象与空值按缺失处理。 */
const readText = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
};

/**
 * 是否必须会员账号才能在线播放。
 *
 * `pay_down` 只约束下载，计入播放门槛会把 `pay_play=0` 的可播曲误标成会员专享；
 * `time_free=1` 是限时免费，此时即使 `pay_play=1` 也先放行，交给真实音频判定兜底。
 */
const requiresVipAccount = (pay: Record<string, unknown>): boolean =>
  Number(pay.pay_play) === 1 && Number(pay.time_free) !== 1;

/** 歌手字段是对象数组（`name` / `title` 两种键），也见过裸字符串。 */
const singerNames = (value: unknown): string[] => {
  if (typeof value === "string") return [stripHtmlTags(value)];
  return asArray(value).map((singer) => {
    const record = asRecord(singer);
    return stripHtmlTags(record.name || record.title);
  });
};

/** QQ 音乐专辑封面的固定 CDN 路径按 albumId 取模分桶。 */
const albumPictureUrl = (albumId: number): string | undefined =>
  albumId
    ? `https://imgcache.qq.com/music/photo/album_500/${albumId % 100}/500_albumpic_${albumId}_0.jpg`
    : undefined;

/**
 * 从 XML 包裹的 QRC 中剥出 `LyricContent` 属性值；已是裸格式则原样返回。
 *
 * 属性值里的 `\n` 是字面量转义（XML 属性不能含真实换行），需还原成真实换行，
 * 否则所有行会被拼成一行。
 *
 * 必须「提取属性值」而非「剔除标签」：剥离标签的正则会把开标签、结尾自闭合
 * 与两者之间的整段歌词一并吃掉，结果为空。
 */
export const extractQrcPayload = (raw: string): string => {
  const attr = /LyricContent="([\s\S]*?)"/.exec(raw);
  const payload = attr ? attr[1] : raw;
  return payload.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
};

/**
 * 解析 QQ 音乐逐字歌词（QRC）。
 *
 * 上游有两种形态：裸 QRC 文本（`[行起,行长]字(起,长)...`），以及被
 * `<QrcInfos><LyricInfo><Lyric_1 LyricContent="...">` 包裹的 XML（解密后的原始返回）。
 * AMLL 的 `parseQrc` 只认裸格式，直接喂 XML 会得到空数组 —— 因此这里先剥出
 * `LyricContent` 属性值，再交给 `parseQrc`，两种形态都能解析。
 */
export const parseQrcLyrics = (raw: string): SongLyricLine[] => {
  if (!raw || !raw.trim()) return [];
  const normalized = extractQrcPayload(raw);
  try {
    const amllLines = amllParseQrc(normalized);
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
  } catch {
    return [];
  }
};

export const parseLrcLyrics = (raw: string): SongLyricLine[] => {
  if (!raw || !raw.trim()) return [];
  try {
    const amllLines = amllParseLrc(raw);
    return amllLines
      .map((line) => {
        const text =
          line.words && line.words.length > 0
            ? line.words
                .map((w) => w.word)
                .join("")
                .trim()
            : "";
        return {
          time: line.startTime,
          endTime: line.endTime,
          text,
          translatedLyric: line.translatedLyric || undefined,
          romanLyric: line.romanLyric || undefined,
        };
      })
      .filter((line) => line.text.length > 0);
  } catch {
    return [];
  }
};

const extractQqCookie = (cookie?: MusicCookieInput): string | undefined => {
  if (typeof cookie === "string") return cookie;
  if (typeof cookie !== "object" || cookie === null) return undefined;
  const val = cookie.qq;
  return typeof val === "string" ? val : undefined;
};

/** 匿名检索熔断的结算回调：已登录检索不需要计数，走这份空实现。 */
interface SearchSettlementNotes {
  onSettled: (resultCount: number) => void;
  onFailure: () => void;
}

const NO_OP_SEARCH_NOTES: SearchSettlementNotes = {
  onSettled: () => {},
  onFailure: () => {},
};

/** 检索结果条目的字段映射（`body.songs` / `data.body.item_song` 两种形状归一后）。 */
const normalizeSearchSong = (item: Record<string, unknown>): SongSearchResult => {
  const mid = readText(item.mid || item.songmid);
  const rawTitle = readText(item.title || item.name || item.songname);
  const title = stripHtmlTags(rawTitle);
  const artist = singerNames(item.singer).filter(Boolean).join(" / ");
  const album = asRecord(item.album);
  const rawAlbum = album.name || album.title || item.albumname || undefined;
  const albumName = rawAlbum ? stripHtmlTags(rawAlbum) || undefined : undefined;
  const durationMs = Number(item.interval || 0) * 1000;

  return {
    id: buildSongUrn("qq", mid),
    title,
    artist: artist || "未知歌手",
    album: albumName,
    pictureUrl: albumPictureUrl(Number(album.id || item.albumid)),
    durationMs: durationMs > 0 ? durationMs : undefined,
    requiresVip: requiresVipAccount(asRecord(item.pay)),
  };
};

export class QQMusicProvider implements MusicProvider {
  private readonly musicCache: MusicCache;
  private readonly requestQueue: UpstreamRequestQueue;
  private readonly anonymousQueue: UpstreamRequestQueue;
  private readonly amllClient: AmllLyricClient;
  /** 登录态复用与网易云同口径：普通 LRU + 单 TTL，不进软/硬双 TTL 的公共缓存。 */
  private readonly loginStatusCache: LRUCache<string, MusicLoginSession>;
  private readonly options: QQMusicProviderOptions;
  private readonly now: () => number;
  private anonymousFailureStreak = 0;
  private anonymousEmptyStreak = 0;
  private anonymousBlockedUntil = 0;
  private warmupPromise?: Promise<void>;

  constructor(options: QQMusicProviderOptions = {}) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    const random = options.random ?? { nextFloat: () => Math.random() };
    this.requestQueue = new UpstreamRequestQueue({
      now: this.now,
      random,
      maxConcurrentRequests: options.maxConcurrentRequests ?? 4,
      minRequestIntervalMs: options.minRequestIntervalMs,
      rateLimitCooldownMs: options.rateLimitCooldownMs,
      maxRateLimitCooldownMs: options.maxRateLimitCooldownMs,
      maxQueuedRequests: options.maxQueuedRequests,
      queueTimeoutMs: options.queueTimeoutMs,
      queueFullMessage: "QQ音乐请求排队过多，请稍后重试",
      queueTimeoutMessage: "QQ音乐请求等待超时，请稍后重试",
      rateLimitFallbackMessage: QQ_RATE_LIMIT_FALLBACK_MESSAGE,
      isRateLimitError: (error) => this.isRateLimitError(error),
      readRateLimitMessage: (error, fallback) => this.readUpstreamMessage(error, fallback),
      onRateLimitCooldown: ({
        strikes,
        cooldownDurationMs,
        cooldownUntil,
        droppedQueuedRequests,
        reason,
      }) => {
        this.options.logger?.warn?.("QQ音乐接口触发限流退避", {
          strikes,
          cooldownDurationMs,
          cooldownUntil: new Date(cooldownUntil).toISOString(),
          droppedQueuedRequests,
          reason,
        });
      },
      createBusyError: (message, retryAfterMs) =>
        new AppError("MUSIC_API_BUSY", message, { retryAfterMs }),
      createRateLimitError: (message, retryAfterMs) =>
        new AppError("MUSIC_API_RATE_LIMITED", message, { retryAfterMs }),
    });
    this.anonymousQueue = new UpstreamRequestQueue({
      now: this.now,
      random,
      maxConcurrentRequests: options.anonymousMaxConcurrentRequests ?? 1,
      minRequestIntervalMs: options.minRequestIntervalMs,
      rateLimitCooldownMs: options.rateLimitCooldownMs,
      maxRateLimitCooldownMs: options.maxRateLimitCooldownMs,
      maxQueuedRequests: options.maxQueuedRequests,
      queueTimeoutMs: options.queueTimeoutMs,
      queueFullMessage: "QQ音乐匿名请求排队过多，请稍后重试",
      queueTimeoutMessage: "QQ音乐匿名请求等待超时，请稍后重试",
      rateLimitFallbackMessage: QQ_RATE_LIMIT_FALLBACK_MESSAGE,
      isRateLimitError: (error) => this.isRateLimitError(error),
      readRateLimitMessage: (error, fallback) => this.readUpstreamMessage(error, fallback),
      onRateLimitCooldown: ({
        strikes,
        cooldownDurationMs,
        cooldownUntil,
        droppedQueuedRequests,
        reason,
      }) => {
        this.options.logger?.warn?.("QQ音乐匿名请求触发限流退避", {
          strikes,
          cooldownDurationMs,
          cooldownUntil: new Date(cooldownUntil).toISOString(),
          droppedQueuedRequests,
          reason,
        });
      },
      createBusyError: (message, retryAfterMs) =>
        new AppError("MUSIC_API_BUSY", message, { retryAfterMs }),
      createRateLimitError: (message, retryAfterMs) =>
        new AppError("MUSIC_API_RATE_LIMITED", message, { retryAfterMs }),
    });
    this.musicCache = new MusicCache({
      maxEntries: options.cacheMaxEntries ?? CACHE_MAX_ENTRIES,
      maxBytes: options.cacheMaxBytes,
      now: this.now,
      // 匿名熔断期内同样跳过主动刷新：熔断说明匿名上游正被限流，后台刷新只会火上浇油。
      isUpstreamBusy: () =>
        this.requestQueue.isCoolingDown() ||
        this.requestQueue.queuedCount > 0 ||
        this.anonymousQueue.isCoolingDown() ||
        this.anonymousQueue.queuedCount > 0 ||
        this.anonymousCircuitOpen(),
      onRefreshFailure: (key, error) => {
        this.options.logger?.warn?.("QQ音乐缓存预刷新失败", {
          key,
          error: describeError(error),
        });
      },
    });
    this.amllClient = new AmllLyricClient({
      idQueryParam: "qqMusicId",
      cacheTtlMs: AMLL_LYRICS_CACHE_TTL_MS,
      cache: new MusicCache({
        maxEntries: options.amllCacheMaxEntries ?? AMLL_CACHE_MAX_ENTRIES,
        now: this.now,
        isUpstreamBusy: () =>
          this.requestQueue.isCoolingDown() ||
          this.anonymousQueue.isCoolingDown() ||
          this.anonymousCircuitOpen(),
        onRefreshFailure: (key, error) => {
          this.options.logger?.warn?.("AMLL 歌词缓存预刷新失败", {
            key,
            error: describeError(error),
          });
        },
      }),
      logger: options.logger,
      maxConcurrentRequests: options.amllMaxConcurrentRequests,
      maxQueuedRequests: options.amllMaxQueuedRequests,
      requestTimeoutMs: options.amllRequestTimeoutMs ?? 4_000,
      fetcher: options.amllFetcher,
      fetchById: options.fetchAmllLyrics,
      fetchBySearch: options.fetchAmllSearchLyrics,
    });
    this.loginStatusCache = new LRUCache<string, MusicLoginSession>({
      max: LOGIN_STATUS_CACHE_MAX_ENTRIES,
      ttl: LOGIN_STATUS_CACHE_TTL_MS,
    });
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
  private async callUpstream<T>(cookie: string | undefined, task: () => Promise<T>): Promise<T> {
    const response = await this.queueFor(cookie).scheduleRequest(task);
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

  private anonymousCircuitOpen(): boolean {
    return this.now() < this.anonymousBlockedUntil;
  }

  private noteAnonymousSearchResult(keyword: string, resultCount: number): void {
    if (resultCount > 0) {
      this.anonymousFailureStreak = 0;
      this.anonymousEmptyStreak = 0;
      return;
    }
    this.anonymousFailureStreak = 0;
    this.anonymousEmptyStreak += 1;
    if (this.anonymousEmptyStreak >= ANONYMOUS_EMPTY_THRESHOLD) this.openAnonymousCircuit(keyword);
  }

  private noteAnonymousSearchFailure(keyword: string): void {
    this.anonymousEmptyStreak = 0;
    this.anonymousFailureStreak += 1;
    if (this.anonymousFailureStreak >= ANONYMOUS_FAILURE_THRESHOLD) {
      this.openAnonymousCircuit(keyword);
    }
  }

  private openAnonymousCircuit(keyword: string): void {
    this.anonymousFailureStreak = 0;
    this.anonymousEmptyStreak = 0;
    this.anonymousBlockedUntil = this.now() + ANONYMOUS_COOLDOWN_MS;
    this.options.logger?.warn?.("QQ 音乐匿名检索连续失败，暂时熔断", {
      keyword,
      cooldownMs: ANONYMOUS_COOLDOWN_MS,
    });
  }

  private resolveMid(songId: string): string {
    const trimmed = songId.trim();
    if (!trimmed) throw new AppError("INVALID_SONG", "歌曲 ID 不能为空");
    if (trimmed.includes(":")) {
      const parsed = parseSongUrn(trimmed);
      if (parsed.platform !== "qq") {
        throw new AppError(
          "INVALID_PLATFORM",
          `QQMusicProvider 仅处理 qq 平台歌曲，收到: ${songId}`
        );
      }
      return parsed.rawId;
    }
    return trimmed;
  }

  async search(
    keyword: string,
    limit = 20,
    rawCookie?: MusicCookieInput
  ): Promise<SongSearchResult[]> {
    const cookie = extractQqCookie(rawCookie);
    const normalized = keyword.trim();
    if (!normalized) return [];
    const normalizedLimit = Math.max(1, Math.min(limit, 50));
    // 检索结果是公开数据，不随账号变化；跨账号共享缓存，避免账号池多号时同一关键词
    // 反复打上游。音频直链与登录态仍然按 Cookie 分键（见 loadAudioUrl / loginStatusCache）。
    const cacheKey = `search:${normalized.toLowerCase()}:${normalizedLimit}`;

    // 熔断只拦“要回源”的请求：缓存命中（含软过期）照常服务，与改造前
    // “先查缓存、未命中才看熔断”的顺序一致。
    const hit = this.musicCache.peek<SongSearchResult[]>(cacheKey);
    if (hit) return hit;

    if (!cookie && this.anonymousCircuitOpen()) {
      this.options.logger?.debug?.("QQ 音乐匿名检索处于熔断期，本轮跳过", {
        keyword: normalized,
      });
      return [];
    }

    // 匿名空结果可能只是上游限流，不能按「公共检索结果」缓存 5 分钟：
    // 否则限流恢复后同一关键词还会继续空一段时间。空结果沿用普通短 TTL。
    const anonymousTtl = this.options.anonymousSearchCacheTtlMs ?? ANONYMOUS_SEARCH_CACHE_TTL_MS;
    // 匿名检索才需要熔断计数；计数只统计前台请求，缓存维护触发的后台刷新不推进熔断。
    const notes = cookie ? NO_OP_SEARCH_NOTES : this.anonymousSearchNotes(normalized);
    return this.musicCache.cached(
      cacheKey,
      cookie ? SEARCH_CACHE_TTL_MS : anonymousTtl,
      () => this.runSearchTask(normalized, normalizedLimit, cookie, notes),
      {
        ttlForResult: cookie
          ? undefined
          : (result) => (result.length > 0 ? anonymousTtl : SEARCH_CACHE_TTL_MS),
      }
    );
  }

  /** 匿名熔断计数的“只计前台”包装：同一 loader 被后台刷新复用时不再计数。 */
  private anonymousSearchNotes(keyword: string): SearchSettlementNotes {
    let foreground = true;
    const consume = () => {
      const wasForeground = foreground;
      foreground = false;
      return wasForeground;
    };
    return {
      onSettled: (resultCount) => {
        if (consume()) this.noteAnonymousSearchResult(keyword, resultCount);
      },
      onFailure: () => {
        if (consume()) this.noteAnonymousSearchFailure(keyword);
      },
    };
  }

  private async runSearchTask(
    normalized: string,
    normalizedLimit: number,
    cookie: string | undefined,
    notes: SearchSettlementNotes
  ): Promise<SongSearchResult[]> {
    const task = this.fetchSearchUpstream(normalized, normalizedLimit, cookie);
    try {
      const settled = cookie
        ? await task
        : await withAnonymousTimeout(
            task,
            this.options.anonymousSearchTimeoutMs ?? ANONYMOUS_SEARCH_TIMEOUT_MS
          );
      const result = settled ?? [];
      notes.onSettled(result.length);
      return result;
    } catch (error) {
      notes.onFailure();
      throw error;
    }
  }

  private async fetchSearchUpstream(
    normalized: string,
    normalizedLimit: number,
    cookie: string | undefined
  ): Promise<SongSearchResult[]> {
    // 先过 callUpstream 再映射：限流形态挂在原始响应封面上，映射后的数组看不出来。
    const res = await this.callUpstream(cookie, () =>
      qqmusic.search({
        keywords: normalized,
        limit: normalizedLimit,
        cookie,
      })
    );

    const body = asRecord(res.body);
    const dataBody = firstRecord(asRecord(body.data).body, body.body, body.data, body);
    const rawSongs = readRecords(body.songs || dataBody.item_song || asRecord(dataBody.song).list);
    // 先剔除无 mid 的脏项再映射：`buildSongUrn` 对空 id 抛异常，若不预过滤，
    // 上游返回的任意一条缺 mid 记录都会让整次搜索失败（而非只丢那一条）。
    return rawSongs
      .filter((item) => readText(item.mid || item.songmid))
      .map((item) => normalizeSearchSong(item))
      .filter((s) => s.id && s.title);
  }

  async getSong(songId: string, rawCookie?: MusicCookieInput): Promise<SongDetails> {
    const cookie = extractQqCookie(rawCookie);
    const mid = this.resolveMid(songId);
    const meta = await this.getSongMetadata(mid, cookie);

    let lyrics = meta.lyrics;
    if (!lyrics || lyrics.length === 0) {
      lyrics = await this.loadLyrics(mid, meta, cookie);
    }

    return {
      ...meta,
      audioUrl: await this.loadAudioUrl(mid, cookie),
      lyrics,
    };
  }

  async refreshSongAudio(songId: string, rawCookie?: MusicCookieInput): Promise<string> {
    const cookie = extractQqCookie(rawCookie);
    const mid = this.resolveMid(songId);
    this.musicCache.invalidate(`audio:${this.audioCacheScope(cookie)}:${mid}`);
    return this.loadAudioUrl(mid, cookie, true);
  }

  async getSongMetadata(songId: string, rawCookie?: MusicCookieInput): Promise<SongDetails> {
    const cookie = extractQqCookie(rawCookie);
    const mid = this.resolveMid(songId);
    const details = await this.musicCache.cached(
      `metadata:${mid}`,
      SONG_METADATA_CACHE_TTL_MS,
      () => this.fetchSongMetadata(mid, cookie)
    );
    if (!details) throw new AppError("INVALID_SONG", `未能加载歌曲元数据: ${mid}`);
    return details;
  }

  private async fetchSongMetadata(mid: string, cookie?: string): Promise<SongDetails> {
    // 详情请求单独占一个队列位；映射与歌词链路在队列外进行——歌词请求还要自己排队，
    // 嵌在同一个任务里会在匿名队列（并发 1）上自我死锁。
    const detailRes = await this.callUpstream(cookie, () =>
      qqmusic.song_detail({ id: mid, cookie })
    );
    const body = asRecord(detailRes.body);
    const data = asRecord(body.data);
    const rawTrack = firstRecord(
      data.track_info,
      asRecord(asRecord(data.songinfo).data).track_info,
      data
    );

    const title = stripHtmlTags(rawTrack.name || rawTrack.title || "");
    if (!title) {
      throw new AppError("INVALID_SONG", `未找到 QQ 音乐歌曲信息: ${mid}`);
    }

    const artist = singerNames(rawTrack.singer).filter(Boolean).join(" / ");
    const album = asRecord(rawTrack.album);
    const rawAlbum = album.name || album.title || undefined;
    const albumName = rawAlbum ? stripHtmlTags(rawAlbum) || undefined : undefined;
    const durationMs = Number(rawTrack.interval || 0) * 1000;
    const releaseYear = rawTrack.time_public
      ? Number(readText(rawTrack.time_public).slice(0, 4))
      : undefined;

    const baseDetails: SongDetails = {
      id: buildSongUrn("qq", mid),
      title,
      artist: artist || "未知歌手",
      album: albumName,
      pictureUrl: albumPictureUrl(Number(album.id)),
      durationMs: durationMs > 0 ? durationMs : undefined,
      requiresVip: requiresVipAccount(asRecord(rawTrack.pay)),
      audioUrl: "",
      lyrics: [],
      releaseYear: Number.isFinite(releaseYear) ? releaseYear : undefined,
      encyclopedia: { tags: [] },
    };

    baseDetails.lyrics = await this.loadLyrics(mid, baseDetails, cookie);
    return baseDetails;
  }

  async getSongPopularity(
    songId: string,
    rawCookie?: MusicCookieInput
  ): Promise<number | undefined> {
    const cookie = extractQqCookie(rawCookie);
    const mid = this.resolveMid(songId);
    const meta = await this.getSongMetadata(mid, cookie);
    return meta.popularity;
  }

  async getSongChorus(
    songId: string,
    rawCookie?: MusicCookieInput
  ): Promise<SongChorus | undefined> {
    const cookie = extractQqCookie(rawCookie);
    const mid = this.resolveMid(songId);
    const meta = await this.getSongMetadata(mid, cookie);
    return meta.chorus;
  }

  /** 播放地址按 Cookie 指纹分键（原文不进缓存键），匿名请求共用同一桶。 */
  private audioCacheScope(cookie?: string): string {
    const value = cookie?.trim();
    if (!value) return "anonymous";
    return createHash("sha256").update(value).digest("hex").slice(0, 16);
  }

  private async loadAudioUrl(mid: string, cookie?: string, force = false): Promise<string> {
    const cacheKey = `audio:${this.audioCacheScope(cookie)}:${mid}`;
    const audioUrl = await this.musicCache.cached(
      cacheKey,
      SONG_AUDIO_CACHE_TTL_MS,
      async () => {
        // 多级音质优雅降级链：有 Cookie 时优先尝试 320k，不可用或无 Cookie 时降级至标准 128k，再降级至 m4a (AAC)
        // 严禁采纳幽灵前缀 RS02（该前缀在 CDN 上恒为 404）
        const qualities = cookie ? ["320", "128", "m4a"] : ["128", "m4a"];

        for (const quality of qualities) {
          try {
            const res = await this.callUpstream(cookie, async () =>
              qqmusic.song_url({
                id: mid,
                type: quality,
                cookie,
              })
            );

            const url = asRecord(asArray(asRecord(res.body).data)[0]).url;
            if (typeof url === "string" && url && !url.includes("RS02")) {
              return url;
            }
          } catch (error) {
            // 限流 / 本地拥塞不是「这一档没货」：继续试下一档只会撞冷却，报错也会
            // 被最后的 SONG_UNAVAILABLE 掩盖，玩家看到的错误原因就错了。
            if (
              error instanceof AppError &&
              (error.code === "MUSIC_API_RATE_LIMITED" || error.code === "MUSIC_API_BUSY")
            ) {
              throw error;
            }
            this.options.logger?.warn?.("QQ音乐获取音频直链单档位尝试失败", {
              mid,
              quality,
              ...describeError(error),
            });
          }
        }

        throw new AppError("SONG_UNAVAILABLE", `该歌曲暂无可用播放音频: ${mid}`);
      },
      { force, priority: 4 }
    );

    if (!audioUrl) {
      throw new AppError("SONG_UNAVAILABLE", `无法获取音频直链: ${mid}`);
    }
    return audioUrl;
  }

  private async loadLyrics(
    mid: string,
    base: Pick<SongSearchResult, "title" | "artist" | "album">,
    cookie?: string
  ): Promise<SongLyricLine[]> {
    // 严格遵循优先级标准：AMLL 官方 TTML > 平台原生逐字 (QRC) > 普通歌词 (LRC)

    // 1. 尝试 AMLL 官方歌词库通过 qqMusicId / mid 匹配
    try {
      const ttmlById = await this.amllClient.getTtmlLyrics(mid, { songId: mid });
      if (ttmlById) {
        const parsed = parseTTML(ttmlById);
        if (parsed.length > 0) {
          return sanitizeLyrics(parsed, base);
        }
      }
    } catch (error) {
      this.options.logger?.warn?.("AMLL qqMusicId 匹配失败", { mid, ...describeError(error) });
    }

    // 2. 尝试 AMLL 官方歌词库按歌曲名与歌手检索
    try {
      const ttmlBySearch = await this.amllClient.searchTtmlLyrics(base.title, base.artist, {
        title: base.title,
      });
      if (ttmlBySearch) {
        const parsed = parseTTML(ttmlBySearch);
        if (parsed.length > 0) {
          return sanitizeLyrics(parsed, base);
        }
      }
    } catch (error) {
      this.options.logger?.warn?.("AMLL 歌曲名搜索匹配失败", {
        title: base.title,
        ...describeError(error),
      });
    }

    // 3. 尝试 QQ 音乐原生逐字歌词 (QRC via parseQrc)
    try {
      const lyricRes = await this.callUpstream(cookie, async () =>
        qqmusic.lyric({ id: mid, qrc: true, cookie })
      );
      const body = asRecord(lyricRes.body);
      const rawQrc = readString(body.lyric);
      if (rawQrc?.includes("<QrcInfos>")) {
        const parsed = parseQrcLyrics(rawQrc);
        if (parsed.length > 0) {
          return sanitizeLyrics(parsed, base);
        }
      }

      // 4. 普通 LRC 歌词降级
      const rawLrc = readString(body.lyric) ?? readString(asRecord(body.raw).lyric);
      if (rawLrc) {
        const parsed = parseLrcLyrics(rawLrc);
        if (parsed.length > 0) {
          return sanitizeLyrics(parsed, base);
        }
      }
    } catch (error) {
      this.options.logger?.warn?.("QQ 音乐平台原生歌词拉取失败", { mid, ...describeError(error) });
    }

    return [];
  }

  async getAmllTtmlLyrics(songId: string): Promise<string | undefined> {
    const mid = this.resolveMid(songId);
    return this.amllClient.getTtmlLyrics(mid, { songId: mid });
  }

  async searchAmllTtmlLyrics(songName: string, artistName?: string): Promise<string | undefined> {
    return this.amllClient.searchTtmlLyrics(songName, artistName, { title: songName.trim() });
  }

  async getPlaylistSongs(
    playlistId: string,
    rawCookie?: MusicCookieInput
  ): Promise<{ info: SongPlaylistInfo; songs: SongSearchResult[] }> {
    const cookie = extractQqCookie(rawCookie);
    const trimmed = playlistId.trim();
    // 提取纯数字歌单 ID
    const match = trimmed.match(/\b(\d{7,12})\b/);
    const dissId = match ? match[1] : trimmed.replace(/\D/g, "");
    if (!dissId) {
      throw new AppError("INVALID_PLAYLIST", `无效的 QQ 音乐歌单 ID: ${playlistId}`);
    }

    const detailRes = await this.callUpstream(cookie, async () =>
      qqmusic.playlist_detail({ id: dissId, cookie })
    );
    const detailBody = asRecord(detailRes.body);
    const dirinfo = firstRecord(detailBody.dirinfo, asRecord(detailBody.data).dirinfo);
    const dissName = stripHtmlTags(dirinfo.title || dirinfo.dissname || "") || "QQ音乐歌单";

    const songs: SongSearchResult[] = [];
    const seenMids = new Set<string>();
    const collect = (rawSongs: unknown[]): number => {
      let added = 0;
      for (const raw of rawSongs) {
        const item = asRecord(raw);
        const mid = readText(item.songmid || item.mid);
        if (!mid || seenMids.has(mid)) continue;
        const rawTitle = readText(item.songname || item.name || item.title);
        const title = stripHtmlTags(rawTitle);
        const artist = singerNames(item.singer).filter(Boolean).join(" / ");
        const album = asRecord(item.album);
        const rawAlbum = item.albumname || album.name || undefined;
        const albumName = rawAlbum ? stripHtmlTags(rawAlbum) || undefined : undefined;
        const durationMs = Number(item.interval || 0) * 1000;
        if (!title) continue;
        seenMids.add(mid);
        songs.push({
          id: buildSongUrn("qq", mid),
          title,
          artist: artist || "未知歌手",
          album: albumName,
          pictureUrl: albumPictureUrl(Number(item.albumid || album.id)),
          durationMs: durationMs > 0 ? durationMs : undefined,
          requiresVip: requiresVipAccount(asRecord(item.pay)),
        });
        added += 1;
      }
      return added;
    };

    // 单页装不下的歌单必须继续翻页（对齐网易云 getPlaylistSongs 的翻页口径）：
    // 按 `song_begin` 偏移逐页取，按 mid 去重；曲目总数优先读全量接口的 total。
    const fetchPage = (offset: number) =>
      this.callUpstream(cookie, async () =>
        qqmusic.playlist_track_all({ id: dissId, limit: PLAYLIST_PAGE_SIZE, offset, cookie })
      );

    const firstBody = asRecord((await fetchPage(0)).body);
    const firstRawSongs = readRecords(firstBody.songs);
    // 部分歌单的曲目只挂在 playlist_detail 的 songlist 上，保留改造前的兜底形状。
    const firstAdded = collect(
      firstRawSongs.length ? firstRawSongs : readRecords(detailBody.songlist)
    );
    const songCount = readNumber(firstBody.total);

    // 翻页失败只结束翻页、保留已取到的曲目；「本页没有新增曲目」或「不足一页」即停，
    // 避免上游对超范围 offset 仍返回整页时无限翻下去。
    for (let page = 1; page < PLAYLIST_MAX_PAGES && firstAdded > 0; page += 1) {
      if (songCount !== undefined && songs.length >= songCount) break;
      let pageRes: Awaited<ReturnType<typeof fetchPage>>;
      try {
        pageRes = await fetchPage(page * PLAYLIST_PAGE_SIZE);
      } catch (error) {
        this.options.logger?.warn?.("QQ音乐歌单翻页失败，保留已取曲目", {
          dissId,
          page,
          ...describeError(error),
        });
        break;
      }
      const rawSongs = readRecords(asRecord(pageRes.body).songs);
      const added = collect(rawSongs);
      if (added === 0 || rawSongs.length < PLAYLIST_PAGE_SIZE) break;
    }

    const info: SongPlaylistInfo = {
      id: buildSongUrn("qq", dissId),
      name: dissName,
      songCount: songCount ?? songs.length,
    };
    return { info, songs };
  }

  async searchArtists(
    keyword: string,
    limit = 20,
    rawCookie?: MusicCookieInput
  ): Promise<SongArtistSearchResult[]> {
    const cookie = extractQqCookie(rawCookie);
    const normalized = keyword.trim();
    if (!normalized) return [];

    const searchRes = await this.callUpstream(cookie, () =>
      qqmusic.search({ keywords: normalized, type: 1, limit, cookie })
    );
    const searchResBody = asRecord(searchRes.body);
    const dataBody = firstRecord(
      asRecord(searchResBody.data).body,
      searchResBody.body,
      searchResBody.data,
      searchResBody
    );
    const items = readRecords(dataBody.singer || dataBody.item_singer);

    return items
      .filter((item) => readText(item.singerMID || item.mid))
      .map((item): SongArtistSearchResult => {
        const singerMid = readText(item.singerMID || item.mid);
        const singerId = Number(item.singerID || item.id);
        const avatarUrl = singerId
          ? `https://imgcache.qq.com/music/photo/singer_300/${singerId % 100}/300_singerpic_${singerId}_0.jpg`
          : undefined;

        return {
          id: buildSongUrn("qq", singerMid),
          name: stripHtmlTags(item.singerName || item.name || "") || "未知歌手",
          avatarUrl,
        };
      });
  }

  async getArtistSongs(
    artistId: string,
    rawCookie?: MusicCookieInput
  ): Promise<SongSearchResult[]> {
    const cookie = extractQqCookie(rawCookie);
    const mid = this.resolveMid(artistId);
    const songsRes = await this.callUpstream(cookie, () =>
      qqmusic.artist_songs({ id: mid, limit: 100, cookie })
    );
    const songsBody = asRecord(songsRes.body);
    const rawSongs = readRecords(songsBody.songs || asRecord(songsBody.data).songList);

    return rawSongs
      .filter((item) => readText(asRecord(item.songInfo).mid || item.mid))
      .map((item): SongSearchResult => {
        const songInfo = asRecord(item.songInfo);
        const songMid = readText(songInfo.mid || item.mid);
        const rawTitle = readText(songInfo.name || songInfo.title || item.name);
        const title = stripHtmlTags(rawTitle);
        const singerValue = songInfo.singer || item.singer;
        const artist = Array.isArray(singerValue)
          ? singerNames(singerValue).filter(Boolean).join(" / ")
          : "未知歌手";
        const songInfoAlbum = asRecord(songInfo.album);
        const itemAlbum = asRecord(item.album);
        const rawAlbum = songInfoAlbum.name || itemAlbum.name || undefined;
        const albumName = rawAlbum ? stripHtmlTags(rawAlbum) || undefined : undefined;
        const durationMs = Number(songInfo.interval || item.interval || 0) * 1000;

        return {
          id: buildSongUrn("qq", songMid),
          title,
          artist,
          album: albumName,
          pictureUrl: albumPictureUrl(Number(songInfoAlbum.id || itemAlbum.id)),
          durationMs: durationMs > 0 ? durationMs : undefined,
        };
      })
      .filter((s) => s.id && s.title);
  }

  async searchAlbums(
    keyword: string,
    limit = 10,
    rawCookie?: MusicCookieInput
  ): Promise<SongAlbumSearchResult[]> {
    const cookie = extractQqCookie(rawCookie);
    const normalized = keyword.trim();
    if (!normalized) return [];

    const searchRes = await this.callUpstream(cookie, () =>
      qqmusic.search({ keywords: normalized, type: 2, limit, cookie })
    );
    const searchResBody = asRecord(searchRes.body);
    const dataBody = firstRecord(
      asRecord(searchResBody.data).body,
      searchResBody.body,
      searchResBody.data,
      searchResBody
    );
    const items = readRecords(dataBody.item_album || dataBody.album);

    return items
      .filter((item) => readText(item.albumMID || item.mid))
      .map((item): SongAlbumSearchResult => {
        const albumMid = readText(item.albumMID || item.mid);
        const albumId = Number(item.albumID || item.id);

        return {
          id: buildSongUrn("qq", albumMid),
          name: stripHtmlTags(item.albumName || item.name || "") || "未知专辑",
          artist: Array.isArray(item.singer) ? singerNames(item.singer).join(" / ") : undefined,
          pictureUrl: albumPictureUrl(albumId),
          songCount: readNumber(item.song_count || item.total_song_num),
        };
      });
  }

  async getAlbumSongs(albumId: string, rawCookie?: MusicCookieInput): Promise<SongSearchResult[]> {
    const cookie = extractQqCookie(rawCookie);
    const mid = this.resolveMid(albumId);
    const searchRes = await this.search(mid, 50, cookie);
    return searchRes;
  }

  async createQrLogin(
    _platform?: "netease" | "qq",
    type: "qq" | "wx" | "mobile" = "qq"
  ): Promise<MusicQrLogin> {
    const qrType = type || "qq";
    const res = await this.callUpstream(undefined, () => qqmusic.login_qr_create({ type: qrType }));
    const body = asRecord(res.body);
    let key: string;
    if (qrType === "qq") {
      const qrsig = readText(body.qrsig);
      const ptqrtoken = readText(body.ptqrtoken);
      key = `${qrsig}:::${ptqrtoken}`;
    } else if (qrType === "wx") {
      key = readText(body.uuid);
    } else {
      key = readText(body.qrcodeID);
    }
    if (qrType === "qq") {
      return {
        key,
        qrUrl: readText(body.url),
        qrImage: readText(body.qrimg),
      };
    }
    if (qrType === "wx") {
      const uuid = readText(body.uuid);
      const qrurl = readString(body.qrurl) || `https://open.weixin.qq.com/connect/qrcode/${uuid}`;
      return {
        key: uuid,
        qrUrl: qrurl,
        qrImage: qrurl,
      };
    }
    // mobile
    return {
      key,
      qrUrl: "https://y.qq.com",
      qrImage: readText(body.qrcode),
    };
  }

  async checkQrLogin(
    key: string,
    _platform?: "netease" | "qq",
    type: "qq" | "wx" | "mobile" = "qq"
  ): Promise<MusicQrLoginCheck> {
    const qrType = type || "qq";
    const [qrsig, ptqrtoken] = key.split(":::");
    const res = await this.callUpstream(undefined, () =>
      qqmusic.login_qr_check(
        qrType === "qq"
          ? { type: "qq", qrsig, ptqrtoken: ptqrtoken || undefined }
          : qrType === "wx"
            ? { type: "wx", uuid: key }
            : { type: "mobile", qrcodeID: key }
      )
    );
    const body = asRecord(res.body);

    const code = readNumber(body.code);
    if (code === 200) {
      const cookieStr = readString(body.cookieStr) ?? "";
      const session = await this.resolveLoginSession(cookieStr, {});
      return {
        status: "authorized",
        message: "登录成功",
        session,
      };
    }
    if (code === 800) {
      return { status: "expired", message: "二维码已过期，请点击刷新" };
    }
    if (code === 802 || code === 67) {
      return { status: "scanned", message: "已扫码，等待确认" };
    }
    return { status: "waiting", message: readString(body.message) ?? "等待扫码" };
  }

  async getLoginStatus(
    rawCookie: MusicCookieInput,
    _platform?: "netease" | "qq",
    options: { forceRefresh?: boolean } = {}
  ): Promise<MusicLoginSession> {
    return this.resolveLoginSession(rawCookie, options);
  }

  private async resolveLoginSession(
    rawCookie: MusicCookieInput,
    options: { forceRefresh?: boolean }
  ): Promise<MusicLoginSession> {
    const extracted = extractQqCookie(rawCookie);
    let currentCookie = extracted ?? (typeof rawCookie === "string" ? rawCookie : "");
    const trimmed = currentCookie.trim();
    if (!trimmed) {
      throw new AppError("MUSIC_SESSION_INVALID", "QQ 音乐登录 Cookie 不能为空");
    }

    const cacheKey = `login-status:${trimmed}`;
    // 强制续期必须绕过缓存：缓存里是上一次校验结果，不会替我们换新 key。
    const reused = options.forceRefresh ? undefined : this.loginStatusCache.get(cacheKey);
    if (reused) {
      return { cookie: reused.cookie, account: { ...reused.account } };
    }

    let statusRes = await this.callUpstream(currentCookie, () =>
      qqmusic.login_status({ cookie: currentCookie })
    );
    // 状态接口本身也可能轮换 Cookie；有回写就先接住，避免继续拿旧 key 去续期。
    if (statusRes.body?.cookieStr?.trim()) currentCookie = statusRes.body.cookieStr;
    if (options.forceRefresh || !statusRes.body?.isLogin) {
      try {
        const refreshRes = await this.callUpstream(currentCookie, () =>
          qqmusic.login_refresh({ cookie: currentCookie })
        );
        if (refreshRes.body?.code === 200 && refreshRes.body.cookieStr) {
          currentCookie = refreshRes.body.cookieStr;
          statusRes = await this.callUpstream(currentCookie, () =>
            qqmusic.login_status({ cookie: currentCookie })
          );
          if (statusRes.body?.cookieStr?.trim()) currentCookie = statusRes.body.cookieStr;
        } else {
          this.options.logger?.warn?.("QQ 音乐凭证续期未取得新 key", {
            code: refreshRes.body?.code,
            message: refreshRes.body?.message,
          });
        }
      } catch (error) {
        this.options.logger?.warn?.("QQ 音乐凭证续期失败", describeError(error));
      }
    }

    if (!statusRes.body?.isLogin) {
      throw new AppError("MUSIC_SESSION_INVALID", "QQ 音乐登录状态已失效，请重新扫码登录");
    }

    const acc = statusRes.body?.account;
    const session: MusicLoginSession = {
      cookie: currentCookie,
      account: {
        platform: "qq",
        userId: acc?.userId || "",
        nickname: acc?.nickname || "QQ音乐用户",
        avatarUrl: acc?.avatarUrl,
        vipStatus: acc?.vipStatus || "unknown",
        vipTier: acc?.vipTier,
        vipLevel: acc?.vipLevel,
        vipYear: acc?.vipYear,
        vipExpireTime: acc?.vipExpireTime,
      },
    };

    this.loginStatusCache.set(cacheKey, session);
    if (currentCookie.trim() !== trimmed) {
      this.loginStatusCache.set(`login-status:${currentCookie.trim()}`, session);
    }

    // 对齐网易云：返回副本，调用方对返回值的改写不得污染复用缓存。
    return { cookie: session.cookie, account: { ...session.account } };
  }

  /**
   * 预热 QQ 音乐上游（契约对齐网易云 `warmUp`）：启动阶段用一次匿名探测垫付
   * DNS/TCP/TLS 建连与签名路径的冷启动成本，首位进房玩家不必替全进程垫付。
   * 失败只记告警、不阻断业务；探测失败也不会钉死后续重试，且不推进匿名熔断计数。
   */
  async warmUp(): Promise<void> {
    if (!this.warmupPromise) {
      this.warmupPromise = this.anonymousQueue
        .scheduleRequest(
          // 探测结果不写入检索缓存：固定关键词的结果对真实玩家没有价值，
          // 只为建连；失败在 catch 里消化，不会计入匿名熔断的失败 streak。
          () => qqmusic.search({ keywords: "周杰伦", limit: 1 })
        )
        .then(() => undefined)
        .catch((error: unknown) => {
          // 拒绝的 Promise 绝不能留在字段上：预热期的一次抖动会把后续预热永久钉死。
          this.warmupPromise = undefined;
          this.options.logger?.warn?.(
            "QQ音乐上游预热失败，将在首次请求时重试",
            describeError(error)
          );
        });
    }
    return this.warmupPromise;
  }
}
