import { AppError } from "../domain/Errors";
import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";
import PQueue from "p-queue";
import type {
  SongDetails,
  SongArtistSearchResult,
  SongEncyclopedia,
  SonGuessrMusicAccount,
  SongLyricLine,
  SongPlaylistInfo,
  SongSearchResult,
} from "../shared/Index";

type ApiResponse = { body?: unknown } | unknown;
type ApiFunction = (params: Record<string, unknown>) => Promise<ApiResponse>;
type ApiModule = Record<string, unknown>;

export interface MusicProvider {
  search(keyword: string, limit?: number, cookie?: string): Promise<SongSearchResult[]>;
  getSong(songId: string, cookie?: string): Promise<SongDetails>;
  getSongMetadata(songId: string, cookie?: string): Promise<SongDetails>;
  getSongPopularity?(songId: string, cookie?: string): Promise<number | undefined>;
  createQrLogin?(): Promise<MusicQrLogin>;
  checkQrLogin?(key: string): Promise<MusicQrLoginCheck>;
  getLoginStatus?(cookie: string): Promise<MusicLoginSession>;
  getPlaylistSongs?(playlistId: string, cookie?: string): Promise<{ info: SongPlaylistInfo; songs: SongSearchResult[] }>;
  searchArtists?(keyword: string, limit?: number, cookie?: string): Promise<SongArtistSearchResult[]>;
  getArtistSongs?(artistId: string, cookie?: string): Promise<SongSearchResult[]>;
}

export interface NeteaseMusicProviderOptions {
  loadApi?: () => Promise<ApiModule>;
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

const readString = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
};

const readNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const randomChineseIp = () => [
  116,
  25 + Math.floor(Math.random() * 70),
  Math.floor(Math.random() * 256),
  Math.floor(Math.random() * 256),
].join(".");

const SEARCH_CACHE_TTL_MS = 2 * 60_000;
const SONG_METADATA_CACHE_TTL_MS = 10 * 60_000;
const SONG_LYRICS_CACHE_TTL_MS = 10 * 60_000;
const SONG_WIKI_CACHE_TTL_MS = 30 * 60_000;
const COLLECTION_CACHE_TTL_MS = 5 * 60_000;
const ARTIST_SONGS_CACHE_TTL_MS = 10 * 60_000;
const POPULARITY_CACHE_TTL_MS = 30 * 60_000;
const DEFAULT_CACHE_MAX_ENTRIES = 512;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 3;
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 100;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 5_000;
const DEFAULT_MAX_RATE_LIMIT_COOLDOWN_MS = 60_000;
const DEFAULT_MAX_QUEUED_REQUESTS = 64;
const DEFAULT_QUEUE_TIMEOUT_MS = 8_000;

const cloneCacheValue = <T>(value: T): T => structuredClone(value);

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
    risk
      ? "网易云已拦截当前网络环境的登录请求，请稍后重试"
      : responseMessage(body, fallback),
    { upstreamCode: code },
  );
};

const readLoginAccount = (body: Record<string, unknown>): SonGuessrMusicAccount => {
  const data = asRecord(dataRecord(body));
  const profile = asRecord(body.profile ?? data.profile);
  const account = asRecord(body.account ?? data.account);
  const nickname = readString(profile.nickname ?? account.userName ?? account.nickname) ?? "网易云用户";
  return {
    userId: readString(profile.userId ?? profile.id ?? account.id ?? account.userId),
    nickname,
    avatarUrl: normalizeHttpsUrl(profile.avatarUrl ?? profile.avatar),
  };
};

const dataRecord = (body: Record<string, unknown>) => asRecord(body.data);

const readVipAccount = (
  raw: unknown,
  account: SonGuessrMusicAccount,
): SonGuessrMusicAccount => {
  const body = asRecord(raw);
  const data = asRecord(body.data ?? raw);
  const now = Date.now();
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
    .map((membership) => readNumber(membership.expireTime ?? membership.expire ?? membership.endTime))
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => right - left)[0];
  return {
    ...account,
    vipStatus: active.length > 0 ? "vip" : "nonVip",
    vipType,
    vipExpireTime,
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
  return {
    id,
    title,
    artist: artistNames(song),
    album: readString(album.name),
    pictureUrl: normalizeHttpsUrl(album.picUrl ?? album.pic),
    durationMs: readNumber(song.dt ?? song.duration),
    requiresVip: fee === 1,
  };
};

