import { AppError } from "../../domain/Errors";
import { describeError, type EventLogger } from "../EventLogger";
import { parseSongUrn, buildSongUrn } from "./MusicUrn";
import { resolvePlatformCookie } from "./MusicCookieResolver";
import { raceWithTimeout } from "./RaceTimeout";
import {
  aggregateAndDeduplicateSongs,
  markSongPlayability,
  normalizeComparableText,
  mergeSearchLists,
  type SongPlayabilityContext,
} from "./MusicDeduplicator";
import type { MusicCookieInput, MusicLoginSession, MusicPlatform, MusicProvider, MusicQrLogin, MusicQrLoginCheck, MusicSearchOptions, SongFailoverHint } from "./MusicProvider";
import type {
  SongAlbumSearchResult,
  SongArtistSearchResult,
  SongChorus,
  SongDetails,
  SongPlaylistInfo,
  SongSearchResult,
} from "../../shared/SonGuessr";

export interface AggregatedMusicProviderOptions {
  neteaseProvider: MusicProvider;
  qqProvider: MusicProvider;
  logger?: EventLogger;
  /**
   * 无 QQ 账号时是否允许匿名检索 QQ。匿名只能播免费曲（`pay_play=0`），
   * 且上游会对连续检索限流，因此这里默认开启但由运行期旋钮随时可关。
   * 传函数是为了让 T3 设置改动在下一个请求就生效。
   */
  allowAnonymousQqSearch?: boolean | (() => boolean);
  /** 单源搜索等待上限：慢的一侧超时后按单音源降级，不拖住另一侧结果。 */
  searchTimeoutMs?: { netease?: number; qq?: number };
}

const DEFAULT_SEARCH_TIMEOUT_MS = { netease: 8000, qq: 6000 };

const resolveSwitch = (value: boolean | (() => boolean) | undefined, fallback: boolean): boolean =>
  typeof value === "function" ? value() : (value ?? fallback);

/** 给单源搜索加等待上限：慢的一侧超时后按单音源降级，不拖住另一侧结果。 */
const withSearchTimeout = <T>(task: Promise<T>, timeoutMs: number, source: string): Promise<T> =>
  raceWithTimeout(task, timeoutMs, () => {
    throw new AppError("MUSIC_API_TIMEOUT", `${source}搜索超时`);
  });

export class AggregatedMusicProvider implements MusicProvider {
  private readonly neteaseProvider: MusicProvider;
  private readonly qqProvider: MusicProvider;
  private readonly logger?: EventLogger;
  private readonly allowAnonymousQqSearch?: boolean | (() => boolean);
  private readonly searchTimeoutMs: { netease: number; qq: number };

  constructor(options: AggregatedMusicProviderOptions) {
    this.neteaseProvider = options.neteaseProvider;
    this.qqProvider = options.qqProvider;
    this.logger = options.logger;
    this.allowAnonymousQqSearch = options.allowAnonymousQqSearch;
    this.searchTimeoutMs = {
      netease: options.searchTimeoutMs?.netease ?? DEFAULT_SEARCH_TIMEOUT_MS.netease,
      qq: options.searchTimeoutMs?.qq ?? DEFAULT_SEARCH_TIMEOUT_MS.qq,
    };
  }

  private anonymousQqAllowed(): boolean {
    return resolveSwitch(this.allowAnonymousQqSearch, true);
  }

