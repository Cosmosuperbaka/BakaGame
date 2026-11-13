import { AppError } from "../../../domain/Errors";
import qqmusic from "qqmusic-api-enhanced";
import { describeError } from "../../EventLogger";
import { parseSongUrn, buildSongUrn } from "../MusicUrn";
import { asArray, asRecord, readNumber } from "../../JsonReaders";
import { isPlaylistTruncated, MusicCache, PLAYLIST_TRUNCATED_CACHE_TTL_MS } from "../MusicCache";
import {
  PLAYLIST_PAGE_SIZE,
  readRemainingPlaylistPages,
  warnIfPlaylistTruncated,
} from "../PlaylistPaging";
import { AmllLyricClient } from "../lyrics/AmllLyricClient";
import type { MusicCookieInput, MusicLoginSession, MusicProvider, MusicQrLogin, MusicQrLoginCheck } from "../MusicProvider";
import {
  NO_OP_SEARCH_NOTES,
  QQAnonymousCircuit,
  withAnonymousTimeout,
  type SearchSettlementNotes,
} from "./QQAnonymousCircuit";
import { audioCacheScope, extractQqCookie } from "./QQCookie";
import { QQLogin } from "./QQLogin";
import { QQLyricChain } from "./QQLyrics";
import {
  firstRecord,
  mapQqSong,
  normalizeArtistSong,
  normalizePlaylistSong,
  normalizeSearchSong,
  readRecords,
  readText,
  stripHtmlTags,
} from "./QQResponse";
import type { QQMusicProviderOptions } from "./QQTypes";
import { QQUpstream } from "./QQUpstream";
import type {
  SongArtistSearchResult,
  SongDetails,
  SongPlaylistInfo,
  SongSearchResult,
} from "../../../shared/SonGuessr";

const SEARCH_CACHE_TTL_MS = 60 * 1000;
const ANONYMOUS_SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const ANONYMOUS_SEARCH_TIMEOUT_MS = 4000;
const SONG_METADATA_CACHE_TTL_MS = 10 * 60 * 1000;
const PLAYLIST_CACHE_TTL_MS = 30 * 60 * 1000;
/** 歌手检索与歌手曲目是公开数据，与网易云同口径缓存；歌手曲目变化慢，缓存更久。 */
const ARTIST_SEARCH_CACHE_TTL_MS = 30 * 60 * 1000;
const ARTIST_SONGS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** 歌手检索条数上限：与网易云一致，调用方传多大都不放大上游一次的取量。 */
const ARTIST_SEARCH_MAX_LIMIT = 50;
const SONG_AUDIO_CACHE_TTL_MS = 5 * 60 * 1000;
const AMLL_LYRICS_CACHE_TTL_MS = 60 * 60 * 1000;
/** 公共缓存（检索 / 元数据）的条目数上限，与改造前 LRU 一致。 */
const CACHE_MAX_ENTRIES = 1000;
/** AMLL 歌词缓存的条目数上限，与改造前 LRU 一致。 */
const AMLL_CACHE_MAX_ENTRIES = 500;
// QQ 音乐上游返回的是未标注类型的 JSON：通用窄化助手取自 JsonReaders（与网易云
// 同一套约定）；`readString` 留在本地——它不 trim、不接受数字，与通用版语义不同，
// 音频直链与 Cookie 判定依赖这一差异。不引入 any。

export class QQMusicProvider implements MusicProvider {
  private readonly musicCache: MusicCache;
  private readonly amllClient: AmllLyricClient;
  private readonly upstream: QQUpstream;
  private readonly circuit: QQAnonymousCircuit;
  private readonly login: QQLogin;
  private readonly lyricChain: QQLyricChain;
  private readonly options: QQMusicProviderOptions;
  private readonly now: () => number;
  private warmupPromise?: Promise<void>;

