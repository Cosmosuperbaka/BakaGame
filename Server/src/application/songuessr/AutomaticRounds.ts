import { AppError } from "../../domain/Errors";
import { normalizeWord } from "../../domain/Rules";
import { isPlayableSong } from "../../infrastructure/MusicDeduplicator";
import type { BangumiDataProvider } from "../../infrastructure/LocalBangumiProvider";
import type {
  MusicCookieInput,
  MusicSearchOptions,
} from "../../infrastructure/NeteaseMusicProvider";
import {
  ALL_BANGUMI_TRACK_KINDS,
  MAX_MIN_POPULARITY,
  type AnimeAutoFilters,
  type SongAutoFilters,
  type SongAutoFiltersInput,
  type SongDetails,
  type SongSearchResult,
} from "../../shared/Index";
import { resolveAnimeSong } from "./AnimeResolution";
import {
  hasAvailablePoolAccount,
  musicSearchOptions,
  songPlayabilityContext,
  withAggregatedAccounts,
  withSongAccount,
} from "./MusicAccounts";
import {
  AUTO_ANIME_CANDIDATE_LIMIT,
  AUTO_POPULARITY_LOOKUP_LIMIT,
  AUTO_SONG_CANDIDATE_LIMIT,
  DEFAULT_AUTO_PLAYLIST_ID,
  SonGuessrRoomRecord,
  clampInt,
  isUnusableSongCandidate,
  resolveRecentSongWindow,
} from "./Records";
import type { SonGuessrServiceInternals } from "./ServiceInternals";
import { normalizeSongText } from "./SongTitleMatching";

/** 猜歌自动出题选曲：筛选条件归一化、自动开局候选池构建与逐首重试出题；状态仍由 SonGuessrService 持有，这里只放共享行为。 */
export const normalizeAutoFilters = (
  service: SonGuessrServiceInternals,
  filters: SongAutoFiltersInput
): SongAutoFilters => {
  const playlist = filters.playlist
    ? {
        id: service.parsePlaylistId(filters.playlist.id),
        name: filters.playlist.name?.trim().slice(0, 120),
        songCount: filters.playlist.songCount,
      }
    : undefined;
  const artists = (filters.artists ?? [])
    .slice(0, 20)
    .map((artist) => ({
      id: artist.id.trim().slice(0, 64),
      name: normalizeWord(artist.name).slice(0, 80),
    }))
    .filter((artist) => artist.id && artist.name);
  const minPopularity = clampInt(filters.minPopularity ?? 0, 0, MAX_MIN_POPULARITY);
  return { playlist, artists, minPopularity };
};

export const normalizeAnimeAutoFilters = (filters: AnimeAutoFilters): AnimeAutoFilters => {
  const startYear = filters.startYear && clampInt(filters.startYear, 1900, 2200);
  const endYear = filters.endYear && clampInt(filters.endYear, 1900, 2200);
  const trackKinds = (filters.trackKinds ?? ALL_BANGUMI_TRACK_KINDS).filter(
    (kind, index, all) => ALL_BANGUMI_TRACK_KINDS.includes(kind) && all.indexOf(kind) === index
  );
  const songMinPopularity = clampInt(filters.songMinPopularity ?? 0, 0, MAX_MIN_POPULARITY);
  return {
    startYear,
    endYear: endYear && startYear ? Math.max(startYear, endYear) : endYear,
    ranking: filters.ranking === "year" ? "year" : "all",
    subjectLimit: clampInt(filters.subjectLimit ?? 50, 1, 1000),
    songMinPopularity,
    trackKinds:
      trackKinds.length > 0
        ? (trackKinds as AnimeAutoFilters["trackKinds"])
        : [...ALL_BANGUMI_TRACK_KINDS],
  };
};

