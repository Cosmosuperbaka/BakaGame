import { AppError } from "../../../domain/Errors";
import { describeError, type EventLogger } from "../../EventLogger";
import { AmllLyricClient } from "../lyrics/AmllLyricClient";
import type {
  MusicCookieInput,
  MusicLoginSession,
  MusicProvider,
  MusicQrLogin,
  MusicQrLoginCheck,
} from "../MusicProvider";
import { readLyricSources } from "./NeteaseLyricParse";
import { isPlaylistTruncated, MusicCache, PLAYLIST_TRUNCATED_CACHE_TTL_MS } from "../MusicCache";
import {
  PLAYLIST_PAGE_SIZE,
  readRemainingPlaylistPages,
  warnIfPlaylistTruncated,
} from "../PlaylistPaging";
import { asArray, asRecord, readNumber, readString } from "../../JsonReaders";
import { NeteaseApiGateway, NON_RETRYABLE_API_ERROR_CODES } from "./NeteaseApiGateway";
import { NeteaseAudioUnblocker } from "./NeteaseAudioUnblock";
import { NeteaseLogin } from "./NeteaseLogin";
import { NeteaseLyricChain } from "./NeteaseLyricChain";
import {
  artistNames,
  normalizeAudioUrl,
  normalizeHttpsUrl,
  normalizeSong,
  readWiki,
  responseBody,
} from "./NeteaseResponse";
import type { NeteaseMusicProviderOptions } from "./NeteaseTypes";
import type {
  SongDetails,
  SongAlbumSearchResult,
  SongArtistSearchResult,
  SongLyricLine,
  SongSearchResult,
  SongChorus,
} from "../../../shared/Index";

const SEARCH_CACHE_TTL_MS = 6 * 60 * 60_000;
const SONG_METADATA_CACHE_TTL_MS = 24 * 60 * 60_000;
const SONG_LYRICS_CACHE_TTL_MS = 24 * 60 * 60_000;
const SONG_WIKI_CACHE_TTL_MS = 3 * 24 * 60 * 60_000;
const COLLECTION_CACHE_TTL_MS = 6 * 60 * 60_000;
const ARTIST_SONGS_CACHE_TTL_MS = 24 * 60 * 60_000;
const POPULARITY_CACHE_TTL_MS = 6 * 60 * 60_000;
const SONG_CHORUS_CACHE_TTL_MS = 3 * 24 * 60 * 60_000;
const AUDIO_URL_CACHE_TTL_MS = 10 * 60_000;
export class NeteaseMusicProvider implements MusicProvider {
  private readonly musicCache: MusicCache;
  private readonly amllClient: AmllLyricClient;
  private readonly gateway: NeteaseApiGateway;
  private readonly login: NeteaseLogin;
  private readonly unblocker: NeteaseAudioUnblocker;
  private readonly lyricChain: NeteaseLyricChain;

  readonly deviceName: string;
  private readonly logger?: EventLogger;
  private readonly now: () => number;
  private readonly random: { nextFloat?: () => number };

