import { AppError } from "../domain/Errors";
import { LRUCache } from "lru-cache";
import PQueue from "p-queue";
import { parseQrc as amllParseQrc, parseLrc as amllParseLrc } from "@applemusic-like-lyrics/lyric";
import qqmusic from "qqmusic-api-enhanced";
import { describeError, type EventLogger } from "./EventLogger";
import { parseSongUrn, buildSongUrn } from "./MusicUrn";
import { parseTTML, sanitizeLyrics } from "./LyricLines";
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
  maxConcurrentRequests?: number;
  amllMaxConcurrentRequests?: number;
  amllMaxQueuedRequests?: number;
  amllRequestTimeoutMs?: number;
  amllFetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  fetchAmllLyrics?: (id: string) => Promise<string | undefined>;
  fetchAmllSearchLyrics?: (songName: string, artistName?: string) => Promise<string | undefined>;
}

const SEARCH_CACHE_TTL_MS = 60 * 1000;
const SONG_METADATA_CACHE_TTL_MS = 10 * 60 * 1000;
const SONG_AUDIO_CACHE_TTL_MS = 5 * 60 * 1000;
const AMLL_LYRICS_CACHE_TTL_MS = 60 * 60 * 1000;
const LOGIN_STATUS_CACHE_TTL_MS = 2 * 60 * 1000;

export const stripHtmlTags = (val: unknown): string => {
  if (typeof val !== "string") return "";
  return val.replace(/<[^>]+>/g, "").trim();
};

// QQ 音乐上游返回的是未标注类型的 JSON，取值统一走下面这组窄化助手
// （与 NeteaseMusicProvider 同名助手同一套约定），不引入 any。
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

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

const readNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * 是否必须会员账号才能在线播放。
 *
 * `pay_down` 只约束下载；把它算进播放门槛会把 `pay_play=0` 的可播曲误标成会员专享。
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

/**
 * 从 XML 包裹的 QRC 中剥出 `LyricContent` 属性值；已是裸格式则原样返回。
 *
 * 属性值里的 `\n` 是字面量转义（XML 属性不能含真实换行），需还原成真实换行，
 * 否则所有行会被拼成一行。
 *
 * 注意用「提取属性值」而非「剔除标签」：剥离标签的正则会把开标签
 * `<Lyric_1 [0,500]…` 与结尾 `/>` 之间的整段歌词一并吃掉（实测结果为空）。
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

/** `cache` 按 key 前缀混存三种值：`search:` 存结果列表、`metadata:` 存详情、`audio:` 存直链。 */
type CacheValue = SongSearchResult[] | SongDetails | string;

export class QQMusicProvider implements MusicProvider {
  private readonly cache: LRUCache<string, CacheValue>;
  private readonly amllCache: LRUCache<string, string>;
  private readonly loginStatusCache: LRUCache<string, MusicLoginSession>;
  private readonly queue: PQueue;
  private readonly amllQueue: PQueue;
  private readonly options: QQMusicProviderOptions;

