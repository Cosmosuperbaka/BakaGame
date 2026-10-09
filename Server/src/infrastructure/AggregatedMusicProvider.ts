import { AppError } from "../domain/Errors";
import { describeError, type EventLogger } from "./EventLogger";
import { parseSongUrn, buildSongUrn } from "./MusicUrn";
import { aggregateAndDeduplicateSongs, type AggregatedSongSearchResult } from "./MusicDeduplicator";
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
  SongPlaylistInfo,
  SongSearchResult,
} from "../shared/SonGuessr";

export interface AggregatedMusicProviderOptions {
  neteaseProvider: MusicProvider;
  qqProvider: MusicProvider;
  logger?: EventLogger;
}

export class AggregatedMusicProvider implements MusicProvider {
  private readonly neteaseProvider: MusicProvider;
  private readonly qqProvider: MusicProvider;
  private readonly logger?: EventLogger;

  constructor(options: AggregatedMusicProviderOptions) {
    this.neteaseProvider = options.neteaseProvider;
    this.qqProvider = options.qqProvider;
    this.logger = options.logger;
  }

  async search(keyword: string, limit = 20, cookie?: string): Promise<SongSearchResult[]> {
    const normalized = keyword.trim();
    if (!normalized) return [];

    // 双端并行检索并做单边熔断与容错保护
    const [neteaseSettled, qqSettled] = await Promise.allSettled([
      this.neteaseProvider.search(normalized, limit, cookie),
      this.qqProvider.search(normalized, limit, cookie),
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

  async getSong(songId: string, cookie?: string): Promise<SongDetails> {
    const { platform, rawId } = parseSongUrn(songId);

    if (platform === "netease") {
      try {
        const details = await this.neteaseProvider.getSong(rawId, cookie);
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
        const fallback = await this.tryFailover(songId, this.qqProvider, cookie);
        if (fallback) return fallback;
        throw error;
      }
    }

    if (platform === "qq") {
      try {
        const details = await this.qqProvider.getSong(rawId, cookie);
        return {
          ...details,
          id: buildSongUrn("qq", rawId),
        };
      } catch (error) {
        this.logger?.warn?.("QQ音乐歌曲加载失败，尝试触发音源 Failover", {
          songId,
          ...describeError(error),
        });
        const fallback = await this.tryFailover(songId, this.neteaseProvider, cookie);
        if (fallback) return fallback;
        throw error;
      }
    }

    throw new AppError("INVALID_PLATFORM", `未知音源平台: ${platform}`);
  }

  private async tryFailover(
    originalSongId: string,
    targetProvider: MusicProvider,
    cookie?: string
  ): Promise<SongDetails | null> {
    try {
      // 1. 尝试读取原歌曲元数据
      const originMeta = await this.getSongMetadata(originalSongId, cookie);
      if (!originMeta.title) return null;

      // 2. 在备选平台检索
      const candidates = await targetProvider.search(
        `${originMeta.title} ${originMeta.artist}`,
        5,
        cookie
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
      return await targetProvider.getSong(parsed.rawId, cookie);
    } catch {
      return null;
    }
  }

  async refreshSongAudio(songId: string, cookie?: string): Promise<string> {
    const { platform, rawId } = parseSongUrn(songId);
    if (platform === "netease") {
      return (
        this.neteaseProvider.refreshSongAudio?.(rawId, cookie) ??
        (await this.neteaseProvider.getSong(rawId, cookie)).audioUrl
      );
    }
    return (
      this.qqProvider.refreshSongAudio?.(rawId, cookie) ??
      (await this.qqProvider.getSong(rawId, cookie)).audioUrl
    );
  }

  async getSongMetadata(songId: string, cookie?: string): Promise<SongDetails> {
    const { platform, rawId } = parseSongUrn(songId);
    if (platform === "netease") {
      const res = await this.neteaseProvider.getSongMetadata(rawId, cookie);
      return {
        ...res,
        id: buildSongUrn("netease", rawId),
      };
    }
    const res = await this.qqProvider.getSongMetadata(rawId, cookie);
    return {
      ...res,
      id: buildSongUrn("qq", rawId),
    };
  }

  async getSongPopularity(songId: string, cookie?: string): Promise<number | undefined> {
    const { platform, rawId } = parseSongUrn(songId);
    if (platform === "netease") {
      return this.neteaseProvider.getSongPopularity?.(rawId, cookie);
    }
    return this.qqProvider.getSongPopularity?.(rawId, cookie);
  }

  async getSongChorus(songId: string, cookie?: string): Promise<SongChorus | undefined> {
    const { platform, rawId } = parseSongUrn(songId);
    if (platform === "netease") {
      return this.neteaseProvider.getSongChorus?.(rawId, cookie);
    }
    return this.qqProvider.getSongChorus?.(rawId, cookie);
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
    cookie?: string
  ): Promise<{ info: SongPlaylistInfo; songs: SongSearchResult[] }> {
    const trimmed = playlistId.trim();
    if (trimmed.startsWith("qq:") || /y\.qq\.com/i.test(trimmed)) {
      const rawId = trimmed.startsWith("qq:") ? trimmed.slice(3) : trimmed;
      const res = await this.qqProvider.getPlaylistSongs!(rawId, cookie);
      return {
        info: { ...res.info, id: res.info.id.startsWith("qq:") ? res.info.id : buildSongUrn("qq", res.info.id) },
        songs: res.songs.map((s) => ({
          ...s,
          id: s.id.startsWith("qq:") ? s.id : buildSongUrn("qq", s.id),
        })),
      };
    }
    const rawId = trimmed.startsWith("netease:") ? trimmed.slice(8) : trimmed;
    const res = await this.neteaseProvider.getPlaylistSongs!(rawId, cookie);
    return {
      info: { ...res.info, id: res.info.id.startsWith("netease:") ? res.info.id : buildSongUrn("netease", res.info.id) },
      songs: res.songs.map((s) => ({
        ...s,
        id: s.id.startsWith("netease:") ? s.id : buildSongUrn("netease", s.id),
      })),
    };
  }

  async searchArtists(keyword: string, limit = 20, cookie?: string): Promise<SongArtistSearchResult[]> {
    const [netease, qq] = await Promise.allSettled([
      this.neteaseProvider.searchArtists?.(keyword, limit, cookie),
      this.qqProvider.searchArtists?.(keyword, limit, cookie),
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

  async getArtistSongs(artistId: string, cookie?: string): Promise<SongSearchResult[]> {
    const { platform, rawId } = parseSongUrn(artistId);
    if (platform === "netease") {
      const songs = await this.neteaseProvider.getArtistSongs!(rawId, cookie);
      return songs.map((s) => ({
        ...s,
        id: s.id.startsWith("netease:") ? s.id : buildSongUrn("netease", s.id),
      }));
    }
    const songs = await this.qqProvider.getArtistSongs!(rawId, cookie);
    return songs.map((s) => ({
      ...s,
      id: s.id.startsWith("qq:") ? s.id : buildSongUrn("qq", s.id),
    }));
  }

  async searchAlbums(keyword: string, limit = 10, cookie?: string): Promise<SongAlbumSearchResult[]> {
    const [netease, qq] = await Promise.allSettled([
      this.neteaseProvider.searchAlbums?.(keyword, limit, cookie),
      this.qqProvider.searchAlbums?.(keyword, limit, cookie),
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

  async getAlbumSongs(albumId: string, cookie?: string): Promise<SongSearchResult[]> {
    const { platform, rawId } = parseSongUrn(albumId);
    if (platform === "netease") {
      const songs = await this.neteaseProvider.getAlbumSongs!(rawId, cookie);
      return songs.map((s) => ({
        ...s,
        id: s.id.startsWith("netease:") ? s.id : buildSongUrn("netease", s.id),
      }));
    }
    const songs = await this.qqProvider.getAlbumSongs!(rawId, cookie);
    return songs.map((s) => ({
      ...s,
      id: s.id.startsWith("qq:") ? s.id : buildSongUrn("qq", s.id),
    }));
  }

  createQrLogin(): Promise<MusicQrLogin> {
    return this.neteaseProvider.createQrLogin!();
  }

  checkQrLogin(key: string): Promise<MusicQrLoginCheck> {
    return this.neteaseProvider.checkQrLogin!(key);
  }

  getLoginStatus(cookie: string): Promise<MusicLoginSession> {
    return this.neteaseProvider.getLoginStatus!(cookie);
  }
}
