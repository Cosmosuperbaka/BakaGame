import { AppError } from "../../domain/Errors";
import { normalizeWord } from "../../domain/Rules";
import {
  extractArtistTokens,
  extractCanonicalTitle,
  isPlayableSong,
} from "../../infrastructure/MusicDeduplicator";
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
  MAX_UNAVAILABLE_SONG_RECORDS,
  UNAVAILABLE_SONG_TTL_MS,
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
    await runLoggedAutomaticRound(service, room, () =>
      startAutomaticAnimeRound(service, room, provider, verify)
    );
    return;
  }

  await runLoggedAutomaticRound(service, room, () =>
    startAutomaticSongRound(service, room, verify)
  );
};

/**
 * 自动开局/下一轮失败在传输层日志里只是一条 400，看不出是限流、没歌可播还是别的原因；
 * 失败时留下错误码，原样再抛，不改变对玩家的报错。
 */
const runLoggedAutomaticRound = async (
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord,
  run: () => Promise<void>
): Promise<void> => {
  try {
    await run();
  } catch (error) {
    service.log("song.auto.failed", room.id, undefined, {
      questionType: room.settings.questionType,
      code: error instanceof AppError ? error.code : "UNKNOWN",
    });
    throw error;
  }
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

/** 同一作品的归并键：曲名去掉版本后缀，歌手取第一位。 */
const songWorkKey = (song: SongSearchResult): string => {
  const title = extractCanonicalTitle(song.title);
  if (!title) return song.id;
  return `${title}|${extractArtistTokens(song.artist)[0] ?? ""}`;
};

/**
 * 把同一作品的多个 ID 合并成一首。
 *
 * 歌单常把一首歌收录多次（专辑版、单曲版、现场版），ID 各不相同。近期窗口按 ID 记账，
 * 不合并的话玩家隔几轮就会再听到“同一首”，答案也一样。每首作品只留一个候选：
 * 优先留近期播过的那个 ID，窗口才认得它；其次留能播的。
 */
export const collapseSameWorks = (
  candidates: readonly SongSearchResult[],
  recentIds: readonly string[],
  isPlayable: (song: SongSearchResult) => boolean
): SongSearchResult[] => {
  const recent = new Set(recentIds);
  const score = (song: SongSearchResult): number =>
    (recent.has(song.id) ? 2 : 0) + (isPlayable(song) ? 1 : 0);
  const works = new Map<string, SongSearchResult>();
  for (const song of candidates) {
    const key = songWorkKey(song);
    const kept = works.get(key);
    if (!kept || score(song) > score(kept)) works.set(key, song);
  }
  return [...works.values()];
};

/** 自动选曲的候选分层：靠前的层先抽，抽空或全部失败后才落到下一层。 */
export interface AutomaticCandidateTiers {
  /** 每层按抽取顺序给出；`ordered` 为真的层依次取（最久没播的先出），否则层内均匀随机。 */
  tiers: { name: string; songs: SongSearchResult[]; ordered: boolean }[];
  fresh: number;
  recycled: number;
  knownUnavailable: number;
}

/**
 * 把候选池分成「新鲜 → 回收 → 已知取不到」三类，并让可播的先于不可播。
 *
 * - 新鲜：不在近期窗口、也不在近期取不到记录里。这一层才是随机出题的主体。
 * - 回收：近期窗口里的歌，按最久没播的先出。只有新鲜层抽空或全部失败才会用到，
 *   这样小歌单耗尽后重复的间隔也最大。
 * - 已知取不到：近期失败过的候选，放最后兜底（下架、限流恢复后可能又能播）。
 * 软排序必须落实在分层上：此前仅对数组排序再按随机下标抽，排序对结果毫无作用。
 */
export const buildAutomaticCandidateTiers = (
  candidates: readonly SongSearchResult[],
  recentIds: readonly string[],
  unavailableIds: ReadonlySet<string>,
  isPlayable: (song: SongSearchResult) => boolean
): AutomaticCandidateTiers => {
  const recentRank = new Map(recentIds.map((id, index) => [id, index]));
  const fresh = candidates.filter(
    (song) => !recentRank.has(song.id) && !unavailableIds.has(song.id)
  );
  const recycled = candidates
    .filter((song) => recentRank.has(song.id))
    .sort((left, right) => recentRank.get(right.id)! - recentRank.get(left.id)!);
  const knownUnavailable = candidates.filter(
    (song) => !recentRank.has(song.id) && unavailableIds.has(song.id)
  );
  return {
    tiers: [
      { name: "fresh-playable", songs: fresh.filter(isPlayable), ordered: false },
      {
        name: "fresh-unplayable",
        songs: fresh.filter((song) => !isPlayable(song)),
        ordered: false,
      },
      { name: "recycled", songs: recycled, ordered: true },
      { name: "unavailable", songs: knownUnavailable, ordered: false },
    ],
    fresh: fresh.length,
    recycled: recycled.length,
    knownUnavailable: knownUnavailable.length,
  };
};

const songPlatformOf = (id: string): "qq" | "netease" => (id.startsWith("qq:") ? "qq" : "netease");

/** 取不到音频的候选记进房间：过期项顺手清掉，总量封顶。 */
const rememberUnavailableSong = (room: SonGuessrRoomRecord, id: string, now: number): void => {
  const records = room.unavailableSongIds ?? {};
  for (const [key, at] of Object.entries(records)) {
    if (now - at >= UNAVAILABLE_SONG_TTL_MS) delete records[key];
  }
  records[id] = now;
  const overflow = Object.keys(records).length - MAX_UNAVAILABLE_SONG_RECORDS;
  if (overflow > 0) {
    // 对象键按插入序遍历，最早记下的先丢。
    for (const key of Object.keys(records).slice(0, overflow)) delete records[key];
  }
  room.unavailableSongIds = records;
};

const liveUnavailableIds = (room: SonGuessrRoomRecord, now: number): Set<string> =>
  new Set(
    Object.entries(room.unavailableSongIds ?? {})
      .filter(([, at]) => now - at < UNAVAILABLE_SONG_TTL_MS)
      .map(([id]) => id)
  );

/** 自动出题（歌曲）：先按整池定近期窗口，再分层抽取，试到能拿到音频的一首。 */
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
  const now = service.now();
  const playability = songPlayabilityContext(service, room);
  const isPlayable = (song: SongSearchResult): boolean => isPlayableSong(song, playability);
  const works = collapseSameWorks(candidates, room.recentSongIds ?? [], isPlayable);
  // 窗口长度取自整池而不是「扣掉近期后的剩余」，否则窗口会依赖自己的结果：
  // 池子被扣小时窗口跟着缩，等价于每回合都在放宽去重。必须先用整池定长度，再排除。
  const recentSongWindow = resolveRecentSongWindow(works.length);
  const layout = buildAutomaticCandidateTiers(
    works,
    (room.recentSongIds ?? []).slice(0, recentSongWindow),
    liveUnavailableIds(room, now),
    isPlayable
  );
  // 候选被近期窗口、失败记录或不可播悄悄缩小时必须留痕，否则「总是那几首」无从排查。
  service.log("song.auto.pool", room.id, undefined, {
    candidates: candidates.length,
    works: works.length,
    fresh: layout.fresh,
    recycled: layout.recycled,
    knownUnavailable: layout.knownUnavailable,
    freshPlayable: layout.tiers[0].songs.length,
    window: recentSongWindow,
  });

  const limitedPlatforms = new Set<string>();
  let rateLimited: AppError | undefined;
  let attempts = 0;
  let failures = 0;
  const draw = (): SongSearchResult | undefined => {
    for (const tier of layout.tiers) {
      // 已被限流的平台本轮不再碰：同一条限流线继续打只会空转。
      const usable = tier.songs.findIndex((song) => !limitedPlatforms.has(songPlatformOf(song.id)));
      if (usable < 0) continue;
      const index = tier.ordered
        ? usable
        : pickUsableIndex(tier.songs, limitedPlatforms, service.random);
      return tier.songs.splice(index, 1)[0];
    }
    return undefined;
  };
  for (let selected = draw(); selected && attempts < AUTO_SONG_CANDIDATE_LIMIT; selected = draw()) {
    attempts += 1;
    let song: SongDetails;
    try {
      song = await withSongAccount(
        service,
        room,
        selected.id,
        (cookie) =>
          service.options.musicProvider.getSong(selected!.id, cookie, {
            // 题库里已有标题与歌手：原平台被限流时，跨平台兜底不必再回源取元数据。
            hint: {
              title: selected!.title,
              artist: selected!.artist,
              durationMs: selected!.durationMs,
            },
          }),
        { requireVip: selected.id.startsWith("qq:") && selected.requiresVip === true }
      );
    } catch (error) {
      if (error instanceof AppError && error.code === "MUSIC_API_RATE_LIMITED") {
        // 限流不代表这首歌不能播：不记失败，只让这个平台本轮退场，改抽别的平台的候选。
        rateLimited = error;
        limitedPlatforms.add(songPlatformOf(selected.id));
        continue;
      }
      if (!isUnusableSongCandidate(error)) throw error;
      failures += 1;
      rememberUnavailableSong(room, selected.id, service.now());
      continue;
    }
    verify();
    service.installRound(room, song, "", undefined, undefined, undefined, selected.id);
    return;
  }
  service.log("song.auto.exhausted", room.id, undefined, {
    candidates: candidates.length,
    attempts,
    failures,
    limitedPlatforms: [...limitedPlatforms],
  });
  // 只要有一条限流线被挡过，就把限流如实抛出：玩家看到的是「稍后再试」而不是「歌都不能播」。
  if (rateLimited) throw rateLimited;
  throw new AppError("SONG_UNAVAILABLE", "筛选结果中没有可播放的歌曲，请更换题库或稍后重试");
};

/** 在未被限流的候选里均匀随机取一个下标。 */
const pickUsableIndex = (
  songs: readonly SongSearchResult[],
  limitedPlatforms: ReadonlySet<string>,
  random: SonGuessrServiceInternals["random"]
): number => {
  if (limitedPlatforms.size === 0) return random.nextInt(songs.length);
  const usable: number[] = [];
  songs.forEach((song, index) => {
    if (!limitedPlatforms.has(songPlatformOf(song.id))) usable.push(index);
  });
  return usable[random.nextInt(usable.length)];
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