const normalizeComparableText = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\-_—–/:：·.'"“”‘’()（）\[\]【】]/g, "");

const CREDIT_LINE_PATTERN = /^(?:作词(?:人)?|填词|词曲|词|作曲(?:人)?|谱曲|曲|编曲(?:人|师)?|制作人|制作|监制|混音(?:师)?|母带(?:工程师)?|录音(?:师)?|和声|吉他|贝斯|鼓|弦乐(?:编写)?|统筹|发行|出品|演唱|主唱|歌手|op|sp|publisher|lyric(?:s|ist)?|composer|arranger|producer|vocal(?:s|ist)?|lyrics?\s+by|music\s+by|written\s+by|produced\s+by|production\s+coordination|keyboards?(?:\s*&\s*programming)?|programming|drums?|bass|guitars?|percussion|strings?\s+arranged(?:\s*&\s*conducted)?\s+by|vocals?\s+recorded\s+at|recorded\s+at|engineered\s+by|mixed\s+by|mastered\s+by)\s*(?::|：|-|—|\/|\s)/i;

/** 过滤会直接暴露创作人员的 LRC 署名行。 */
export const isCreditLyricLine = (text: string) => CREDIT_LINE_PATTERN.test(text.trim());

const INSTRUMENTAL_MARKERS = new Set([
  "music",
  "instrumental",
  "interlude",
  "intro",
  "outro",
  "inst",
  "伴奏",
  "间奏",
  "前奏",
  "尾奏",
  "纯音乐",
  "器乐",
]);