  async search(
    keyword: string,
    limit = 20,
    cookie?: MusicCookieInput,
    options: MusicSearchOptions = {}
  ): Promise<SongSearchResult[]> {
    const normalized = keyword.trim();
    if (!normalized) return [];

    const neteaseCookie = resolvePlatformCookie(cookie, "netease");
    const qqCookie = resolvePlatformCookie(cookie, "qq");

    // 网易云检索不需要登录态（匿名即可），结果还能走解灰兜底播放，所以恒发。
    // QQ 也接受匿名检索：免费曲（pay_play=0）能拿到 128k/m4a 直链，会员曲才需要
    // 池里有会员账号。匿名通道会被上游限流，因此由运行期旋钮控制，并只作为补充源。
    const qqAuthenticated = qqCookie !== undefined;
    const anonymousQqAllowed = this.anonymousQqAllowed();
    const qqAvailable = qqAuthenticated || anonymousQqAllowed;
    if (!qqAvailable) {
      this.logger?.info?.("QQ 音乐匿名补充已关闭且账号池为空，本轮跳过 QQ 音源", {
        keyword: normalized,
      });
    } else if (!qqAuthenticated) {
      this.logger?.debug?.("QQ 音乐账号池为空，本轮以匿名音源补充检索", {
        keyword: normalized,
      });
    }
    // 匿名 QQ 只代表「免费曲可播」；会员曲仍由 vipPlatforms 决定（池里有没有会员号）。
    const playability: SongPlayabilityContext = {
      availablePlatforms: qqAvailable ? ["netease", "qq"] : ["netease"],
      vipPlatforms: options.vipPlatforms,
    };

    // 双端并行检索并做单边熔断与容错保护；单源超时按该源降级。
    const [neteaseSettled, qqSettled] = await Promise.allSettled([
      withSearchTimeout(
        this.neteaseProvider.search(normalized, limit, neteaseCookie),
        this.searchTimeoutMs.netease,
        "网易云"
      ),
      qqAvailable
        ? withSearchTimeout(
            this.qqProvider.search(normalized, limit, qqCookie),
            this.searchTimeoutMs.qq,
            "QQ 音乐"
          )
        : Promise.resolve([] as SongSearchResult[]),
    ]);

    const neteaseSongs: (SongSearchResult & { upstreamRank?: number })[] =
      neteaseSettled.status === "fulfilled"
        ? neteaseSettled.value.map((s, index) => ({
            ...markSongPlayability(s, playability),
            id: s.id.startsWith("netease:") ? s.id : buildSongUrn("netease", s.id),
            upstreamRank: index,
          }))
        : [];

    if (neteaseSettled.status === "rejected") {
      this.logger?.warn?.("网易云搜索失败，降级为单音源", {
        keyword: normalized,
        ...describeError(neteaseSettled.reason),
      });
    }

    const qqSongs: (SongSearchResult & { upstreamRank?: number })[] =
      qqSettled.status === "fulfilled"
        ? qqSettled.value.map((s, index) => ({
            ...markSongPlayability(s, playability),
            id: s.id.startsWith("qq:") ? s.id : buildSongUrn("qq", s.id),
            upstreamRank: index,
          }))
        : [];

    if (qqSettled.status === "rejected") {
      this.logger?.warn?.("QQ音乐搜索失败，降级为单音源", {
        keyword: normalized,
        ...describeError(qqSettled.reason),
      });
    }

    const allCandidates = [...neteaseSongs, ...qqSongs];
    if (allCandidates.length === 0) return [];

    // 执行三级指纹去重、实体合流与多维度综合打分排序
    return aggregateAndDeduplicateSongs(
      allCandidates,
      normalized,
      limit,
      playability,
      options.platformPreference
    );
  }

  async getSong(
    songId: string,
    cookie?: MusicCookieInput,
    options: { allowFailover?: boolean; hint?: SongFailoverHint } = {}
  ): Promise<SongDetails> {
    const { platform, rawId } = parseSongUrn(songId);
    const platformCookie = resolvePlatformCookie(cookie, platform);

    if (platform === "netease") {
      try {
        const details = await this.neteaseProvider.getSong(rawId, platformCookie);
        return {
          ...details,
          id: buildSongUrn("netease", rawId),
        };
      } catch (error) {
        if (options.allowFailover === false) throw error;
        this.logger?.warn?.("网易云歌曲加载失败，尝试触发音源 Failover", {
          songId,
          ...describeError(error),
        });
        // 尝试按歌名+歌手在 QQ 音乐中兜底检索并播放
        const qqCookie = resolvePlatformCookie(cookie, "qq");
        const neteaseCookie = resolvePlatformCookie(cookie, "netease");
        const fallback = await this.tryFailover(
          songId,
          this.qqProvider,
          "qq",
          neteaseCookie,
          qqCookie,
          options.hint
        );
        if (fallback) return fallback;
        throw error;
      }
    }

    if (platform === "qq") {
      try {
        const details = await this.qqProvider.getSong(rawId, platformCookie);
        return {
          ...details,
          id: buildSongUrn("qq", rawId),
        };
      } catch (error) {
        if (options.allowFailover === false) throw error;
        this.logger?.warn?.("QQ音乐歌曲加载失败，尝试触发音源 Failover", {
          songId,
          ...describeError(error),
        });
        const neteaseCookie = resolvePlatformCookie(cookie, "netease");
        const qqCookie = resolvePlatformCookie(cookie, "qq");
        const fallback = await this.tryFailover(
          songId,
          this.neteaseProvider,
          "netease",
          qqCookie,
          neteaseCookie,
          options.hint
        );
        if (fallback) return fallback;
        throw error;
      }
    }

    throw new AppError("INVALID_PLATFORM", `未知音源平台: ${platform}`);
  }

