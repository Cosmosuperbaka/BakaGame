import { AppError } from "../domain/Errors";
import { describeError, type EventLogger } from "./EventLogger";
import { parseSongUrn, buildSongUrn } from "./MusicUrn";
import { aggregateAndDeduplicateSongs } from "./MusicDeduplicator";
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
  SongPlaylistInfo,
  SongSearchResult,
} from "../shared/SonGuessr";

export interface AggregatedMusicProviderOptions {
  neteaseProvider: MusicProvider;
  qqProvider: MusicProvider;
  logger?: EventLogger;
}

type MusicPlatform = "netease" | "qq";

/** 组合凭据（JSON 形态）里按平台取值：非字符串一律视为未配置。 */
const pickPlatformCookieField = (
  fields: Partial<Record<MusicPlatform, unknown>>,
  platform?: MusicPlatform
): string | undefined => {
  const val = platform === "qq" ? fields.qq : fields.netease;
  return typeof val === "string" ? val : undefined;
};

/** 看起来是 `{ "netease": ..., "qq": ... }` 形态的组合凭据字符串。 */
const looksLikeCompositeCookie = (cookie: string): boolean =>
  cookie.startsWith("{") && (cookie.includes("netease") || cookie.includes("qq"));

/** 解析组合凭据字符串；不是 JSON 形态时返回 null，交由单平台凭据特征继续判定。 */
const parseCompositeCookie = (
  cookie: string,
  platform?: MusicPlatform
): string | undefined | null => {
  if (!looksLikeCompositeCookie(cookie)) return null;
  try {
    const obj = JSON.parse(cookie) as Partial<Record<MusicPlatform, unknown>>;
    return pickPlatformCookieField(obj, platform);
  } catch {
    /* 不是 JSON 形态的组合凭据，按单平台凭据特征继续判定 */
  }
  return null;
};

/**
 * 单平台特定凭据特征检查：避免将特定平台的凭据传递给互斥平台。
 *
 * 返回 true 表示这份凭据对目标平台无效。
 */
const isPlatformMismatchedCookie = (cookie: string, platform?: MusicPlatform): boolean => {
  if (platform === "qq") return cookie.includes("MUSIC_U") || cookie.includes("NMTID");
  if (platform === "netease") {
    return (
      cookie.includes("qm_keyst") || cookie.includes("musickey") || cookie.includes("qqmusic_key")
    );
  }
  return false;
};

const resolveStringCookie = (cookie: string, platform?: MusicPlatform): string | undefined => {
  const composite = parseCompositeCookie(cookie, platform);
  if (composite !== null) return composite;
  if (isPlatformMismatchedCookie(cookie, platform)) return undefined;
  return cookie;
};

const resolvePlatformCookie = (
  cookie?: MusicCookieInput,
  platform?: MusicPlatform
): string | undefined => {
  if (!cookie) return undefined;
  if (typeof cookie === "object" && cookie !== null)
    return pickPlatformCookieField(cookie, platform);
  if (typeof cookie === "string") return resolveStringCookie(cookie, platform);
  return undefined;
};

export class AggregatedMusicProvider implements MusicProvider {
  private readonly neteaseProvider: MusicProvider;
  private readonly qqProvider: MusicProvider;
  private readonly logger?: EventLogger;

  constructor(options: AggregatedMusicProviderOptions) {
    this.neteaseProvider = options.neteaseProvider;
    this.qqProvider = options.qqProvider;
    this.logger = options.logger;
  }