  constructor(private readonly options: NeteaseMusicProviderOptions = {}) {
    this.deviceName = options.deviceName?.trim() || "BakaGame";
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? { nextFloat: () => Math.random() };
    this.gateway = new NeteaseApiGateway(options, this.now, this.random);
    this.login = new NeteaseLogin({
      gateway: this.gateway,
      deviceName: this.deviceName,
      logger: this.logger,
      now: this.now,
    });
    this.unblocker = new NeteaseAudioUnblocker(this.gateway, options, this.now);
    this.musicCache = new MusicCache({
      maxEntries: options.cacheMaxEntries,
      maxBytes: options.cacheMaxBytes,
      now: this.now,
      isUpstreamBusy: () => this.gateway.isBusy(),
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
    this.lyricChain = new NeteaseLyricChain({
      logger: options.logger,
      getAmllTtmlLyrics: (id) => this.getAmllTtmlLyrics(id),
      searchAmllTtmlLyrics: (title, artist) => this.searchAmllTtmlLyrics(title, artist),
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
      this.gateway.cacheKey("search", cookie, normalized.toLocaleLowerCase(), normalizedLimit),
      SEARCH_CACHE_TTL_MS,
      async () => {
        const response = await this.gateway.call(
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
    const key = this.gateway.cacheKey("audio", cookie, id);
    this.musicCache.invalidate(key);
    return this.loadAudioUrl(id, cookie, true);
  }

  async getSongMetadata(songId: string, cookie?: MusicCookieInput): Promise<SongDetails> {
    const id = songId.trim();
    if (!id) throw new AppError("INVALID_SONG", "歌曲 ID 不能为空");
    let degraded = false;
    return this.musicCache.cached(
      this.gateway.cacheKey("metadata", undefined, id),
      SONG_METADATA_CACHE_TTL_MS,
      () => {
        degraded = false;
        return this.loadSong(id, false, cookie, () => {
          degraded = true;
        });
      },
      // 可选数据（百科、热度）因瞬态失败缺席时照常返回，但不入缓存，下次重新回源补全。
      { ttlForResult: () => (degraded ? 0 : SONG_METADATA_CACHE_TTL_MS) }
    );
  }

  async getSongPopularity(songId: string, cookie?: MusicCookieInput): Promise<number | undefined> {
    const id = songId.trim();
    if (!id) return undefined;
    return this.musicCache.cached(
      this.gateway.cacheKey("popularity", undefined, id),
      POPULARITY_CACHE_TTL_MS,
      async () => {
        const response = await this.gateway.callIfAvailable(["song_red_count"], { id }, cookie);
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
      this.gateway.cacheKey("song-chorus", undefined, id),
      SONG_CHORUS_CACHE_TTL_MS,
      async () => {
        const response = await this.gateway.callIfAvailable(["song_chorus"], { id }, cookie);
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
    // 补充请求（歌单详情、后续分页）因瞬态失败降级时，结果可能缺名称或被截断，只做短缓存。
    let degraded = false;
    const readOptional = async (names: string[], params: Record<string, unknown>) => {
      try {
        return await this.gateway.callIfAvailable(names, { ...params }, cookie);
      } catch (error) {
        if (error instanceof AppError && NON_RETRYABLE_API_ERROR_CODES.has(error.code)) throw error;
        degraded = true;
        this.logger?.warn("网易云可选接口调用降级", {
          endpoints: names,
          error: describeError(error),
        });
        return undefined;
      }
    };
    return this.musicCache.cached(
      this.gateway.cacheKey("playlist", cookie, id),
      COLLECTION_CACHE_TTL_MS,
      async () => {
        degraded = false;
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

        const firstResponse = await this.gateway.call(
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
          const detailResponse = await readOptional(["playlist_detail"], { id });
          if (detailResponse) {
            const detail = asRecord(responseBody(detailResponse).playlist);
            name = name ?? readString(detail.name);
            songCount = songCount ?? readNumber(detail.trackCount ?? detail.trackNumber);
          }
        }

        // `playlist_detail` 不支持 offset（每页都返回同一份 tracks），
        // 因此翻页用「本页是否带来新歌曲」兜底判定，避免重复整页；翻页失败不丢弃已取到的部分。
        await readRemainingPlaylistPages({
          firstAdded,
          declaredCount: songCount,
          collectedCount: () => songs.length,
          collect,
          fetchPage: async (page) => {
            const response = await readOptional(["playlist_track_all", "playlist_detail"], {
              id,
              limit: PLAYLIST_PAGE_SIZE,
              offset: page * PLAYLIST_PAGE_SIZE,
            });
            if (!response) return undefined;
            const body = responseBody(response);
            return asArray(
              body.songs ?? asRecord(body.playlist).tracks ?? asRecord(body.data).songs
            );
          },
        });

        warnIfPlaylistTruncated(
          this.logger,
          "网易云歌单读取不完整，题库被缩小",
          { playlistId: id },
          songCount,
          songs.length
        );
        return {
          info: { id, name: name ?? `歌单 ${id}`, songCount: songCount ?? songs.length },
          songs,
        };
      },
      {
        ttlForResult: (result) =>
          degraded || isPlaylistTruncated(result.info.songCount, result.songs.length)
            ? PLAYLIST_TRUNCATED_CACHE_TTL_MS
            : COLLECTION_CACHE_TTL_MS,
      }
    );
  }

  async searchArtists(keyword: string, limit = 20, cookie?: MusicCookieInput) {
    const normalized = keyword.trim();
    if (!normalized) return [];
    const normalizedLimit = Math.max(1, Math.min(limit, 50));
    return this.musicCache.cached(
      this.gateway.cacheKey("artist-search", undefined, normalized.toLocaleLowerCase(), normalizedLimit),
      SEARCH_CACHE_TTL_MS,
      async () => {
        const response = await this.gateway.call(
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
      this.gateway.cacheKey("artist-songs", undefined, id),
      ARTIST_SONGS_CACHE_TTL_MS,
      async () => {
        const response = await this.gateway.call(
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
      this.gateway.cacheKey("album-search", undefined, normalized.toLocaleLowerCase(), normalizedLimit),
      SEARCH_CACHE_TTL_MS,
      async () => {
        // cloudsearch 的 type 枚举：1 单曲 / 10 专辑 / 100 歌手 / 1000 歌单。
        const response = await this.gateway.call(
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
      this.gateway.cacheKey("album-songs", undefined, id),
      COLLECTION_CACHE_TTL_MS,
      async () => {
        const response = await this.gateway.call(["album"], { id }, cookie);
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

  async createQrLogin(): Promise<MusicQrLogin> {
    return this.login.createQrLogin();
  }

  async checkQrLogin(keyValue: string): Promise<MusicQrLoginCheck> {
    return this.login.checkQrLogin(keyValue);
  }

  async uploadDeviceInfo(
    cookieValue: string,
    deviceName = this.deviceName,
    loginScope?: string
  ): Promise<boolean> {
    return this.login.uploadDeviceInfo(cookieValue, deviceName, loginScope);
  }

  async getLoginStatus(cookieValue: string, loginScope?: string): Promise<MusicLoginSession> {
    return this.login.getLoginStatus(cookieValue, loginScope);
  }

  /** 预热上游：加载接口包并注册匿名令牌，细节见网关。 */
  async warmUp(): Promise<void> {
    return this.gateway.warmUp();
  }

  private async loadSong(
    songId: string,
    includeResources: boolean,
    cookie?: MusicCookieInput,
    onDegraded?: () => void
  ): Promise<SongDetails> {
    const id = songId.trim();
    if (!id) throw new AppError("INVALID_SONG", "歌曲 ID 不能为空");

    const detailResponse = await this.musicCache.cached(
      this.gateway.cacheKey("song-detail", undefined, id),
      SONG_METADATA_CACHE_TTL_MS,
      () => this.gateway.call(["song_detail"], { ids: id }, cookie)
    );
    const detailBody = responseBody(detailResponse);
    const rawSong = asArray(detailBody.songs)[0];
    const base = normalizeSong(rawSong);
    if (!base) throw new AppError("SONG_NOT_FOUND", "未找到歌曲信息");

    const wikiPromise = this.musicCache.cached(
      this.gateway.cacheKey("song-wiki", undefined, id),
      SONG_WIKI_CACHE_TTL_MS,
      () => this.gateway.callIfAvailable(["song_wiki_summary", "song_wiki_home"], { id }, cookie)
    );
    const lyricPromise = includeResources
      ? this.musicCache.cached(
          this.gateway.cacheKey("song-lyrics", undefined, id),
          SONG_LYRICS_CACHE_TTL_MS,
          () => this.gateway.call(["lyric_new", "lyric"], { id }, cookie)
        )
      : Promise.resolve(undefined);
    // 可选数据失败不拖垮出题，但要告诉调用方这份详情是降级的，别把它当完整结果缓存。
    const tolerate = <T>(promise: Promise<T>, rethrowLimits = false): Promise<T | undefined> =>
      promise.catch((error: unknown) => {
        // 百科沿用旧语义：限流与拥塞整次失败，让上层换路；热度与副歌一律降级。
        if (
          rethrowLimits &&
          error instanceof AppError &&
          NON_RETRYABLE_API_ERROR_CODES.has(error.code)
        ) {
          throw error;
        }
        this.logger?.warn("网易云可选接口调用降级", { songId: id, error: describeError(error) });
        onDegraded?.();
        return undefined;
      });
    const popularityPromise = tolerate(this.getSongPopularity(id, cookie));
    const chorusPromise = includeResources
      ? tolerate(this.getSongChorus(id, cookie))
      : Promise.resolve(undefined);
    const urlPromise = includeResources ? this.loadAudioUrl(id, cookie) : Promise.resolve("");

    const [wikiResponse, lyricResponse, urlResponse, popularity, chorus] = await Promise.all([
      tolerate(wikiPromise, true),
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
      lyrics = await this.lyricChain.resolveSongLyrics(
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

  private async loadAudioUrl(
    songId: string,
    cookie?: MusicCookieInput,
    force = false
  ): Promise<string> {
    const key = this.gateway.cacheKey("audio", cookie, songId);
    const value = await this.musicCache.cached(
      key,
      AUDIO_URL_CACHE_TTL_MS,
      async () => {
        const response = await this.gateway.call(
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

        if (isRestricted && this.unblocker.readGeneralUnblock()) {
          const unblockedUrl = await this.unblocker.unblockSongAudio(songId, cookie);
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

}