  private async tryFailover(
    originalSongId: string,
    targetProvider: MusicProvider,
    targetPlatform: MusicPlatform,
    originCookie?: string,
    targetCookie?: string,
    hint?: SongFailoverHint
  ): Promise<SongDetails | null> {
    // 匿名 QQ 只是检索补充源；开关关闭时不再用它做隐式 failover。
    if (targetPlatform === "qq" && !targetCookie && !this.anonymousQqAllowed()) return null;
    try {
      // 1. 优先用调用方给的曲目信息；没有才回源读原歌曲元数据
      const originMeta =
        hint?.title && hint.artist
          ? hint
          : await this.getSongMetadata(originalSongId, originCookie);
      if (!originMeta.title) return null;

      // 2. 在备选平台检索
      const candidates = await targetProvider.search(
        `${originMeta.title} ${originMeta.artist}`,
        5,
        targetCookie
      );
      if (!candidates || candidates.length === 0) return null;

      // 3. 寻找时长匹配的候选曲
      const matched = candidates.find((c) => {
        if (typeof originMeta.durationMs === "number" && typeof c.durationMs === "number") {
          return Math.abs(originMeta.durationMs - c.durationMs) <= 3000;
        }
        return true;
      });

      const bestCandidate = matched || candidates[0];
      // 目标平台自己的 provider 检索返回裸标识（网易云）或带前缀的标识（QQ）：
      // 两种都要接受，返回给调用方的 id 一律补成统一 URN，否则后续刷新播放地址会解析失败。
      const rawId = bestCandidate.id.includes(":")
        ? parseSongUrn(bestCandidate.id).rawId
        : bestCandidate.id;
      const details = await targetProvider.getSong(rawId, targetCookie);
      return { ...details, id: buildSongUrn(targetPlatform, rawId) };
    } catch {
      return null;
    }
  }

  async refreshSongAudio(songId: string, cookie?: MusicCookieInput): Promise<string> {
    const { platform, rawId } = parseSongUrn(songId);
    const platformCookie = resolvePlatformCookie(cookie, platform);
    if (platform === "netease") {
      return (
        this.neteaseProvider.refreshSongAudio?.(rawId, platformCookie) ??
        (await this.neteaseProvider.getSong(rawId, platformCookie)).audioUrl
      );
    }
    return (
      this.qqProvider.refreshSongAudio?.(rawId, platformCookie) ??
      (await this.qqProvider.getSong(rawId, platformCookie)).audioUrl
    );
  }

  async getSongMetadata(songId: string, cookie?: MusicCookieInput): Promise<SongDetails> {
    const { platform, rawId } = parseSongUrn(songId);
    const platformCookie = resolvePlatformCookie(cookie, platform);
    if (platform === "netease") {
      const res = await this.neteaseProvider.getSongMetadata(rawId, platformCookie);
      return {
        ...res,
        id: buildSongUrn("netease", rawId),
      };
    }
    const res = await this.qqProvider.getSongMetadata(rawId, platformCookie);
    return {
      ...res,
      id: buildSongUrn("qq", rawId),
    };
  }