/** 过滤 LRC 中表示间奏/纯音乐的占位行，避免把无歌词段落当作可猜片段。 */
export const isInstrumentalLyricLine = (text: string) => {
  const normalized = normalizeComparableText(text);
  if (INSTRUMENTAL_MARKERS.has(normalized)) return true;
  // 网易云会把间奏写成 Music1、[Music] 或 Music - Instrumental 等占位文本。
  return /^(?:music|instrumental|interlude|intro|outro|inst)(?:\d+)?$/.test(normalized) ||
    /^(?:music|instrumental|interlude|intro|outro|inst)(?:music|instrumental|interlude|intro|outro|inst)$/.test(normalized);
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

/**
 * 去掉作词、作曲、编曲等署名，以及会直接暴露答案的歌名行。
 * 过滤后重新计算每句结束时间，避免被删除的元数据行造成音频切片错位。
 */
export const sanitizeLyrics = (
  lyrics: SongLyricLine[],
  song: Pick<SongSearchResult, "title" | "artist" | "album">,
): SongLyricLine[] => {
  const title = normalizeComparableText(song.title);
  const album = song.album ? normalizeComparableText(song.album) : "";
  const artistTokens = song.artist
    .split(/[\/,、&与和]/)
    .map(normalizeComparableText)
    .filter((token) => token.length >= 2);
  const wholeArtist = normalizeComparableText(song.artist);

  const forbidden = new Set([
    title,
    wholeArtist,
    ...artistTokens,
    album,
    `${title}${wholeArtist}`,
    `${wholeArtist}${title}`,
  ].filter(Boolean));

  const filtered = lyrics.filter((line) => {
    if (isCreditLyricLine(line.text)) return false;
    if (isInstrumentalLyricLine(line.text)) return false;
    const normalizedLine = normalizeComparableText(line.text);
    if (forbidden.has(normalizedLine)) return false;
    if (title.length >= 2 && normalizedLine.includes(title)) return false;
    for (const token of artistTokens) {
      if (normalizedLine.includes(token)) return false;
    }
    if (album.length >= 2 && normalizedLine.includes(album)) return false;
    return true;
  });

  return filtered.map((line, index) => ({
    ...line,
    endTime: filtered[index + 1]?.time ?? Math.max(line.endTime, line.time + 5_000),
  }));
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
        content.split(/[、,，/]/).map((item) => item.trim()).filter(Boolean).forEach((item) => aliases.add(item));
      } else if (
        title.includes("曲风") ||
        title.includes("流派") ||
        title.includes("标签") ||
        title.includes("genre") ||
        title.includes("tag")
      ) {
        content.split(/[、,，/]/).map((item) => item.trim()).filter(Boolean).forEach((item) => tags.add(item));
      } else if (!summary && (title.includes("简介") || title.includes("介绍") || title.includes("summary"))) {
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
  private readonly cache: LRUCache<string, unknown>;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly ipByScope = new Map<string, string>();
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

  constructor(private readonly options: NeteaseMusicProviderOptions = {}) {
    this.randomCNIP = options.randomCNIP ?? true;
    this.cache = new LRUCache<string, unknown>({
      max: Math.max(1, options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES),
    });
    this.maxConcurrentRequests = Math.max(
      1,
      options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS,
    );
    this.minRequestIntervalMs = Math.max(
      0,
      options.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS,
    );
    this.rateLimitCooldownMs = Math.max(
      0,
      options.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS,
    );
    this.maxRateLimitCooldownMs = Math.max(
      this.rateLimitCooldownMs,
      options.maxRateLimitCooldownMs ?? DEFAULT_MAX_RATE_LIMIT_COOLDOWN_MS,
    );
    this.maxQueuedRequests = Math.max(
      1,
      options.maxQueuedRequests ?? DEFAULT_MAX_QUEUED_REQUESTS,
    );
    this.queueTimeoutMs = Math.max(1, options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS);
    this.queue = new PQueue({
      concurrency: this.maxConcurrentRequests,
      ...(this.minRequestIntervalMs > 0
        ? { interval: this.minRequestIntervalMs, intervalCap: 1 }
        : {}),
    });
  }

  async search(keyword: string, limit = 20, cookie?: string): Promise<SongSearchResult[]> {
    const normalized = keyword.trim();
    if (!normalized) return [];
    const normalizedLimit = Math.max(1, Math.min(limit, 50));
    return this.cached(
      this.cacheKey("search", cookie, normalized.toLocaleLowerCase(), normalizedLimit),
      SEARCH_CACHE_TTL_MS,
      async () => {
        const response = await this.call(["cloudsearch", "search"], {
          keywords: normalized,
          limit: normalizedLimit,
          type: 1,
        }, cookie);
        const body = responseBody(response);
        const result = asRecord(body.result);
        return asArray(result.songs)
          .map(normalizeSong)
          .filter((song): song is SongSearchResult => Boolean(song));
      },
    );
  }

  async getSong(songId: string, cookie?: string): Promise<SongDetails> {
    const id = songId.trim();
    if (!id) throw new AppError("INVALID_SONG", "歌曲 ID 不能为空");
    return this.cached(
      this.cacheKey("song", cookie, id),
      0,
      () => this.loadSong(id, true, cookie),
    );
  }

  async getSongMetadata(songId: string, cookie?: string): Promise<SongDetails> {
    const id = songId.trim();
    if (!id) throw new AppError("INVALID_SONG", "歌曲 ID 不能为空");
    return this.cached(
      this.cacheKey("metadata", undefined, id),
      SONG_METADATA_CACHE_TTL_MS,
      () => this.loadSong(id, false, cookie),
    );
  }

  async getSongPopularity(songId: string, cookie?: string): Promise<number | undefined> {
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
      },
    );
  }

  async getPlaylistSongs(playlistId: string, cookie?: string) {
    const id = playlistId.trim();
    if (!/^\d+$/.test(id)) throw new AppError("INVALID_PLAYLIST", "歌单 ID 无效");
    return this.cached(
      this.cacheKey("playlist", cookie, id),
      COLLECTION_CACHE_TTL_MS,
      async () => {
        const response = await this.call(["playlist_track_all", "playlist_detail"], {
          id,
          limit: 1000,
          offset: 0,
        }, cookie);
        const body = responseBody(response);
        let playlist = asRecord(body.playlist ?? asRecord(body.data).playlist);
        if (!readString(playlist.name)) {
          const detailResponse = await this.callOptional(["playlist_detail"], { id }, cookie);
          if (detailResponse) playlist = asRecord(responseBody(detailResponse).playlist);
        }
        const rawSongs = asArray(body.songs ?? playlist.tracks ?? asRecord(body.data).songs);
        const songs = rawSongs
          .map(normalizeSong)
          .filter((song): song is SongSearchResult => Boolean(song));
        const name = readString(playlist.name) ?? `歌单 ${id}`;
        const songCount = readNumber(
          playlist.trackCount ?? playlist.trackNumber ?? songs.length,
        ) ?? songs.length;
        return { info: { id, name, songCount }, songs };
      },
    );
  }

  async searchArtists(keyword: string, limit = 20, cookie?: string) {
    const normalized = keyword.trim();
    if (!normalized) return [];
    const normalizedLimit = Math.max(1, Math.min(limit, 50));
    return this.cached(
      this.cacheKey("artist-search", undefined, normalized.toLocaleLowerCase(), normalizedLimit),
      SEARCH_CACHE_TTL_MS,
      async () => {
        const response = await this.call(["cloudsearch", "search"], {
          keywords: normalized,
          limit: normalizedLimit,
          type: 100,
        }, cookie);
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
      },
    );
  }

  async getArtistSongs(artistId: string, cookie?: string) {
    const id = artistId.trim();
    if (!/^\d+$/.test(id)) throw new AppError("INVALID_ARTIST", "歌手 ID 无效");
    return this.cached(
      this.cacheKey("artist-songs", undefined, id),
      ARTIST_SONGS_CACHE_TTL_MS,
      async () => {
        const response = await this.call(["artist_songs", "artist_top_song"], {
          id,
          limit: 1000,
          offset: 0,
          order: "hot",
        }, cookie);
        const body = responseBody(response);
        return asArray(body.songs ?? asRecord(body.data).songs ?? body.hotSongs)
          .map(normalizeSong)
          .filter((song): song is SongSearchResult => Boolean(song));
      },
    );
  }

  async createQrLogin(): Promise<MusicQrLogin> {
    const keyResponse = await this.call(["login_qr_key"], {}, undefined, this.randomCNIP, true, false);
    const keyBody = responseBody(keyResponse);
    if (responseCode(keyBody) !== 200) throw musicLoginError(keyBody, "无法创建登录二维码");
    const key = readString(asRecord(keyBody.data).unikey ?? keyBody.unikey);
    if (!key) throw new AppError("MUSIC_LOGIN_FAILED", "无法创建登录二维码");

    const qrResponse = await this.call(
      ["login_qr_create"],
      { key, qrimg: true },
      undefined,
      this.randomCNIP,
      true,
      false,
    );
    const qrBody = responseBody(qrResponse);
    if (responseCode(qrBody) !== 200) throw musicLoginError(qrBody, "无法生成登录二维码");
    const qrData = asRecord(qrBody.data);
    const qrUrl = readString(qrData.qrurl);
    const qrImage = readString(qrData.qrimg);
    if (!qrUrl || !qrImage) throw new AppError("MUSIC_LOGIN_FAILED", "无法生成登录二维码");
    return { key, qrUrl, qrImage };
  }

  async checkQrLogin(keyValue: string): Promise<MusicQrLoginCheck> {
    const key = keyValue.trim();
    if (!key) throw new AppError("INVALID_LOGIN", "二维码登录密钥不能为空");
    const response = await this.call(
      ["login_qr_check"],
      { key },
      undefined,
      this.randomCNIP,
      true,
      false,
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
    const session = await this.getLoginStatus(cookie);
    return { status: "authorized", message, session };
  }

  async getLoginStatus(cookieValue: string): Promise<MusicLoginSession> {
    const cookie = cookieValue.trim();
    if (!cookie) throw new AppError("MUSIC_SESSION_INVALID", "登录 Cookie 不能为空");
    const response = await this.call(["login_status"], {}, cookie, false, true, false);
    const body = responseBody(response);
    const data = asRecord(body.data);
    const profile = asRecord(body.profile ?? data.profile);
    const account = asRecord(body.account ?? data.account);
    const nestedCode = readNumber(data.code);
    const userId = readString(profile.userId ?? profile.id ?? account.id ?? account.userId);
    if (
      responseCode(body) !== 200 ||
      (nestedCode !== undefined && nestedCode !== 200) ||
      !userId
    ) {
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
    cookie?: string,
  ): Promise<SongDetails> {
    const id = songId.trim();
    if (!id) throw new AppError("INVALID_SONG", "歌曲 ID 不能为空");

    const detailResponse = await this.cached(
      this.cacheKey("song-detail", undefined, id),
      SONG_METADATA_CACHE_TTL_MS,
      () => this.call(["song_detail"], { ids: id }, cookie),
    );
    const detailBody = responseBody(detailResponse);
    const rawSong = asArray(detailBody.songs)[0];
    const base = normalizeSong(rawSong);
    if (!base) throw new AppError("SONG_NOT_FOUND", "未找到歌曲信息");

    const wikiPromise = this.cached(
      this.cacheKey("song-wiki", undefined, id),
      SONG_WIKI_CACHE_TTL_MS,
      () => this.callOptional(["song_wiki_summary", "song_wiki_home"], { id }, cookie),
    );
    const lyricPromise = includeResources
      ? this.cached(
          this.cacheKey("song-lyrics", undefined, id),
          SONG_LYRICS_CACHE_TTL_MS,
          () => this.call(["lyric_new", "lyric"], { id }, cookie),
        )
      : Promise.resolve(undefined);
    const popularityPromise = this.getSongPopularity(id, cookie).catch(() => undefined);
    const urlPromise = includeResources
      // song_url_v1 在当前 API Enhanced 版本中可能因缺少 xeapi 公钥直接抛错；
      // 优先使用稳定的 song_url，并保留 v1 作为后备。
      ? this.call(["song_url", "song_url_v1"], { id, level: "standard", br: 320000 }, cookie)
      : Promise.resolve(undefined);

    const [wikiResponse, lyricResponse, urlResponse, popularity] = await Promise.all([
      wikiPromise,
      lyricPromise,
      urlPromise,
      popularityPromise,
    ]);

    const songRecord = asRecord(rawSong);
    const album = asRecord(songRecord.al ?? songRecord.album);
    const publishTime = readNumber(songRecord.publishTime ?? album.publishTime);
    const wiki = readWiki(wikiResponse ? responseBody(wikiResponse) : undefined);

    let audioUrl = "";
    let lyrics: SongLyricLine[] = [];
    if (includeResources) {
      const urlBody = responseBody(urlResponse);
      audioUrl = normalizeAudioUrl(asRecord(asArray(urlBody.data)[0]).url) ?? "";
      const lyricBody = responseBody(lyricResponse);
      const lrc = asRecord(lyricBody.lrc ?? lyricBody.yrc);
      lyrics = sanitizeLyrics(parseLrc(readString(lrc.lyric) ?? ""), base);

      if (!audioUrl) throw new AppError("SONG_UNAVAILABLE", "该歌曲暂时没有可用播放地址");
    }

    return {
      ...base,
      audioUrl,
      lyrics,
      releaseYear: publishTime ? new Date(publishTime).getUTCFullYear() : undefined,
      popularity: popularity ?? base.popularity ?? readNumber(songRecord.pop ?? songRecord.popularity),
      language: wiki.language,
      encyclopedia: {
        summary: wiki.summary,
        aliases: wiki.aliases,
        tags: wiki.tags,
      },
    };
  }

  private async loadApi(): Promise<ApiModule> {
    if (!this.apiPromise) {
      this.apiPromise = (async () => {
        const api = this.options.loadApi
          ? await this.options.loadApi()
          : await import("@neteasecloudmusicapienhanced/api") as ApiModule;
        await this.prepareAnonymousSession(api);
        return api;
      })();
    }
    return this.apiPromise;
  }

  private async prepareAnonymousSession(api: ApiModule) {
    if (this.anonymousCookie || typeof api.register_anonimous !== "function") return;
    try {
      const response = await this.scheduleRequest(() =>
        (api.register_anonimous as ApiFunction)({
          crypto: "weapi",
          cookie: {},
          randomCNIP: this.randomCNIP,
          ...(this.randomCNIP ? { realIP: this.ipForCookie() } : {}),
        }));
      this.anonymousCookie = responseCookie(response);
    } catch {
      // 匿名令牌不是登录的硬前置条件；上游不可用时继续使用无 Cookie 请求。
    }
  }

  private async call(
    names: string[],
    params: Record<string, unknown>,
    cookie?: string,
    randomCNIP = this.randomCNIP,
    preserveErrorResponse = false,
    includeAnonymousCookie = true,
  ): Promise<ApiResponse> {
    const api = await this.loadApi();
    let hasEndpoint = false;
    let lastErrorResponse: ApiResponse | undefined;
    let lastError: unknown;
    for (const name of names) {
      const fn = api[name];
      if (typeof fn === "function") {
        hasEndpoint = true;
        try {
          const response = await this.scheduleRequest(() =>
            (fn as ApiFunction)(
              this.withCookie(params, cookie, randomCNIP, includeAnonymousCookie),
            ),
          );
          // Enhanced API 的不同端点可能选择 reject，也可能正常 resolve 一个 405 body。
          // 两种形态都必须进入同一冷却逻辑，否则 resolve 形态会被误当成空搜索结果。
          if (this.isRateLimitError(response)) {
            this.enterRateLimitCooldown(response);
            throw this.upstreamError(response);
          }
          return response;
        } catch (error) {
          lastError = error;
          if (error instanceof AppError && error.code === "MUSIC_API_RATE_LIMITED") {
            throw error;
          }
          if ("body" in asRecord(error)) lastErrorResponse = error as ApiResponse;
          if (this.isRateLimitError(error)) {
            this.enterRateLimitCooldown(error);
            throw this.upstreamError(error);
          }
          // 同一能力可能有多个兼容端点；当前端点运行失败时继续尝试后备实现。
        }
      }
    }
    if (!hasEndpoint) {
      throw new AppError("MUSIC_API_UNAVAILABLE", `音乐 API 缺少接口：${names.join(" / ")}`);
    }
    if (preserveErrorResponse && lastErrorResponse) return lastErrorResponse;
    throw this.upstreamError(lastErrorResponse ?? lastError);
  }

  private async callOptional(
    names: string[],
    params: Record<string, unknown>,
    cookie?: string,
  ): Promise<ApiResponse | undefined> {
    try {
      return await this.call(names, params, cookie);
    } catch (error) {
      if (error instanceof AppError && error.code === "MUSIC_API_UNAVAILABLE") return undefined;
      if (error instanceof AppError && error.code === "MUSIC_API_RATE_LIMITED") throw error;
      return undefined;
    }
  }

  private async enrichVipAccount(
    cookie: string,
    account: SonGuessrMusicAccount,
  ): Promise<SonGuessrMusicAccount> {
    const response = await this.callOptional(
      ["vip_info_v2", "vip_info"],
      account.userId ? { uid: account.userId } : {},
      cookie,
    );
    if (!response) return { ...account, vipStatus: "unknown" };
    const body = responseBody(response);
    if (responseCode(body) !== 200) return { ...account, vipStatus: "unknown" };
    return readVipAccount(body, account);
  }

  private cacheKey(namespace: string, cookie: string | undefined, ...parts: unknown[]) {
    const scope = cookie?.trim()
      ? createHash("sha256").update(cookie.trim()).digest("hex").slice(0, 16)
      : "anonymous";
    return [namespace, scope, ...parts].map(String).join(":");
  }

  private async cached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    if (ttlMs > 0) {
      const cached = this.cache.get(key) as T | undefined;
      if (cached !== undefined) return cloneCacheValue(cached);
    }
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) return cloneCacheValue(await existing);

    const request = loader().then((value) => {
      if (value !== undefined && ttlMs > 0) {
        this.cache.set(key, value, { ttl: ttlMs });
      }
      return value;
    }).finally(() => {
      if (this.inFlight.get(key) === request) this.inFlight.delete(key);
    });
    this.inFlight.set(key, request);
    return cloneCacheValue(await request);
  }

  private scheduleRequest<T>(task: () => Promise<T>): Promise<T> {
    if (Date.now() < this.cooldownUntil) {
      return Promise.reject(this.busyError());
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

      if (Date.now() < this.cooldownUntil) {
        throw this.busyError();
      }
      try {
        const result = await task();
        if (this.isRateLimitError(result)) {
          this.enterRateLimitCooldown(result);
        }
        return result;
      } catch (error) {
        if (this.isRateLimitError(error)) {
          this.enterRateLimitCooldown(error);
        }
        throw error;
      }
    }) as Promise<T>;

    return Promise.race([executionPromise, timeoutPromise]);
  }

  private enterRateLimitCooldown(error: unknown) {
    const body = responseBody(error);
    this.lastRateLimitMessage = responseMessage(body, this.lastRateLimitMessage);
    const now = Date.now();
    if (now - this.lastRateLimitAt > this.maxRateLimitCooldownMs) {
      this.rateLimitStrikes = 0;
    }
    this.rateLimitStrikes = Math.min(this.rateLimitStrikes + 1, 8);
    this.lastRateLimitAt = now;
    const baseDuration = Math.min(
      this.maxRateLimitCooldownMs,
      this.rateLimitCooldownMs * 2 ** (this.rateLimitStrikes - 1),
    );
    // 注入微量随机 Jitter 抖动，防止限流恢复瞬间突发惊群重连
    const jitter = Math.floor(Math.random() * (baseDuration * 0.05));
    const duration = Math.min(this.maxRateLimitCooldownMs, baseDuration + jitter);
    this.cooldownUntil = Math.max(this.cooldownUntil, now + duration);

    this.queue.clear();
    const rejections = Array.from(this.pendingRejections.values());
    this.pendingRejections.clear();
    const busy = this.busyError(this.lastRateLimitMessage);
    for (const reject of rejections) {
      reject(busy);
    }
  }

  private busyError(message = this.lastRateLimitMessage) {
    return new AppError("MUSIC_API_RATE_LIMITED", message, {
      upstreamCode: 405,
      retryAfterMs: Math.max(0, this.cooldownUntil - Date.now()),
    });
  }

  private upstreamError(error: unknown) {
    if (error instanceof AppError) return error;
    const body = responseBody(error);
    const code = responseCode(body) ?? readNumber(asRecord(error).status);
    const message = responseMessage(
      body,
      error instanceof Error && error.message
        ? error.message
        : "网易云音乐接口请求失败，请稍后重试",
    );
    return new AppError(
      code === 405 ? "MUSIC_API_RATE_LIMITED" : "MUSIC_API_FAILED",
      message,
      { upstreamCode: code },
    );
  }

  private isRateLimitError(error: unknown) {
    const body = responseBody(error);
    return responseCode(body) === 405 || readNumber(asRecord(error).status) === 405;
  }

  private ipForCookie(cookie?: string) {
    const scope = cookie?.trim()
      ? createHash("sha256").update(cookie.trim()).digest("hex").slice(0, 16)
      : "anonymous";
    const existing = this.ipByScope.get(scope);
    if (existing) return existing;
    const ip = randomChineseIp();
    this.ipByScope.set(scope, ip);
    if (this.ipByScope.size > 128) {
      const oldest = this.ipByScope.keys().next().value;
      if (oldest !== undefined) this.ipByScope.delete(oldest);
    }
    return ip;
  }

  private withCookie(
    params: Record<string, unknown>,
    cookie?: string,
    randomCNIP = this.randomCNIP,
    includeAnonymousCookie = true,
  ): Record<string, unknown> {
    const requestCookie = cookie ?? (includeAnonymousCookie ? this.anonymousCookie : undefined);
    return {
      ...params,
      // 始终显式传入 cookie，阻止 Enhanced API 从进程环境变量 NETEASE_COOKIE 偷读旧凭据。
      cookie: requestCookie ?? {},
      // 同一登录态使用稳定伪装 IP，减少单一出口的限流聚集，也避免请求间频繁漂移触发风控。
      ...(randomCNIP ? { realIP: this.ipForCookie(cookie) } : {}),
      randomCNIP,
    };
  }
}