  async search(
    keyword: string,
    limit = 20,
    cookie?: MusicCookieInput
  ): Promise<SongSearchResult[]> {
    const normalized = keyword.trim();
    if (!normalized) return [];

    const neteaseCookie = resolvePlatformCookie(cookie, "netease");
    const qqCookie = resolvePlatformCookie(cookie, "qq");

    // 双端并行检索并做单边熔断与容错保护
    const [neteaseSettled, qqSettled] = await Promise.allSettled([
      this.neteaseProvider.search(normalized, limit, neteaseCookie),
      this.qqProvider.search(normalized, limit, qqCookie),
    ]);

    const neteaseSongs: (SongSearchResult & { upstreamRank?: number })[] =
      neteaseSettled.status === "fulfilled"
        ? neteaseSettled.value.map((s, index) => ({
            ...s,
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
            ...s,
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
    return aggregateAndDeduplicateSongs(allCandidates, normalized, limit);
  }

  async getSong(songId: string, cookie?: MusicCookieInput): Promise<SongDetails> {
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
        this.logger?.warn?.("网易云歌曲加载失败，尝试触发音源 Failover", {
          songId,
          ...describeError(error),
        });
        // 尝试按歌名+歌手在 QQ 音乐中兜底检索并播放
        const qqCookie = resolvePlatformCookie(cookie, "qq");
        const neteaseCookie = resolvePlatformCookie(cookie, "netease");
        const fallback = await this.tryFailover(songId, this.qqProvider, neteaseCookie, qqCookie);
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
        this.logger?.warn?.("QQ音乐歌曲加载失败，尝试触发音源 Failover", {
          songId,
          ...describeError(error),
        });
        const neteaseCookie = resolvePlatformCookie(cookie, "netease");
        const qqCookie = resolvePlatformCookie(cookie, "qq");
        const fallback = await this.tryFailover(
          songId,
          this.neteaseProvider,
          qqCookie,
          neteaseCookie
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
    originCookie?: string,
    targetCookie?: string
  ): Promise<SongDetails | null> {
    try {
      // 1. 尝试读取原歌曲元数据
      const originMeta = await this.getSongMetadata(originalSongId, originCookie);
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
      const parsed = parseSongUrn(bestCandidate.id);
      return await targetProvider.getSong(parsed.rawId, targetCookie);
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
    cookie?: MusicCookieInput
  ): Promise<SongArtistSearchResult[]> {
    const neteaseCookie = resolvePlatformCookie(cookie, "netease");
    const qqCookie = resolvePlatformCookie(cookie, "qq");
    const [netease, qq] = await Promise.allSettled([
      this.neteaseProvider.searchArtists?.(keyword, limit, neteaseCookie),
      this.qqProvider.searchArtists?.(keyword, limit, qqCookie),
    ]);
    const list1 = (netease.status === "fulfilled" ? netease.value || [] : []).map((a) => ({
      ...a,
      id: a.id.startsWith("netease:") ? a.id : buildSongUrn("netease", a.id),
    }));
    const list2 = (qq.status === "fulfilled" ? qq.value || [] : []).map((a) => ({
      ...a,
      id: a.id.startsWith("qq:") ? a.id : buildSongUrn("qq", a.id),
    }));
    return [...list1, ...list2].slice(0, limit);
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

  async searchAlbums(
    keyword: string,
    limit = 10,
    cookie?: MusicCookieInput
  ): Promise<SongAlbumSearchResult[]> {
    const neteaseCookie = resolvePlatformCookie(cookie, "netease");
    const qqCookie = resolvePlatformCookie(cookie, "qq");
    const [netease, qq] = await Promise.allSettled([
      this.neteaseProvider.searchAlbums?.(keyword, limit, neteaseCookie),
      this.qqProvider.searchAlbums?.(keyword, limit, qqCookie),
    ]);
    const list1 = (netease.status === "fulfilled" ? netease.value || [] : []).map((a) => ({
      ...a,
      id: a.id.startsWith("netease:") ? a.id : buildSongUrn("netease", a.id),
    }));
    const list2 = (qq.status === "fulfilled" ? qq.value || [] : []).map((a) => ({
      ...a,
      id: a.id.startsWith("qq:") ? a.id : buildSongUrn("qq", a.id),
    }));
    return [...list1, ...list2].slice(0, limit);
  }

  async getAlbumSongs(albumId: string, cookie?: MusicCookieInput): Promise<SongSearchResult[]> {
    const { platform, rawId } = parseSongUrn(albumId);
    const platformCookie = resolvePlatformCookie(cookie, platform);
    if (platform === "netease") {
      const songs = await this.neteaseProvider.getAlbumSongs!(rawId, platformCookie);
      return songs.map((s) => ({
        ...s,
        id: s.id.startsWith("netease:") ? s.id : buildSongUrn("netease", s.id),
      }));
    }
    const songs = await this.qqProvider.getAlbumSongs!(rawId, platformCookie);
    return songs.map((s) => ({
      ...s,
      id: s.id.startsWith("qq:") ? s.id : buildSongUrn("qq", s.id),
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

  getLoginStatus(cookie: string, platform?: "netease" | "qq"): Promise<MusicLoginSession> {
    if (platform === "qq") {
      return this.qqProvider.getLoginStatus!(cookie, platform);
    }
    return this.neteaseProvider.getLoginStatus!(cookie, platform);
  }
}