  async getSongPopularity(songId: string, cookie?: MusicCookieInput): Promise<number | undefined> {
    const { platform, rawId } = parseSongUrn(songId);
    const platformCookie = resolvePlatformCookie(cookie, platform);
    if (platform === "netease") {
      return this.neteaseProvider.getSongPopularity?.(rawId, platformCookie);
    }
    return this.qqProvider.getSongPopularity?.(rawId, platformCookie);
  }

  async getSongChorus(songId: string, cookie?: MusicCookieInput): Promise<SongChorus | undefined> {
    const { platform, rawId } = parseSongUrn(songId);
    const platformCookie = resolvePlatformCookie(cookie, platform);
    if (platform === "netease") {
      return this.neteaseProvider.getSongChorus?.(rawId, platformCookie);
    }
    return this.qqProvider.getSongChorus?.(rawId, platformCookie);
  }

  async getAmllTtmlLyrics(songId: string): Promise<string | undefined> {
    const { platform, rawId } = parseSongUrn(songId);
    if (platform === "netease") {
      return this.neteaseProvider.getAmllTtmlLyrics?.(rawId);
    }
    return this.qqProvider.getAmllTtmlLyrics?.(rawId);
  }

  async searchAmllTtmlLyrics(songName: string, artistName?: string): Promise<string | undefined> {
    return (
      (await this.neteaseProvider.searchAmllTtmlLyrics?.(songName, artistName)) ||
      (await this.qqProvider.searchAmllTtmlLyrics?.(songName, artistName))
    );
  }

  async getPlaylistSongs(
    playlistId: string,
    cookie?: MusicCookieInput
  ): Promise<{ info: SongPlaylistInfo; songs: SongSearchResult[] }> {
    const trimmed = playlistId.trim();
    if (trimmed.startsWith("qq:") || /y\.qq\.com/i.test(trimmed)) {
      const rawId = trimmed.startsWith("qq:") ? trimmed.slice(3) : trimmed;
      const qqCookie = resolvePlatformCookie(cookie, "qq");
      if (!qqCookie && !this.anonymousQqAllowed()) {
        throw new AppError(
          "MUSIC_LOGIN_REQUIRED",
          "QQ 音乐匿名音源已关闭，请登录 QQ 音乐后读取歌单"
        );
      }
      const res = await this.qqProvider.getPlaylistSongs!(rawId, qqCookie);
      return {
        info: {
          ...res.info,
          id: res.info.id.startsWith("qq:") ? res.info.id : buildSongUrn("qq", res.info.id),
        },
        songs: res.songs.map((s) => ({
          ...s,
          id: s.id.startsWith("qq:") ? s.id : buildSongUrn("qq", s.id),
        })),
      };
    }
    const rawId = trimmed.startsWith("netease:") ? trimmed.slice(8) : trimmed;
    const neteaseCookie = resolvePlatformCookie(cookie, "netease");
    const res = await this.neteaseProvider.getPlaylistSongs!(rawId, neteaseCookie);
    return {
      info: {
        ...res.info,
        id: res.info.id.startsWith("netease:") ? res.info.id : buildSongUrn("netease", res.info.id),
      },
      songs: res.songs.map((s) => ({
        ...s,
        id: s.id.startsWith("netease:") ? s.id : buildSongUrn("netease", s.id),
      })),
    };
  }

  async searchArtists(
    keyword: string,
    limit = 20,
    cookie?: MusicCookieInput,
    options: MusicSearchOptions = {}
  ): Promise<SongArtistSearchResult[]> {
    const neteaseCookie = resolvePlatformCookie(cookie, "netease");
    const qqCookie = resolvePlatformCookie(cookie, "qq");
    const qqSearch =
      qqCookie || this.anonymousQqAllowed()
        ? this.qqProvider.searchArtists?.(keyword, limit, qqCookie)
        : Promise.resolve([] as SongArtistSearchResult[]);
    const [netease, qq] = await Promise.allSettled([
      this.neteaseProvider.searchArtists?.(keyword, limit, neteaseCookie),
      qqSearch,
    ]);
    const list1 = (netease.status === "fulfilled" ? netease.value || [] : []).map((a) => ({
      ...a,
      id: a.id.startsWith("netease:") ? a.id : buildSongUrn("netease", a.id),
    }));
    const list2 = (qq.status === "fulfilled" ? qq.value || [] : []).map((a) => ({
      ...a,
      id: a.id.startsWith("qq:") ? a.id : buildSongUrn("qq", a.id),
    }));
    return mergeSearchLists(
      list1,
      list2,
      (artist) => normalizeComparableText(artist.name) || artist.id,
      options.platformPreference,
      limit
    );
  }