  constructor(options: QQMusicProviderOptions = {}) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    const random = options.random ?? { nextFloat: () => Math.random() };
    this.upstream = new QQUpstream(options, this.now, random);
    this.circuit = new QQAnonymousCircuit(this.now, options);
    this.musicCache = new MusicCache({
      maxEntries: options.cacheMaxEntries ?? CACHE_MAX_ENTRIES,
      maxBytes: options.cacheMaxBytes,
      now: this.now,
      // 匿名熔断期内同样跳过主动刷新：熔断说明匿名上游正被限流，后台刷新只会火上浇油。
      isUpstreamBusy: () =>
        this.upstream.isCoolingDown() || this.upstream.hasQueued() || this.circuit.isOpen(),
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
        isUpstreamBusy: () => this.upstream.isCoolingDown() || this.circuit.isOpen(),
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
    const callUpstream = <T,>(cookie: string | undefined, task: () => Promise<T>) =>
      this.upstream.callUpstream(cookie, task);
    this.login = new QQLogin({ callUpstream, logger: options.logger });
    this.lyricChain = new QQLyricChain({
      amllClient: this.amllClient,
      callUpstream,
      logger: options.logger,
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

    if (!cookie && this.circuit.isOpen()) {
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
        if (consume()) this.circuit.noteResult(keyword, resultCount);
      },
      onFailure: () => {
        if (consume()) this.circuit.noteFailure(keyword);
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
    const res = await this.upstream.callUpstream(cookie, () =>
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
      lyrics = await this.lyricChain.loadLyrics(mid, meta, cookie);
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
    this.musicCache.invalidate(`audio:${audioCacheScope(cookie)}:${mid}`);
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
    const detailRes = await this.upstream.callUpstream(cookie, () =>
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

    const album = asRecord(rawTrack.album);
    const releaseYear = rawTrack.time_public
      ? Number(readText(rawTrack.time_public).slice(0, 4))
      : undefined;

    const baseDetails: SongDetails = {
      ...mapQqSong({
        mid,
        rawTitle: title,
        singer: rawTrack.singer,
        rawAlbum: album.name || album.title || undefined,
        albumId: Number(album.id),
        intervalSec: rawTrack.interval,
        pay: asRecord(rawTrack.pay),
      }),
      audioUrl: "",
      lyrics: [],
      releaseYear: Number.isFinite(releaseYear) ? releaseYear : undefined,
      encyclopedia: { tags: [] },
    };

    baseDetails.lyrics = await this.lyricChain.loadLyrics(mid, baseDetails, cookie);
    return baseDetails;
  }

  private async loadAudioUrl(mid: string, cookie?: string, force = false): Promise<string> {
    const cacheKey = `audio:${audioCacheScope(cookie)}:${mid}`;
    const audioUrl = await this.musicCache.cached(
      cacheKey,
      SONG_AUDIO_CACHE_TTL_MS,
      async () => {
        // 多级音质优雅降级链：有 Cookie 时优先尝试 320k，不可用或无 Cookie 时降级至标准 128k，再降级至 m4a (AAC)
        // 严禁采纳幽灵前缀 RS02（该前缀在 CDN 上恒为 404）
        const qualities = cookie ? ["320", "128", "m4a"] : ["128", "m4a"];

        for (const quality of qualities) {
          try {
            const res = await this.upstream.callUpstream(cookie, async () =>
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
    // 自动出题每一轮都要读题库：不缓存时 1500 首的歌单每轮要打三次上游，
    // 既拖慢开局又白白推高限流计数。按账号作用域缓存，私密歌单不会串号。
    return this.musicCache.cached(
      `playlist:${audioCacheScope(cookie)}:${dissId}`,
      PLAYLIST_CACHE_TTL_MS,
      () => this.fetchPlaylistSongs(dissId, cookie),
      {
        ttlForResult: (result) =>
          isPlaylistTruncated(result.info.songCount, result.songs.length)
            ? PLAYLIST_TRUNCATED_CACHE_TTL_MS
            : PLAYLIST_CACHE_TTL_MS,
      }
    );
  }

  private async fetchPlaylistSongs(
    dissId: string,
    cookie: string | undefined
  ): Promise<{ info: SongPlaylistInfo; songs: SongSearchResult[] }> {
    const detailRes = await this.upstream.callUpstream(cookie, async () =>
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
        const song = normalizePlaylistSong(item, mid);
        if (!song.title) continue;
        seenMids.add(mid);
        songs.push(song);
        added += 1;
      }
      return added;
    };

    // 单页装不下的歌单必须继续翻页（对齐网易云 getPlaylistSongs 的翻页口径）：
    // 按 `song_begin` 偏移逐页取，按 mid 去重；曲目总数优先读全量接口的 total。
    const fetchPage = (offset: number) =>
      this.upstream.callUpstream(cookie, async () =>
        qqmusic.playlist_track_all({ id: dissId, limit: PLAYLIST_PAGE_SIZE, offset, cookie })
      );

    const firstBody = asRecord((await fetchPage(0)).body);
    const firstRawSongs = readRecords(firstBody.songs);
    // 部分歌单的曲目只挂在 playlist_detail 的 songlist 上，保留改造前的兜底形状。
    const firstAdded = collect(
      firstRawSongs.length ? firstRawSongs : readRecords(detailBody.songlist)
    );
    const songCount = readNumber(firstBody.total);

    // 翻页失败只结束翻页、保留已取到的曲目；其余停止条件见 readRemainingPlaylistPages。
    await readRemainingPlaylistPages({
      firstAdded,
      declaredCount: songCount,
      collectedCount: () => songs.length,
      collect,
      fetchPage: async (page) => {
        try {
          const pageRes = await fetchPage(page * PLAYLIST_PAGE_SIZE);
          return readRecords(asRecord(pageRes.body).songs);
        } catch (error) {
          this.options.logger?.warn?.("QQ音乐歌单翻页失败，保留已取曲目", {
            dissId,
            page,
            ...describeError(error),
          });
          return undefined;
        }
      },
    });

    warnIfPlaylistTruncated(
      this.options.logger,
      "QQ音乐歌单读取不完整，题库被缩小",
      { dissId },
      songCount,
      songs.length
    );
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

    const normalizedLimit = Math.max(1, Math.min(limit, ARTIST_SEARCH_MAX_LIMIT));
    // 公开数据：缓存键不含凭据，所有玩家共享。
    return this.musicCache.cached(
      `artist-search:${normalized.toLowerCase()}:${normalizedLimit}`,
      ARTIST_SEARCH_CACHE_TTL_MS,
      async () => {
        const searchRes = await this.upstream.callUpstream(cookie, () =>
          qqmusic.search({ keywords: normalized, type: 1, limit: normalizedLimit, cookie })
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
    );
  }

  async getArtistSongs(
    artistId: string,
    rawCookie?: MusicCookieInput
  ): Promise<SongSearchResult[]> {
    const cookie = extractQqCookie(rawCookie);
    const mid = this.resolveMid(artistId);
    return this.musicCache.cached(`artist-songs:${mid}`, ARTIST_SONGS_CACHE_TTL_MS, async () => {
      const songsRes = await this.upstream.callUpstream(cookie, () =>
        qqmusic.artist_songs({ id: mid, limit: 100, cookie })
      );
      const songsBody = asRecord(songsRes.body);
      const rawSongs = readRecords(songsBody.songs || asRecord(songsBody.data).songList);

      return rawSongs
        .filter((item) => readText(asRecord(item.songInfo).mid || item.mid))
        .map(normalizeArtistSong)
        .filter((s) => s.id && s.title);
    });
  }

  async createQrLogin(
    platform?: "netease" | "qq",
    type: "qq" | "wx" | "mobile" = "qq"
  ): Promise<MusicQrLogin> {
    return this.login.createQrLogin(platform, type);
  }

  async checkQrLogin(
    key: string,
    platform?: "netease" | "qq",
    type: "qq" | "wx" | "mobile" = "qq"
  ): Promise<MusicQrLoginCheck> {
    return this.login.checkQrLogin(key, platform, type);
  }

  async getLoginStatus(
    rawCookie: MusicCookieInput,
    platform?: "netease" | "qq",
    options: { forceRefresh?: boolean } = {}
  ): Promise<MusicLoginSession> {
    return this.login.getLoginStatus(rawCookie, platform, options);
  }

  /**
   * 预热 QQ 音乐上游（契约对齐网易云 `warmUp`）：启动阶段用一次匿名探测垫付
   * DNS/TCP/TLS 建连与签名路径的冷启动成本，首位进房玩家不必替全进程垫付。
   * 失败只记告警、不阻断业务；探测失败也不会钉死后续重试，且不推进匿名熔断计数。
   */
  async warmUp(): Promise<void> {
    if (!this.warmupPromise) {
      this.warmupPromise = this.upstream
        .scheduleAnonymous(
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