export const startAutomaticRound = async (
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord,
  verify: () => void
): Promise<void> => {
  if (room.settings.questionType === "anime") {
    const provider = service.options.bangumiProvider;
    if (!provider) throw new AppError("BANGUMI_API_UNAVAILABLE", "当前未配置 Bangumi 接口");
    await startAutomaticAnimeRound(service, room, provider, verify);
    return;
  }

  await startAutomaticSongRound(service, room, verify);
};

/** 自动出题（番剧）：在筛选池里逐个试到第一部有可播关联曲的番剧为止。 */
export const startAutomaticAnimeRound = async (
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord,
  provider: BangumiDataProvider,
  verify: () => void
): Promise<void> => {
  const filters = room.settings.animeAutoFilters ?? {};
  const poolSize = Math.min(filters.subjectLimit ?? 50, 50);
  const year =
    filters.ranking === "year" && filters.startYear && filters.endYear
      ? filters.startYear + service.random.nextInt(filters.endYear - filters.startYear + 1)
      : undefined;
  const candidates = await provider.searchSubjects(
    "",
    poolSize,
    year
      ? {
          ...filters,
          startYear: year,
          endYear: year,
        }
      : filters
  );
  const recentSubjectIds = new Set(room.recentSubjectIds ?? []);
  const freshCandidates = candidates.filter((c) => !recentSubjectIds.has(c.id));
  const pool = freshCandidates.length > 0 ? [...freshCandidates] : [...candidates];
  let attempts = 0;
  while (pool.length > 0 && attempts < AUTO_ANIME_CANDIDATE_LIMIT) {
    attempts += 1;
    const selected = pool.splice(service.random.nextInt(pool.length), 1)[0];
    try {
      const anime = await provider.getSubject(selected.id);
      const resolved = await resolveAnimeSong(service, room, anime);
      verify();
      service.installRound(room, resolved.song, "", anime, resolved.track);
      return;
    } catch (error) {
      if (
        !isUnusableSongCandidate(error) &&
        !(
          error instanceof AppError &&
          ["BANGUMI_NO_MUSIC", "BANGUMI_NOT_FOUND"].includes(error.code)
        )
      )
        throw error;
    }
  }
  throw new AppError("BANGUMI_NO_MUSIC", "筛选结果中没有可播放关联歌曲的番剧");
};

/** 自动出题（歌曲）：先按整池定近期窗口，再在剩下的候选里试到能拿到音频的一首。 */
export const startAutomaticSongRound = async (
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord,
  verify: () => void
): Promise<void> => {
  const candidates = await resolveAutomaticCandidates(service, room);
  if (candidates.length === 0) {
    throw new AppError("AUTO_NO_MATCH", "没有符合当前筛选条件的歌曲");
  }
  // 候选池不再按会员状态预剔除：会员专享曲会由 `getSong` 的解灰链路取回完整音频，
  // 能否出题以「实际拿到的音频」为准，不再看账号是不是会员。
  // 窗口长度取自整池而不是「扣掉近期后的剩余」，否则窗口会依赖自己的结果：
  // 池子被扣小时窗口跟着缩，等价于每回合都在放宽去重。必须先用整池定长度，再排除。
  const recentSongWindow = resolveRecentSongWindow(candidates.length);
  const recentSongIds = new Set((room.recentSongIds ?? []).slice(0, recentSongWindow));
  const freshCandidates = candidates.filter((song) => !recentSongIds.has(song.id));
  // 可播的排前面只是软排序：会员专享曲仍留在池里，前面的候选都取不到音频时照常继续试。
  // 这样非会员 QQ 号不会每轮先拿 VIP 曲去撞 `getSong`，把尝试次数耗在必失败的请求上。
  const playability = songPlayabilityContext(service, room);
  const pool = [...(freshCandidates.length > 0 ? freshCandidates : candidates)].sort(
    (a, b) => Number(isPlayableSong(b, playability)) - Number(isPlayableSong(a, playability))
  );
  let attempts = 0;
  while (pool.length > 0 && attempts < AUTO_SONG_CANDIDATE_LIMIT) {
    attempts += 1;
    const selected = pool.splice(service.random.nextInt(pool.length), 1)[0];
    let song: SongDetails;
    try {
      song = await withSongAccount(
        service,
        room,
        selected.id,
        (cookie) => service.options.musicProvider.getSong(selected.id, cookie),
        { requireVip: selected.id.startsWith("qq:") && selected.requiresVip === true }
      );
    } catch (error) {
      if (!isUnusableSongCandidate(error)) throw error;
      continue;
    }
    verify();
    service.installRound(room, song, "", undefined, undefined, recentSongWindow);
    return;
  }
  throw new AppError("SONG_UNAVAILABLE", "筛选结果中没有可播放的歌曲，请更换题库或稍后重试");
};