  constructor(options: QQMusicProviderOptions = {}) {
    this.options = options;
    this.cache = new LRUCache<string, CacheValue>({
      max: 1000,
      ttl: SONG_METADATA_CACHE_TTL_MS,
    });
    this.amllCache = new LRUCache<string, string>({
      max: 500,
      ttl: AMLL_LYRICS_CACHE_TTL_MS,
    });
    this.loginStatusCache = new LRUCache<string, MusicLoginSession>({
      max: 512,
      ttl: LOGIN_STATUS_CACHE_TTL_MS,
    });
    this.queue = new PQueue({ concurrency: Math.max(1, options.maxConcurrentRequests ?? 4) });
    this.amllQueue = new PQueue({
      concurrency: Math.max(1, options.amllMaxConcurrentRequests ?? 3),
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
    const cacheKey = `search:${cookie || ""}:${normalized.toLowerCase()}:${normalizedLimit}`;

    const cached = this.cache.get(cacheKey) as SongSearchResult[] | undefined;
    if (cached) return cached;

    const songs = await this.queue.add(async () => {
      const res = await qqmusic.search({
        keywords: normalized,
        limit: normalizedLimit,
        cookie,
      });

      const body = asRecord(res.body);
      const dataBody = firstRecord(asRecord(body.data).body, body.body, body.data, body);
      const rawSongs = readRecords(
        body.songs || dataBody.item_song || asRecord(dataBody.song).list
      );
      // 先剔除无 mid 的脏项再映射：`buildSongUrn` 对空 id 抛异常，若不预过滤，
      // 上游返回的任意一条缺 mid 记录都会让整次搜索失败（而非只丢那一条）。
      return rawSongs
        .filter((item) => readText(item.mid || item.songmid))
        .map((item): SongSearchResult => {
          const mid = readText(item.mid || item.songmid);
          const rawTitle = readText(item.title || item.name || item.songname);
          const title = stripHtmlTags(rawTitle);
          const artist = singerNames(item.singer).filter(Boolean).join(" / ");
          const album = asRecord(item.album);
          const rawAlbum = album.name || album.title || item.albumname || undefined;
          const albumName = rawAlbum ? stripHtmlTags(rawAlbum) || undefined : undefined;
          const albumId = Number(album.id || item.albumid);
          const pictureUrl = albumId
            ? `https://imgcache.qq.com/music/photo/album_500/${albumId % 100}/500_albumpic_${albumId}_0.jpg`
            : undefined;
          const durationMs = Number(item.interval || 0) * 1000;
          const pay = asRecord(item.pay);
          const requiresVip = requiresVipAccount(pay);

          return {
            id: buildSongUrn("qq", mid),
            title,
            artist: artist || "未知歌手",
            album: albumName,
            pictureUrl,
            durationMs: durationMs > 0 ? durationMs : undefined,
            requiresVip,
          };
        })
        .filter((s) => s.id && s.title);
    });

    const result = songs ?? [];
    this.cache.set(cacheKey, result, { ttl: SEARCH_CACHE_TTL_MS });
    return result;
  }

  async getSong(songId: string, rawCookie?: MusicCookieInput): Promise<SongDetails> {
    const cookie = extractQqCookie(rawCookie);
    const mid = this.resolveMid(songId);
    const meta = await this.getSongMetadata(mid, cookie);
    const audioUrl = await this.loadAudioUrl(mid, cookie);

    let lyrics = meta.lyrics;
    if (!lyrics || lyrics.length === 0) {
      lyrics = await this.loadLyrics(mid, meta, cookie);
    }

    return {
      ...meta,
      audioUrl,
      lyrics,
    };
  }

  async refreshSongAudio(songId: string, rawCookie?: MusicCookieInput): Promise<string> {
    const cookie = extractQqCookie(rawCookie);
    const mid = this.resolveMid(songId);
    const cacheKey = `audio:${cookie || ""}:${mid}`;
    this.cache.delete(cacheKey);
    return this.loadAudioUrl(mid, cookie);
  }

  async getSongMetadata(songId: string, rawCookie?: MusicCookieInput): Promise<SongDetails> {
    const cookie = extractQqCookie(rawCookie);
    const mid = this.resolveMid(songId);
    const cacheKey = `metadata:${mid}`;
    const cached = this.cache.get(cacheKey) as SongDetails | undefined;
    if (cached) return cached;

    const res = await this.queue.add(async () => {
      const detailRes = await qqmusic.song_detail({ id: mid, cookie });
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
      const albumId = Number(album.id);
      const pictureUrl = albumId
        ? `https://imgcache.qq.com/music/photo/album_500/${albumId % 100}/500_albumpic_${albumId}_0.jpg`
        : undefined;
      const durationMs = Number(rawTrack.interval || 0) * 1000;
      const pay = asRecord(rawTrack.pay);
      const requiresVip = requiresVipAccount(pay);
      const releaseYear = rawTrack.time_public
        ? Number(readText(rawTrack.time_public).slice(0, 4))
        : undefined;

      const baseDetails: SongDetails = {
        id: buildSongUrn("qq", mid),
        title,
        artist: artist || "未知歌手",
        album: albumName,
        pictureUrl,
        durationMs: durationMs > 0 ? durationMs : undefined,
        requiresVip,
        audioUrl: "",
        lyrics: [],
        releaseYear: Number.isFinite(releaseYear) ? releaseYear : undefined,
        encyclopedia: { tags: [] },
      };

      const lyrics = await this.loadLyrics(mid, baseDetails, cookie);
      baseDetails.lyrics = lyrics;

      return baseDetails;
    });

    if (!res) throw new AppError("INVALID_SONG", `未能加载歌曲元数据: ${mid}`);
    this.cache.set(cacheKey, res, { ttl: SONG_METADATA_CACHE_TTL_MS });
    return res;
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

  private async loadAudioUrl(mid: string, cookie?: string): Promise<string> {
    const cacheKey = `audio:${cookie || ""}:${mid}`;
    const cached = this.cache.get(cacheKey) as string | undefined;
    if (cached) return cached;

    const audioUrl = await this.queue.add(async () => {
      // 多级音质优雅降级链：有 Cookie 时优先尝试 320k，不可用或无 Cookie 时降级至标准 128k，再降级至 m4a (AAC)
      // 严禁采纳幽灵前缀 RS02（该前缀在 CDN 上恒为 404）
      const qualities = cookie ? ["320", "128", "m4a"] : ["128", "m4a"];

      for (const quality of qualities) {
        try {
          const res = await qqmusic.song_url({
            id: mid,
            type: quality,
            cookie,
          });

          const url = res.body?.data?.[0]?.url || "";
          if (url && !url.includes("RS02")) {
            return url;
          }
        } catch (error) {
          this.options.logger?.warn?.("QQ音乐获取音频直链单档位尝试失败", {
            mid,
            quality,
            ...describeError(error),
          });
        }
      }

      throw new AppError("SONG_UNAVAILABLE", `该歌曲暂无可用播放音频: ${mid}`);
    });

    if (!audioUrl) {
      throw new AppError("SONG_UNAVAILABLE", `无法获取音频直链: ${mid}`);
    }

    this.cache.set(cacheKey, audioUrl, { ttl: SONG_AUDIO_CACHE_TTL_MS });
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
      const ttmlById = await this.getAmllTtmlLyrics(mid);
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
      const ttmlBySearch = await this.searchAmllTtmlLyrics(base.title, base.artist);
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
      const lyricRes = await qqmusic.lyric({ id: mid, qrc: true, cookie });
      const rawQrc = lyricRes.body?.lyric;
      if (rawQrc && rawQrc.includes("<QrcInfos>")) {
        const parsed = parseQrcLyrics(rawQrc);
        if (parsed.length > 0) {
          return sanitizeLyrics(parsed, base);
        }
      }

      // 4. 普通 LRC 歌词降级
      const rawLrc = lyricRes.body?.lyric || lyricRes.body?.raw?.lyric;
      if (rawLrc && typeof rawLrc === "string") {
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
    const cacheKey = `amll:${mid}`;
    const cached = this.amllCache.get(cacheKey) as string | undefined;
    if (cached !== undefined) return cached;

    if (this.options.fetchAmllLyrics) {
      const res = await this.options.fetchAmllLyrics(mid);
      this.amllCache.set(cacheKey, res ?? "");
      return res;
    }

    try {
      const fetcher = this.options.amllFetcher ?? fetch;
      const resp = await this.amllQueue.add(async () =>
        fetcher(`https://api.amll.dev/v1/lyrics/get?qqMusicId=${encodeURIComponent(mid)}`, {
          signal: AbortSignal.timeout(this.options.amllRequestTimeoutMs ?? 4000),
        })
      );

      if (resp && resp.ok) {
        const json = asRecord(await resp.json());
        const lyrics = readString(asRecord(json.data).lyrics || json.lyrics);
        if (lyrics) {
          this.amllCache.set(cacheKey, lyrics);
          return lyrics;
        }
      }
    } catch (error) {
      this.options.logger?.warn?.("AMLL 请求失败", { mid, ...describeError(error) });
    }

    this.amllCache.set(cacheKey, "");
    return undefined;
  }

  async searchAmllTtmlLyrics(songName: string, artistName?: string): Promise<string | undefined> {
    const title = songName.trim();
    if (!title) return undefined;
    const query = artistName ? `${title} ${artistName}` : title;
    const cacheKey = `amll-search:${query}`;

    const cached = this.amllCache.get(cacheKey) as string | undefined;
    if (cached !== undefined) return cached;

    if (this.options.fetchAmllSearchLyrics) {
      const res = await this.options.fetchAmllSearchLyrics(title, artistName);
      this.amllCache.set(cacheKey, res ?? "");
      return res;
    }

    try {
      const lyrics = await this.fetchFirstMatchedAmllLyrics(query);
      if (lyrics) {
        this.amllCache.set(cacheKey, lyrics);
        return lyrics;
      }
    } catch (error) {
      this.options.logger?.warn?.("AMLL 搜索失败", { query, ...describeError(error) });
    }

    this.amllCache.set(cacheKey, "");
    return undefined;
  }

  /**
   * AMLL 检索接口只回候选列表，正文要按第一条的 id 再走一次 get。
   *
   * 只有检索请求进 `amllQueue`（受并发上限约束）；按 id 取正文沿用检索的同一
   * fetcher，不进队列，与改造前一致。
   */
  private async fetchFirstMatchedAmllLyrics(query: string): Promise<string | undefined> {
    const fetcher = this.options.amllFetcher ?? fetch;
    const resp = await this.amllQueue.add(async () =>
      fetcher(`https://api.amll.dev/v1/lyrics/search?q=${encodeURIComponent(query)}&pageSize=5`, {
        signal: AbortSignal.timeout(this.options.amllRequestTimeoutMs ?? 4000),
      })
    );

    if (!resp || !resp.ok) return undefined;
    const json = asRecord(await resp.json());
    const items = asArray(json.data || json.items);
    const firstId = items.length > 0 ? asRecord(items[0]).id : undefined;
    if (!firstId) return undefined;

    const getResp = await fetcher(
      `https://api.amll.dev/v1/lyrics/get?id=${encodeURIComponent(readText(firstId))}`
    );
    if (!getResp.ok) return undefined;
    const getJson = asRecord(await getResp.json());
    return readString(asRecord(getJson.data).lyrics || getJson.lyrics);
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

    const res = await this.queue.add(async () => {
      const detailRes = await qqmusic.playlist_detail({ id: dissId, cookie });
      const detailBody = asRecord(detailRes.body);
      const dirinfo = firstRecord(detailBody.dirinfo, asRecord(detailBody.data).dirinfo);
      const dissName = stripHtmlTags(dirinfo.title || dirinfo.dissname || "") || "QQ音乐歌单";

      const trackRes = await qqmusic.playlist_track_all({ id: dissId, limit: 1000, cookie });
      const trackBody = asRecord(trackRes.body);
      const rawSongs = readRecords(trackBody.songs || detailBody.songlist);

      const songs: SongSearchResult[] = rawSongs
        .filter((item) => readText(item.songmid || item.mid))
        .map((item): SongSearchResult => {
          const mid = readText(item.songmid || item.mid);
          const rawTitle = readText(item.songname || item.name || item.title);
          const title = stripHtmlTags(rawTitle);
          const artist = singerNames(item.singer).filter(Boolean).join(" / ");
          const album = asRecord(item.album);
          const rawAlbum = item.albumname || album.name || undefined;
          const albumName = rawAlbum ? stripHtmlTags(rawAlbum) || undefined : undefined;
          const albumId = Number(item.albumid || album.id);
          const pictureUrl = albumId
            ? `https://imgcache.qq.com/music/photo/album_500/${albumId % 100}/500_albumpic_${albumId}_0.jpg`
            : undefined;
          const durationMs = Number(item.interval || 0) * 1000;
          const pay = asRecord(item.pay);
          const requiresVip = requiresVipAccount(pay);

          return {
            id: buildSongUrn("qq", mid),
            title,
            artist: artist || "未知歌手",
            album: albumName,
            pictureUrl,
            durationMs: durationMs > 0 ? durationMs : undefined,
            requiresVip,
          };
        })
        .filter((s) => s.id && s.title);

      const info: SongPlaylistInfo = {
        id: buildSongUrn("qq", dissId),
        name: dissName,
        songCount: songs.length,
      };

      return { info, songs };
    });

    if (!res) throw new AppError("INVALID_PLAYLIST", `无法获取歌单歌曲: ${dissId}`);
    return res;
  }

  async searchArtists(
    keyword: string,
    limit = 20,
    rawCookie?: MusicCookieInput
  ): Promise<SongArtistSearchResult[]> {
    const cookie = extractQqCookie(rawCookie);
    const normalized = keyword.trim();
    if (!normalized) return [];

    const res = await this.queue.add(async () => {
      const searchRes = await qqmusic.search({ keywords: normalized, type: 1, limit, cookie });
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
    });

    return res ?? [];
  }

  async getArtistSongs(
    artistId: string,
    rawCookie?: MusicCookieInput
  ): Promise<SongSearchResult[]> {
    const cookie = extractQqCookie(rawCookie);
    const mid = this.resolveMid(artistId);
    const res = await this.queue.add(async () => {
      const songsRes = await qqmusic.artist_songs({ id: mid, limit: 100, cookie });
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
          const albumId = Number(songInfoAlbum.id || itemAlbum.id);
          const pictureUrl = albumId
            ? `https://imgcache.qq.com/music/photo/album_500/${albumId % 100}/500_albumpic_${albumId}_0.jpg`
            : undefined;
          const durationMs = Number(songInfo.interval || item.interval || 0) * 1000;

          return {
            id: buildSongUrn("qq", songMid),
            title,
            artist,
            album: albumName,
            pictureUrl,
            durationMs: durationMs > 0 ? durationMs : undefined,
          };
        })
        .filter((s) => s.id && s.title);
    });

    return res ?? [];
  }

  async searchAlbums(
    keyword: string,
    limit = 10,
    rawCookie?: MusicCookieInput
  ): Promise<SongAlbumSearchResult[]> {
    const cookie = extractQqCookie(rawCookie);
    const normalized = keyword.trim();
    if (!normalized) return [];

    const res = await this.queue.add(async () => {
      const searchRes = await qqmusic.search({ keywords: normalized, type: 2, limit, cookie });
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
          const pictureUrl = albumId
            ? `https://imgcache.qq.com/music/photo/album_500/${albumId % 100}/500_albumpic_${albumId}_0.jpg`
            : undefined;

          return {
            id: buildSongUrn("qq", albumMid),
            name: stripHtmlTags(item.albumName || item.name || "") || "未知专辑",
            artist: Array.isArray(item.singer) ? singerNames(item.singer).join(" / ") : undefined,
            pictureUrl,
            songCount: readNumber(item.song_count || item.total_song_num),
          };
        });
    });

    return res ?? [];
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
    const res = await qqmusic.login_qr_create({ type: qrType });
    const body = asRecord(res.body);
    if (qrType === "qq") {
      const qrsig = readText(body.qrsig);
      const ptqrtoken = readText(body.ptqrtoken);
      return {
        key: `${qrsig}:::${ptqrtoken}`,
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
    const qrcodeID = readText(body.qrcodeID);
    return {
      key: qrcodeID,
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
    const res = await qqmusic.login_qr_check(
      qrType === "qq"
        ? { type: "qq", qrsig, ptqrtoken: ptqrtoken || undefined }
        : qrType === "wx"
          ? { type: "wx", uuid: key }
          : { type: "mobile", qrcodeID: key }
    );
    const body = asRecord(res.body);

    const code = readNumber(body.code);
    if (code === 200) {
      const cookieStr = readString(body.cookieStr) ?? "";
      const session = await this.getLoginStatus(cookieStr);
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

  async getLoginStatus(rawCookie: MusicCookieInput): Promise<MusicLoginSession> {
    const extracted = extractQqCookie(rawCookie);
    let currentCookie = extracted ?? (typeof rawCookie === "string" ? rawCookie : "");
    const trimmed = currentCookie.trim();
    if (!trimmed) {
      throw new AppError("MUSIC_SESSION_INVALID", "QQ 音乐登录 Cookie 不能为空");
    }

    const cacheKey = `login-status:${trimmed}`;
    const reused = this.loginStatusCache.get(cacheKey);
    if (reused) {
      return { cookie: reused.cookie, account: { ...reused.account } };
    }

    let statusRes = await qqmusic.login_status({ cookie: trimmed });
    if (!statusRes.body?.isLogin) {
      try {
        const refreshRes = await qqmusic.login_refresh({ cookie: trimmed });
        if (refreshRes.body?.cookieStr) {
          currentCookie = refreshRes.body.cookieStr;
          statusRes = await qqmusic.login_status({ cookie: currentCookie });
        }
      } catch {
        // 刷新失败时沿用原状态结果
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

    return session;
  }
}
