import { AppError } from "../domain/Errors";
import { LRUCache } from "lru-cache";
import PQueue from "p-queue";
import { parseQrc as amllParseQrc, parseLrc as amllParseLrc } from "@applemusic-like-lyrics/lyric";
import qqmusic from "qqmusic-api-enhanced";
import { describeError, type EventLogger } from "./EventLogger";
import { parseSongUrn, buildSongUrn } from "./MusicUrn";
import { parseTTML, sanitizeLyrics } from "./NeteaseMusicProvider";
import type {
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

export const parseQrcLyrics = (raw: string): SongLyricLine[] => {
  if (!raw || !raw.trim()) return [];
  try {
    const amllLines = amllParseQrc(raw);
    return amllLines
      .map((line) => {
        const text =
          line.words && line.words.length > 0
            ? line.words.map((w) => w.word).join("").trim()
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
                  romanWord: hasTranslation ? undefined : (w.romanWord || undefined),
                }))
              : undefined,
          translatedLyric: line.translatedLyric || undefined,
          romanLyric: hasTranslation ? undefined : (line.romanLyric || undefined),
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
            ? line.words.map((w) => w.word).join("").trim()
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

export class QQMusicProvider implements MusicProvider {
  private readonly cache: LRUCache<string, any>;
  private readonly amllCache: LRUCache<string, any>;
  private readonly queue: PQueue;
  private readonly amllQueue: PQueue;
  private readonly options: QQMusicProviderOptions;

  constructor(options: QQMusicProviderOptions = {}) {
    this.options = options;
    this.cache = new LRUCache<string, any>({
      max: 1000,
      ttl: SONG_METADATA_CACHE_TTL_MS,
    });
    this.amllCache = new LRUCache<string, any>({
      max: 500,
      ttl: AMLL_LYRICS_CACHE_TTL_MS,
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
        throw new AppError("INVALID_PLATFORM", `QQMusicProvider 仅处理 qq 平台歌曲，收到: ${songId}`);
      }
      return parsed.rawId;
    }
    return trimmed;
  }

  async search(keyword: string, limit = 20, cookie?: string): Promise<SongSearchResult[]> {
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

      const body = res.body as any;
      const rawSongs = (body?.songs || body?.data?.body?.item_song?.items || []) as any[];
      return rawSongs.map((item): SongSearchResult => {
        const mid = String(item.mid || item.songmid || "").trim();
        const title = String(item.title || item.name || item.songname || "").trim();
        const artist = Array.isArray(item.singer)
          ? item.singer.map((s: any) => s.name || s.title).filter(Boolean).join(" / ")
          : typeof item.singer === "string"
            ? item.singer
            : "未知歌手";
        const albumName = item.album?.name || item.album?.title || item.albumname || undefined;
        const albumId = Number(item.album?.id || item.albumid);
        const pictureUrl = albumId
          ? `https://imgcache.qq.com/music/photo/album_500/${albumId % 100}/500_albumpic_${albumId}_0.jpg`
          : undefined;
        const durationMs = Number(item.interval || 0) * 1000;
        const requiresVip = Boolean(item.pay?.pay_play === 1 || item.pay?.pay_down === 1);

        return {
          id: buildSongUrn("qq", mid),
          title,
          artist: artist || "未知歌手",
          album: albumName,
          pictureUrl,
          durationMs: durationMs > 0 ? durationMs : undefined,
          requiresVip,
        };
      }).filter((s) => s.id && s.title);
    });

    const result = songs ?? [];
    this.cache.set(cacheKey, result, { ttl: SEARCH_CACHE_TTL_MS });
    return result;
  }

  async getSong(songId: string, cookie?: string): Promise<SongDetails> {
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

  async refreshSongAudio(songId: string, cookie?: string): Promise<string> {
    const mid = this.resolveMid(songId);
    const cacheKey = `audio:${cookie || ""}:${mid}`;
    this.cache.delete(cacheKey);
    return this.loadAudioUrl(mid, cookie);
  }

  async getSongMetadata(songId: string, cookie?: string): Promise<SongDetails> {
    const mid = this.resolveMid(songId);
    const cacheKey = `metadata:${mid}`;
    const cached = this.cache.get(cacheKey) as SongDetails | undefined;
    if (cached) return cached;

    const res = await this.queue.add(async () => {
      const detailRes = await qqmusic.song_detail({ id: mid, cookie });
      const rawTrack =
        detailRes.body?.data?.track_info ||
        detailRes.body?.data?.songinfo?.data?.track_info ||
        detailRes.body?.data ||
        {};

      const title = String(rawTrack.name || rawTrack.title || "").trim();
      if (!title) {
        throw new AppError("INVALID_SONG", `未找到 QQ 音乐歌曲信息: ${mid}`);
      }

      const artist = Array.isArray(rawTrack.singer)
        ? rawTrack.singer.map((s: any) => s.name || s.title).filter(Boolean).join(" / ")
        : "未知歌手";
      const albumName = rawTrack.album?.name || rawTrack.album?.title || undefined;
      const albumId = Number(rawTrack.album?.id);
      const pictureUrl = albumId
        ? `https://imgcache.qq.com/music/photo/album_500/${albumId % 100}/500_albumpic_${albumId}_0.jpg`
        : undefined;
      const durationMs = Number(rawTrack.interval || 0) * 1000;
      const requiresVip = Boolean(rawTrack.pay?.pay_play === 1 || rawTrack.pay?.pay_down === 1);
      const releaseYear = rawTrack.time_public
        ? Number(String(rawTrack.time_public).slice(0, 4))
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

  async getSongPopularity(songId: string, cookie?: string): Promise<number | undefined> {
    const mid = this.resolveMid(songId);
    const meta = await this.getSongMetadata(mid, cookie);
    return meta.popularity;
  }

  async getSongChorus(songId: string, cookie?: string): Promise<SongChorus | undefined> {
    const mid = this.resolveMid(songId);
    const meta = await this.getSongMetadata(mid, cookie);
    return meta.chorus;
  }

  private async loadAudioUrl(mid: string, cookie?: string): Promise<string> {
    const cacheKey = `audio:${cookie || ""}:${mid}`;
    const cached = this.cache.get(cacheKey) as string | undefined;
    if (cached) return cached;

    const audioUrl = await this.queue.add(async () => {
      // 1. 尝试常规音质播放直链 (320k 或 128k)
      const res = await qqmusic.song_url({
        id: mid,
        type: cookie ? "320" : "128",
        cookie,
      });

      let directUrl = res.body?.data?.[0]?.url || "";

      // 2. 若直链为空 (如无登录凭证的 VIP 歌曲)，尝试试听片段直链 (try)
      if (!directUrl) {
        const tryRes = await qqmusic.song_url({
          id: mid,
          type: "try",
          cookie,
        });
        directUrl = tryRes.body?.data?.[0]?.url || "";
      }

      if (!directUrl) {
        throw new AppError("SONG_UNAVAILABLE", `该歌曲暂无可用播放音频: ${mid}`);
      }

      return directUrl;
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
      this.options.logger?.warn?.("AMLL 歌曲名搜索匹配失败", { title: base.title, ...describeError(error) });
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
        const json = (await resp.json()) as any;
        const lyrics = json?.data?.lyrics || json?.lyrics;
        if (typeof lyrics === "string" && lyrics.trim()) {
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
      const fetcher = this.options.amllFetcher ?? fetch;
      const resp = await this.amllQueue.add(async () =>
        fetcher(`https://api.amll.dev/v1/lyrics/search?q=${encodeURIComponent(query)}&pageSize=5`, {
          signal: AbortSignal.timeout(this.options.amllRequestTimeoutMs ?? 4000),
        })
      );

      if (resp && resp.ok) {
        const json = (await resp.json()) as any;
        const items = json?.data || json?.items;
        if (Array.isArray(items) && items.length > 0) {
          const firstId = items[0].id;
          if (firstId) {
            const getResp = await fetcher(`https://api.amll.dev/v1/lyrics/get?id=${encodeURIComponent(String(firstId))}`);
            if (getResp.ok) {
              const getJson = (await getResp.json()) as any;
              const lyrics = getJson?.data?.lyrics || getJson?.lyrics;
              if (typeof lyrics === "string" && lyrics.trim()) {
                this.amllCache.set(cacheKey, lyrics);
                return lyrics;
              }
            }
          }
        }
      }
    } catch (error) {
      this.options.logger?.warn?.("AMLL 搜索失败", { query, ...describeError(error) });
    }

    this.amllCache.set(cacheKey, "");
    return undefined;
  }

  async getPlaylistSongs(
    playlistId: string,
    cookie?: string
  ): Promise<{ info: SongPlaylistInfo; songs: SongSearchResult[] }> {
    const trimmed = playlistId.trim();
    // 提取纯数字歌单 ID
    const match = trimmed.match(/\b(\d{7,12})\b/);
    const dissId = match ? match[1] : trimmed.replace(/\D/g, "");
    if (!dissId) {
      throw new AppError("INVALID_PLAYLIST", `无效的 QQ 音乐歌单 ID: ${playlistId}`);
    }

    const res = await this.queue.add(async () => {
      const detailRes = await qqmusic.playlist_detail({ id: dissId, cookie });
      const detailBody = detailRes.body as any;
      const dirinfo = detailBody?.dirinfo || detailBody?.data?.dirinfo || {};
      const dissName = String(dirinfo.title || dirinfo.dissname || "QQ音乐歌单");

      const trackRes = await qqmusic.playlist_track_all({ id: dissId, limit: 1000, cookie });
      const trackBody = trackRes.body as any;
      const rawSongs = (trackBody?.songs || detailBody?.songlist || []) as any[];

      const songs: SongSearchResult[] = rawSongs.map((item): SongSearchResult => {
        const mid = String(item.songmid || item.mid || "").trim();
        const title = String(item.songname || item.name || item.title || "").trim();
        const artist = Array.isArray(item.singer)
          ? item.singer.map((s: any) => s.name || s.title).filter(Boolean).join(" / ")
          : typeof item.singer === "string"
            ? item.singer
            : "未知歌手";
        const albumName = item.albumname || item.album?.name || undefined;
        const albumId = Number(item.albumid || item.album?.id);
        const pictureUrl = albumId
          ? `https://imgcache.qq.com/music/photo/album_500/${albumId % 100}/500_albumpic_${albumId}_0.jpg`
          : undefined;
        const durationMs = Number(item.interval || 0) * 1000;
        const requiresVip = Boolean(item.pay?.pay_play === 1 || item.pay?.pay_down === 1);

        return {
          id: buildSongUrn("qq", mid),
          title,
          artist: artist || "未知歌手",
          album: albumName,
          pictureUrl,
          durationMs: durationMs > 0 ? durationMs : undefined,
          requiresVip,
        };
      }).filter((s) => s.id && s.title);

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

  async searchArtists(keyword: string, limit = 20, cookie?: string): Promise<SongArtistSearchResult[]> {
    const normalized = keyword.trim();
    if (!normalized) return [];

    const res = await this.queue.add(async () => {
      const searchRes = await qqmusic.search({ keywords: normalized, type: 1, limit, cookie });
      const items = (searchRes.body?.data?.body?.singer?.items || []) as any[];

      return items.map((item): SongArtistSearchResult => {
        const singerMid = item.singerMID || item.mid || "";
        const singerId = Number(item.singerID || item.id);
        const avatarUrl = singerId
          ? `https://imgcache.qq.com/music/photo/singer_300/${singerId % 100}/300_singerpic_${singerId}_0.jpg`
          : undefined;

        return {
          id: buildSongUrn("qq", singerMid),
          name: item.singerName || item.name || "未知歌手",
          avatarUrl,
        };
      });
    });

    return res ?? [];
  }

  async getArtistSongs(artistId: string, cookie?: string): Promise<SongSearchResult[]> {
    const mid = this.resolveMid(artistId);
    const res = await this.queue.add(async () => {
      const songsRes = await qqmusic.artist_songs({ id: mid, limit: 100, cookie });
      const songsBody = songsRes.body as any;
      const rawSongs = (songsBody?.songs || songsBody?.data?.songList || []) as any[];

      return rawSongs.map((item): SongSearchResult => {
        const songMid = String(item.songInfo?.mid || item.mid || "").trim();
        const title = String(item.songInfo?.name || item.name || "").trim();
        const artist = Array.isArray(item.songInfo?.singer || item.singer)
          ? (item.songInfo?.singer || item.singer).map((s: any) => s.name).join(" / ")
          : "未知歌手";
        const albumName = item.songInfo?.album?.name || item.album?.name || undefined;
        const albumId = Number(item.songInfo?.album?.id || item.album?.id);
        const pictureUrl = albumId
          ? `https://imgcache.qq.com/music/photo/album_500/${albumId % 100}/500_albumpic_${albumId}_0.jpg`
          : undefined;
        const durationMs = Number(item.songInfo?.interval || item.interval || 0) * 1000;

        return {
          id: buildSongUrn("qq", songMid),
          title,
          artist,
          album: albumName,
          pictureUrl,
          durationMs: durationMs > 0 ? durationMs : undefined,
        };
      }).filter((s) => s.id && s.title);
    });

    return res ?? [];
  }

  async searchAlbums(keyword: string, limit = 10, cookie?: string): Promise<SongAlbumSearchResult[]> {
    const normalized = keyword.trim();
    if (!normalized) return [];

    const res = await this.queue.add(async () => {
      const searchRes = await qqmusic.search({ keywords: normalized, type: 2, limit, cookie });
      const items = (searchRes.body?.data?.body?.item_album?.items || []) as any[];

      return items.map((item): SongAlbumSearchResult => {
        const albumMid = item.albumMID || item.mid || "";
        const albumId = Number(item.albumID || item.id);
        const pictureUrl = albumId
          ? `https://imgcache.qq.com/music/photo/album_500/${albumId % 100}/500_albumpic_${albumId}_0.jpg`
          : undefined;

        return {
          id: buildSongUrn("qq", albumMid),
          name: item.albumName || item.name || "未知专辑",
          artist: Array.isArray(item.singer) ? item.singer.map((s: any) => s.name).join(" / ") : undefined,
          pictureUrl,
          songCount: item.song_count || item.total_song_num,
        };
      });
    });

    return res ?? [];
  }

  async getAlbumSongs(albumId: string, cookie?: string): Promise<SongSearchResult[]> {
    const mid = this.resolveMid(albumId);
    const searchRes = await this.search(mid, 50, cookie);
    return searchRes;
  }

  async createQrLogin(_platform?: "netease" | "qq", type: "qq" | "wx" | "mobile" = "qq"): Promise<MusicQrLogin> {
    const qrType = type || "qq";
    const res = await qqmusic.login_qr_create({ type: qrType });
    if (qrType === "qq") {
      const qrsig = res.body?.qrsig || "";
      const ptqrtoken = res.body?.ptqrtoken !== undefined ? String(res.body.ptqrtoken) : "";
      return {
        key: `${qrsig}:::${ptqrtoken}`,
        qrUrl: res.body?.url || "",
        qrImage: res.body?.qrimg || "",
      };
    }
    if (qrType === "wx") {
      const uuid = res.body?.uuid || "";
      const qrurl = res.body?.qrurl || `https://open.weixin.qq.com/connect/qrcode/${uuid}`;
      return {
        key: uuid,
        qrUrl: qrurl,
        qrImage: qrurl,
      };
    }
    // mobile
    const qrcodeID = res.body?.qrcodeID || "";
    return {
      key: qrcodeID,
      qrUrl: "https://y.qq.com",
      qrImage: res.body?.qrcode || "",
    };
  }

  async checkQrLogin(
    key: string,
    _platform?: "netease" | "qq",
    type: "qq" | "wx" | "mobile" = "qq"
  ): Promise<MusicQrLoginCheck> {
    const qrType = type || "qq";
    let res: any;
    if (qrType === "qq") {
      const [qrsig, ptqrtoken] = key.split(":::");
      res = await qqmusic.login_qr_check({
        type: "qq",
        qrsig,
        ptqrtoken: ptqrtoken || undefined,
      });
    } else if (qrType === "wx") {
      res = await qqmusic.login_qr_check({
        type: "wx",
        uuid: key,
      });
    } else {
      res = await qqmusic.login_qr_check({
        type: "mobile",
        qrcodeID: key,
      });
    }

    const code = res?.body?.code;
    if (code === 200) {
      const cookieStr = res.body?.cookieStr || "";
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
    return { status: "waiting", message: res?.body?.message || "等待扫码" };
  }

  async getLoginStatus(cookie: string): Promise<MusicLoginSession> {
    let uin = "";
    let nickname = "";
    let avatarUrl: string | undefined = undefined;

    try {
      const statusRes = await qqmusic.login_status({ cookie });
      const userData = statusRes.body?.data?.user || statusRes.body?.data || {};
      uin = String(userData.uin || userData.encryptUin || "").trim();
      nickname = userData.nick || userData.nickname || "";
      avatarUrl = userData.headurl || userData.avatar;
    } catch {}

    if (!uin) {
      const parsed = qqmusic.cookieToJson(cookie);
      uin = parsed.uin || parsed.qqmusic_uin || parsed.wxuin || "";
    }

    try {
      const detailRes = await qqmusic.user_detail({ uin, cookie });
      const header = detailRes.body?.data?.data || detailRes.body?.data || {};
      if (header.nick) nickname = header.nick;
      if (header.headurl) avatarUrl = header.headurl;
    } catch {}

    if (!nickname) {
      nickname = uin ? `QQ用户_${uin.slice(-4)}` : "QQ音乐用户";
    }

    let vipStatus: "vip" | "nonVip" | "unknown" = "nonVip";
    let vipTier: "svip" | "vip" | "musicPackage" | undefined = undefined;
    let vipLevel: number | undefined = undefined;
    let vipExpireTime: number | undefined = undefined;

    try {
      const vipRes = await qqmusic.user_vip_info({ cookie });
      const vipData = vipRes.body?.data || {};
      const identity = vipData.identity || {};
      const svip = Number(vipData.svip || 0);
      const isVip = Number(identity.HugeVip || identity.vip || 0);
      const isPackage = Number(identity.twelve || identity.eight || 0);
      const level = Number(identity.level || 0);

      if (svip > 0) {
        vipStatus = "vip";
        vipTier = "svip";
        vipLevel = level > 0 ? Math.min(Math.max(level, 1), 8) : 1;
      } else if (isVip > 0) {
        vipStatus = "vip";
        vipTier = "vip";
        vipLevel = level > 0 ? Math.min(Math.max(level, 1), 8) : 1;
      } else if (isPackage > 0) {
        vipStatus = "vip";
        vipTier = "musicPackage";
      }

      const expireTs = Number(vipData.userinfo?.expire || 0);
      if (expireTs > 0) {
        vipExpireTime = expireTs * 1000;
      } else if (identity.HugeVipEnd) {
        const parsed = Date.parse(identity.HugeVipEnd);
        if (!isNaN(parsed)) vipExpireTime = parsed;
      } else if (identity.twelveEnd) {
        const parsed = Date.parse(identity.twelveEnd);
        if (!isNaN(parsed)) vipExpireTime = parsed;
      }
    } catch {
      vipStatus = "unknown";
    }

    return {
      cookie,
      account: {
        platform: "qq",
        userId: uin,
        nickname,
        avatarUrl,
        vipStatus,
        vipTier,
        vipLevel,
        vipExpireTime,
      },
    };
  }
}