/** 自动题库取候选：整轮（歌单 / 歌手 / 热度补全）共用一次取号，结束即归还。 */
export const resolveAutomaticCandidates = async (
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord
): Promise<SongSearchResult[]> => {
  // 必须按成败归还：判死、风控与限流只在失败结果上摘号或冷却，恒记成功会让死号反复被选中。
  return withAggregatedAccounts(service, room, (cookie) =>
    collectAutomaticCandidates(service, room, cookie)
  );
};

/**
 * 匿名 QQ 只服务手动选曲：自动出题要在无人值守时稳定跑完整局，不能依赖会被限流的
 * 匿名通道。没有 QQ 账号时直接给出明确原因，而不是让歌单/歌手交集悄悄变成空集。
 */
export const assertAutomaticFiltersSupported = (
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord,
  filters: SonGuessrRoomRecord["settings"]["autoFilters"]
): void => {
  if (hasAvailablePoolAccount(service, room, "qq")) return;
  const usesQqPlaylist = filters.playlist?.id.startsWith("qq:") ?? false;
  const usesQqArtist = filters.artists.some((artist) => artist.id.startsWith("qq:"));
  if (!usesQqPlaylist && !usesQqArtist) return;
  throw new AppError(
    "MUSIC_LOGIN_REQUIRED",
    usesQqPlaylist
      ? "自动出题使用 QQ 歌单需要房间内有 QQ 音乐账号"
      : "自动出题使用 QQ 歌手需要房间内有 QQ 音乐账号"
  );
};

/**
 * 歌手筛选取歌：歌单与歌手分属不同平台时，按名字在歌单平台找同名歌手并并入。
 *
 * 两个筛选条件最终取交集，ID 又带平台前缀；若只在歌手自己的平台取歌，
 * 「网易云歌单 + QQ 歌手」的交集必然为空。按名字补一次同名歌手是最小代价的修正。
 */
export const resolveArtistFilterSongs = async (
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord,
  cookie: MusicCookieInput | undefined,
  filters: SongAutoFilters
): Promise<SongSearchResult[]> => {
  const provider = service.options.musicProvider;
  const getArtistSongs = provider.getArtistSongs?.bind(provider);
  if (!getArtistSongs) return [];
  const playlistPlatform = filters.playlist
    ? filters.playlist.id.startsWith("qq:")
      ? "qq"
      : "netease"
    : undefined;
  const searchArtists = provider.searchArtists?.bind(provider);
  const options = musicSearchOptions(service, room);
  // 查同名歌手时把歌单平台排到偏好首位：聚合结果会按名字去重，若仍按房间默认偏好，
  // 「网易云歌单 + QQ 歌手」在两边都有账号时只会留下网易云条目，QQ ID 根本拿不到。
  const lookupOptions: MusicSearchOptions = {
    ...options,
    platformPreference: playlistPlatform === "qq" ? ["qq", "netease"] : ["netease", "qq"],
  };
  const perArtist = await Promise.all(
    filters.artists.map(async (artist) => {
      const primary = await getArtistSongs(artist.id, cookie);
      const artistPlatform = artist.id.startsWith("qq:") ? "qq" : "netease";
      if (!playlistPlatform || !searchArtists || artistPlatform === playlistPlatform) {
        return primary;
      }
      const match = (await searchArtists(artist.name, 10, cookie, lookupOptions)).find(
        (candidate) =>
          candidate.id.startsWith(`${playlistPlatform}:`) &&
          normalizeSongText(candidate.name) === normalizeSongText(artist.name)
      );
      if (!match) return primary;
      return [...primary, ...(await getArtistSongs(match.id, cookie))];
    })
  );
  return perArtist.flat();
};