  async getArtistSongs(artistId: string, cookie?: MusicCookieInput): Promise<SongSearchResult[]> {
    const { platform, rawId } = parseSongUrn(artistId);
    const platformCookie = resolvePlatformCookie(cookie, platform);
    if (platform === "netease") {
      const songs = await this.neteaseProvider.getArtistSongs!(rawId, platformCookie);
      return songs.map((s) => ({
        ...s,
        id: s.id.startsWith("netease:") ? s.id : buildSongUrn("netease", s.id),
      }));
    }
    const songs = await this.qqProvider.getArtistSongs!(rawId, platformCookie);
    return songs.map((s) => ({
      ...s,
      id: s.id.startsWith("qq:") ? s.id : buildSongUrn("qq", s.id),
    }));
  }

  /**
   * 专辑只来自网易云：QQ 音乐的依赖库没有专辑曲目接口，
   * 产出 QQ 专辑只会让调用方选中一张点不开的专辑。
   */
  async searchAlbums(
    keyword: string,
    limit = 10,
    cookie?: MusicCookieInput,
    options: MusicSearchOptions = {}
  ): Promise<SongAlbumSearchResult[]> {
    const neteaseCookie = resolvePlatformCookie(cookie, "netease");
    const netease = await this.neteaseProvider.searchAlbums?.(keyword, limit, neteaseCookie);
    const list = (netease ?? []).map((a) => ({
      ...a,
      id: a.id.startsWith("netease:") ? a.id : buildSongUrn("netease", a.id),
    }));
    return mergeSearchLists(
      list,
      [],
      (album) => {
        const nameKey = normalizeComparableText(album.name);
        return nameKey ? `${nameKey}|${normalizeComparableText(album.artist ?? "")}` : album.id;
      },
      options.platformPreference,
      limit
    );
  }

  async getAlbumSongs(albumId: string, cookie?: MusicCookieInput): Promise<SongSearchResult[]> {
    const { platform, rawId } = parseSongUrn(albumId);
    if (platform === "qq") {
      // 与「歌曲不可用」同口径：猜番候选解析会按不可用候选跳过，而不是把它当全局故障。
      throw new AppError("SONG_NOT_FOUND", "QQ 音乐暂不提供专辑曲目");
    }
    const songs = await this.neteaseProvider.getAlbumSongs!(
      rawId,
      resolvePlatformCookie(cookie, platform)
    );
    return songs.map((s) => ({
      ...s,
      id: s.id.startsWith("netease:") ? s.id : buildSongUrn("netease", s.id),
    }));
  }

  createQrLogin(platform?: "netease" | "qq", type?: "qq" | "wx" | "mobile"): Promise<MusicQrLogin> {
    if (platform === "qq") {
      return this.qqProvider.createQrLogin!(platform, type);
    }
    return this.neteaseProvider.createQrLogin!(platform, type);
  }

  checkQrLogin(
    key: string,
    platform?: "netease" | "qq",
    type?: "qq" | "wx" | "mobile"
  ): Promise<MusicQrLoginCheck> {
    if (platform === "qq") {
      return this.qqProvider.checkQrLogin!(key, platform, type);
    }
    return this.neteaseProvider.checkQrLogin!(key, platform, type);
  }

  getLoginStatus(
    cookie: string,
    platform?: "netease" | "qq",
    options?: { forceRefresh?: boolean }
  ): Promise<MusicLoginSession> {
    if (platform === "qq") {
      return this.qqProvider.getLoginStatus!(cookie, platform, options);
    }
    return this.neteaseProvider.getLoginStatus!(cookie, platform, options);
  }
}