/** 歌单与歌手分属不同平台且交集为空时，给出可操作的原因，而不是泛化的「没有符合条件的歌曲」。 */
export const assertAutomaticFilterMatch = (
  filters: SongAutoFilters,
  candidateCount: number
): void => {
  if (candidateCount > 0 || !filters.playlist || filters.artists.length === 0) return;
  const playlistPlatform = filters.playlist.id.startsWith("qq:") ? "qq" : "netease";
  const hasOtherPlatformArtist = filters.artists.some(
    (artist) => (artist.id.startsWith("qq:") ? "qq" : "netease") !== playlistPlatform
  );
  if (!hasOtherPlatformArtist) return;
  throw new AppError(
    "AUTO_NO_MATCH",
    "所选歌单与歌手分属不同音源平台，且没有找到同名歌手；请更换筛选"
  );
};

export const collectAutomaticCandidates = async (
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord,
  cookie: MusicCookieInput | undefined
): Promise<SongSearchResult[]> => {
  const filters = room.settings.autoFilters;
  assertAutomaticFiltersSupported(service, room, filters);
  const sets: SongSearchResult[][] = [];
  if (filters.playlist && service.options.musicProvider.getPlaylistSongs) {
    sets.push(
      (await service.options.musicProvider.getPlaylistSongs(filters.playlist.id, cookie)).songs
    );
  }
  if (filters.artists.length > 0) {
    sets.push(await resolveArtistFilterSongs(service, room, cookie, filters));
  }
  if (sets.length === 0) {
    if (!service.options.musicProvider.getPlaylistSongs) {
      throw new AppError("MUSIC_API_UNAVAILABLE", "当前音乐 API 不支持自动题库");
    }
    sets.push(
      (await service.options.musicProvider.getPlaylistSongs(DEFAULT_AUTO_PLAYLIST_ID, cookie)).songs
    );
  }
  const first = new Map(sets[0].map((song) => [song.id, song]));
  for (const set of sets.slice(1)) {
    const ids = new Set(set.map((song) => song.id));
    for (const id of first.keys()) if (!ids.has(id)) first.delete(id);
  }
  const candidates = [...first.values()];
  assertAutomaticFilterMatch(filters, candidates.length);
  if (filters.minPopularity === 0) return candidates;
  const knownMatches = candidates.filter(
    (song) => song.popularity !== undefined && song.popularity >= filters.minPopularity
  );
  if (knownMatches.length > 0) return knownMatches;

  const provider = service.options.musicProvider;
  const getPopularity = provider.getSongPopularity?.bind(provider);
  if (!getPopularity) {
    return [];
  }

  // 大歌单不能逐首回源查询热度。随机抽取有限候选，缓存命中仍可复用，
  // 冷缓存下单轮最多发起固定数量的上游请求，避免限流恢复后继续堆积。
  const lookupPool = [...candidates];
  const sampled: SongSearchResult[] = [];
  while (lookupPool.length > 0 && sampled.length < AUTO_POPULARITY_LOOKUP_LIMIT) {
    sampled.push(lookupPool.splice(service.random.nextInt(lookupPool.length), 1)[0]);
  }

  const enriched: SongSearchResult[] = [];
  for (let index = 0; index < sampled.length; index += 4) {
    const batch = sampled.slice(index, index + 4);
    const values = await Promise.all(
      batch.map(async (song) => ({
        ...song,
        popularity: (await getPopularity(song.id, cookie)) ?? song.popularity,
      }))
    );
    enriched.push(...values);
  }
  return enriched.filter((song) => (song.popularity ?? 0) >= filters.minPopularity);
};
