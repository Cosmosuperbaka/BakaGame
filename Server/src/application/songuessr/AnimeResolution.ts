import { AppError } from "../../domain/Errors";
import { shuffle } from "../../domain/Rules";
import {
  ALL_BANGUMI_TRACK_KINDS,
  refineTrackKindByText,
  type BangumiMusicTrack,
  type BangumiMusicTrackKind,
  type BangumiSongCandidate,
  type BangumiSubjectDetails,
  type ConnectionRecord,
  type SongAlbumSearchResult,
  type SongDetails,
  type SongSearchResult,
} from "../../shared/Index";
import type { MusicCookieInput, MusicProvider } from "../../infrastructure/NeteaseMusicProvider";
import {
  ALTERNATE_VERSION_PATTERN,
  buildTrackQueries,
  fallbackKindOfSong,
  isBelowMinPopularity,
  isNonVocalTrack,
  rankEvidencedCandidates,
  type AnimeSongLookup,
  type AnimeSongPick,
  type FallbackPickEntry,
  type TrackCandidatePool,
} from "./AnimeSongEvidence";
import { withAggregatedAccounts, withSongAccount } from "./MusicAccounts";
import {
  ANIME_SONG_DETAIL_BUDGET,
  ANIME_SONG_SEARCH_BUDGET,
  ANIME_SONG_SEARCH_LIMIT,
  ANIME_TRACK_DETAIL_ATTEMPTS,
  ANIME_TRACK_LOOKUP_LIMIT,
  DEFAULT_SETTINGS,
  isUnusableSongCandidate,
  type SonGuessrRoomRecord,
} from "./Records";
import {
  ALBUM_NAME_EXACT_SCORE,
  ALBUM_SEARCH_LIMIT,
  ANIME_RELEASE_CONTEXT_PATTERN,
  albumNameScore,
  buildAlbumQueries,
  isAlbumLikeTrackKind,
  isAlbumNameMatch,
  isSongCandidateMatch,
  isSongTitleMatch,
  isUnplayableAlbumTrack,
  normalizeSongTitle,
  normalizedArtists,
  retryOnce,
} from "./SongTitleMatching";
import type { SonGuessrServiceInternals } from "./ServiceInternals";

/** 猜番出题的番剧关联曲目解析：检索、专辑/番剧级兜底与逐候选验证。 */

/** 手动选曲的条目匹配上下文：一次解析内共享的检索资源、预算与已产出的结果。 */
interface AnimeTrackMatchContext {
  provider: MusicProvider;
  cookie: MusicCookieInput | undefined;
  anime: BangumiSubjectDetails;
  animeNames: string[];
  budget: { search: number; detail: number };
  results: BangumiSongCandidate[];
  seenSongIds: Set<string>;
}

export const resolveSpecifiedAnimeSong = async (
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord,
  anime: BangumiSubjectDetails,
  songId: string
): Promise<{ song: SongDetails; track: BangumiMusicTrack }> => {
  const provider = service.options.musicProvider;
  let song: SongDetails;
  try {
    song = await withSongAccount(service, room, songId, (cookie) =>
      provider.getSong(songId, cookie)
    );
  } catch (error) {
    if (!isUnusableSongCandidate(error)) throw error;
    throw new AppError("BANGUMI_NO_MUSIC", "所选歌曲无法播放或获取音频失败");
  }
  const matchedTrack = anime.musicTracks.find((t) => isSongTitleMatch(song.title, t.title)) ??
    (song.album
      ? anime.musicTracks.find((t) => isAlbumNameMatch(song.album!, t.title))
      : undefined) ??
    anime.musicTracks.find((t) => t.artist && song.artist.includes(t.artist)) ??
    anime.musicTracks[0] ?? {
      title: song.title,
      artist: song.artist,
      kind: "theme" as BangumiMusicTrackKind,
    };
  const trackKind = refineTrackKind(service, matchedTrack.kind, song);
  return {
    song,
    track: { ...matchedTrack, kind: trackKind },
  };
};

export const resolveAnimeSong = async (
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord,
  anime: BangumiSubjectDetails
): Promise<AnimeSongPick> => {
  if (anime.musicTracks.length === 0) {
    throw new AppError("BANGUMI_NO_MUSIC", "该番剧没有可识别的主题曲信息");
  }
  // 番剧名（原名 + 中文名）：既用于拼检索词，也用于「候选是否确属本番」的锚点判定。
  const animeNames = [anime.name, anime.nameCn].filter((name): name is string => Boolean(name));
  const filters =
    room.settings.questionMode === "automatic"
      ? (room.settings.animeAutoFilters ?? DEFAULT_SETTINGS.animeAutoFilters!)
      : {};
  const allowedKinds = new Set(filters.trackKinds ?? ALL_BANGUMI_TRACK_KINDS);
  // 出题必须在**所有通过筛选的曲目之间等概率**：本地数据集按 relation_order、
  // 联网 API 按 KIND_PRIORITY，都把片头曲排在最前面，直接顺序取首个可播放曲目会让
  // OP 长期霸占绝大多数回合（实测线上近乎每轮都是 OP）。先洗牌再截断，
  // 被预算截掉的曲目同样等概率，而不是永远只有排在前面的几首有机会。
  const candidates = shuffle(
    anime.musicTracks.filter((track) => allowedKinds.has(track.kind)),
    service.random
  ).slice(0, ANIME_TRACK_LOOKUP_LIMIT);
  // 整段解析（多个候选、每个都可能多次回源）共用一次取号：这确实是同一批在途请求，
  // 一次一租比每个内部请求各自取号更省，也让池里的在途数反映真实的占用者。
  // 按成败归还：内部只吞单曲不可用，凭据判死、风控与限流原样透传到这里摘号或冷却。
  return withAggregatedAccounts(service, room, (cookie) =>
    pickAnimeSong(service, candidates, {
      provider: service.options.musicProvider,
      anime,
      cookie,
      animeNames,
      minPopularity: filters.songMinPopularity ?? 0,
      recentSongIds: new Set(room.recentSongIds ?? []),
      // 已经由翻唱回指过的原曲 ID，防止两个翻唱互相指向、反复插队。
      originRetryIds: new Set<string>(),
      // 冷缓存下每个候选曲目都可能触发多次回源，必须设总预算，
      // 否则一次出题会退化成上百次串行上游请求（实测最坏 60s+）。
      budget: { search: ANIME_SONG_SEARCH_BUDGET, detail: ANIME_SONG_DETAIL_BUDGET },
    })
  );
};

const pickAnimeSong = async (
  service: SonGuessrServiceInternals,
  candidates: BangumiMusicTrack[],
  lookup: AnimeSongLookup
): Promise<AnimeSongPick> => {
  for (const track of candidates) {
    if (lookup.budget.search <= 0 || lookup.budget.detail <= 0) break;
    const pick = await resolveTrackSong(service, lookup, track);
    if (pick) return pick;
  }

  // 三档兜底按「离这首歌还有多远」排序：先是真正属于本番、只是近期出过的歌，
  // 再是同名不同曲（年份错配），最后才是别人的演唱录音。
  if (lookup.fallbackRecent) {
    return lookup.fallbackRecent;
  }

  // 所有候选都年份错配时才认它：有歌可出优先于出不了题，
  // 但排在「近期重复过的正确歌曲」之后（那至少是同一部番的歌）。
  if (lookup.fallbackYear) {
    return lookup.fallbackYear;
  }

  // 最后才认翻唱：曲名对得上、可播放，但演唱者不是原唱。保留这条兜底是为了
  // 「有歌可出优先」——整池候选全是翻唱时（原版是会员专享且解灰失败），
  // 出题总比让整部番剧出不了题好。
  if (lookup.fallbackCover) {
    return lookup.fallbackCover;
  }

  throw new AppError("BANGUMI_NO_MUSIC", "该番剧没有可播放的关联歌曲");
};

/** 单条关联曲目的出题：拼检索词 → 证据排序 → 三级候选池 → 逐首验证。 */
export const resolveTrackSong = async (
  service: SonGuessrServiceInternals,
  lookup: AnimeSongLookup,
  track: BangumiMusicTrack
): Promise<AnimeSongPick | undefined> => {
  const { provider, cookie, budget, animeNames } = lookup;
  const { queries, scopeQueries } = buildTrackQueries(track, lookup.anime);
  // 同一曲目的多个检索词之间没有依赖，并行回源把最坏等待压到一次上游往返。
  // 带番剧名的检索词单独标出来：命中它们的候选是「确实属于本番」的强证据。
  const matched = await searchAnimeTrackCandidates(
    service,
    provider,
    queries,
    track,
    cookie,
    budget,
    scopeQueries
  );
  // 网易云会把翻唱、器乐改编、伴奏等版本混排在原版之前；先按「原版优先」评分
  // 降序排列，再依次验证可播放性，确保原版存在时不会被翻唱版抢占。
  const ranked = rankEvidencedCandidates(matched, track, animeNames);
  const pool = await resolveTrackPool(service, lookup, track, ranked);
  // 三条路都没拿到可出的歌时换下一首关联曲目，绝不硬塞弱候选。
  if (pool.list.length === 0) return undefined;
  return verifyTrackPool(service, lookup, pool);
};

/**
 * 条目的候选池三级来源：常规检索 → 专辑型条目 → 番剧级兜底。
 * 只有「常规检索」这一条路允许放宽身份与年代（见 `looseFallback`）。
 */
export const resolveTrackPool = async (
  service: SonGuessrServiceInternals,
  lookup: AnimeSongLookup,
  track: BangumiMusicTrack,
  ranked: SongSearchResult[]
): Promise<TrackCandidatePool> => {
  const { provider, anime, cookie, budget } = lookup;
  if (ranked.length > 0) return { track, list: ranked, fromAnimeLevel: false, looseFallback: true };
  // 常规检索一无所获（或整池都是弱候选）时换一条路：这条关联条目可能压根不是
  // 一首歌，而是**整张专辑**（见 `ALBUM_LIKE_TRACK_KINDS`）。此时按条目名去搜
  // 单曲必然空手而归，改走「搜专辑 → 取专辑曲目」才能拿到真正可出的歌。
  if (isAlbumLikeTrackKind(track.kind)) {
    const albumPool = await resolveAlbumTrackCandidates(
      service,
      provider,
      track,
      anime,
      cookie,
      budget
    );
    if (albumPool.length > 0) {
      return { track, list: albumPool, fromAnimeLevel: false, looseFallback: false };
    }
  }
  // 最后一道兜底：条目级解析全部失败时，用番剧名检索该番的歌（见 resolveAnimeLevelCandidates）。
  // 这条路拿到的歌**与本条目无关**（只是同一部番的其它曲目），因此条目分类也不能再用 ——
  // 实测《四月は君の嘘 第8巻 特典CD》条目下的歌曲实际来自 OST 专辑，却因条目分类
  // 显示成「Radio」。
  const animePool = await resolveAnimeLevelCandidates(service, provider, anime, cookie, budget);
  return { track, list: animePool, fromAnimeLevel: true, looseFallback: false };
};

/**
 * 逐首验证候选池：热度预筛 → 取详情 → 否决非人声 → 按让位形态记兜底槽。
 * 台词轨、翻唱与年份错配都只是「让位」，一律返还验证名额，
 * 否则成批排在前面的劣质候选会把 `ANIME_TRACK_DETAIL_ATTEMPTS` 吃光，
 * 排在后面的原版连被验证的机会都没有。
 */
export const verifyTrackPool = async (
  service: SonGuessrServiceInternals,
  lookup: AnimeSongLookup,
  pool: TrackCandidatePool
): Promise<AnimeSongPick | undefined> => {
  const { budget } = lookup;
  let attempts = 0;
  // 用索引循环而非 for...of：翻唱自带原曲 ID，需要把原版插到队首交给下一次迭代验证。
  for (let index = 0; index < pool.list.length; index += 1) {
    const candidate = pool.list[index];
    if (budget.detail <= 0 || attempts >= ANIME_TRACK_DETAIL_ATTEMPTS) break;
    attempts += 1;
    // 热度不达标就无法出题，先用一次廉价的红心数查询判掉，
    // 避免为一个必然被否决的候选拉取歌词、音频与百科（约 5~6 个上游请求）。
    if (await isCandidateTooCold(service, lookup, candidate.id)) continue;
    const song = await loadPlayableSong(service, lookup, candidate.id);
    if (!song) continue;
    if (isBelowMinPopularity(song, lookup.minPopularity)) continue;
    // 台词轨 / 伴奏 / 纯音乐一律否决，且**不占验证名额**：特典 CD 里它们常成批
    // 排在前面，若让它们吃掉 ANIME_TRACK_DETAIL_ATTEMPTS，真正的歌连被验证的机会都没有。
    // 宁可这部番出不了题，也不能放一段对白让玩家猜。
    if (isNonVocalTrack(song.title)) {
      attempts -= 1;
      continue;
    }
    const pick = buildTrackPick(service, pool.track, song, pool.fromAnimeLevel);
    const kind = fallbackKindOfSong(song, lookup.anime, lookup.recentSongIds);
    if (!kind) return pick;
    recordFallbackPick(service, lookup, pool, { index, candidate, kind, pick });
    if (kind !== "recent") attempts -= 1;
  }
  return undefined;
};

/** 红心数预筛：热度明确不达标的候选不值得拉详情；查询本身失败按「不知道」放行。 */
export const isCandidateTooCold = async (
  service: SonGuessrServiceInternals,
  lookup: AnimeSongLookup,
  songId: string
): Promise<boolean> => {
  const { provider, minPopularity, budget } = lookup;
  if (minPopularity <= 0 || !provider.getSongPopularity) return false;
  budget.detail -= 1;
  const popularity = await provider.getSongPopularity
    .call(provider, songId, lookup.cookie)
    .catch((error: unknown) => {
      if (!isUnusableSongCandidate(error)) throw error;
      return undefined;
    });
  return popularity !== undefined && popularity < minPopularity;
};

/** 取歌曲详情；仅这一首不可播放时返回 undefined 交给下一候选，全局依赖失败原样透传。 */
export const loadPlayableSong = async (
  service: SonGuessrServiceInternals,
  lookup: AnimeSongLookup,
  songId: string
): Promise<SongDetails | undefined> => {
  lookup.budget.detail -= 1;
  try {
    return await lookup.provider.getSong(songId, lookup.cookie);
  } catch (error) {
    if (!isUnusableSongCandidate(error)) throw error;
    return undefined;
  }
};

/**
 * 验证通过后的出题结果。番剧级兜底的歌不属于本条目，类型只能从歌曲自身文本推
 * （与手动选曲列表同源）；其余路径仍以条目分类为基准，再用歌曲文本细化。
 */
export const buildTrackPick = (
  service: SonGuessrServiceInternals,
  track: BangumiMusicTrack,
  song: SongDetails,
  fromAnimeLevel: boolean
): AnimeSongPick => {
  return {
    song,
    track: {
      ...track,
      kind: refineTrackKind(service, fromAnimeLevel ? "theme" : track.kind, song),
    },
  };
};

/** 把让位候选记进对应兜底槽；翻唱还要把它自带的原曲插回队首。 */
export const recordFallbackPick = (
  service: SonGuessrServiceInternals,
  lookup: AnimeSongLookup,
  pool: TrackCandidatePool,
  entry: FallbackPickEntry
): void => {
  if (entry.kind === "cover") {
    // 翻唱自带原曲 ID —— 原版常常压根没进候选池（实测：Bangumi 存中文译名
    // 《你所不知道的故事》时，按译名检索只召回中文重填词的翻唱，日文原版
    // 《君の知らない物語》永远进不了池子）。直接把它插到队首，下一次迭代即验证原版。
    const originalId = entry.pick.song.originSongId;
    if (
      originalId &&
      originalId !== entry.candidate.id &&
      !lookup.originRetryIds.has(originalId) &&
      !pool.list.some((item) => item.id === originalId)
    ) {
      lookup.originRetryIds.add(originalId);
      pool.list.splice(entry.index + 1, 0, {
        id: originalId,
        title: entry.pick.track.title,
        artist: entry.pick.track.artist ?? "",
      });
    }
    if (pool.looseFallback && !lookup.fallbackCover) lookup.fallbackCover = entry.pick;
    return;
  }
  if (entry.kind === "year") {
    if (pool.looseFallback && !lookup.fallbackYear) lookup.fallbackYear = entry.pick;
    return;
  }
  if (!lookup.fallbackRecent) lookup.fallbackRecent = entry.pick;
};

/**
 * 用同一曲目的多个检索词并行回源，合并去重后只保留与曲目相关的候选。
 * 命中的判定同时接受「曲名命中」与「专辑名与原曲目名完全一致」——后者用于
 * 召回挂在整张原声带专辑下的官方原版（见 `isSongAlbumMatch`）。
 */
export const searchAnimeTrackCandidates = async (
  service: SonGuessrServiceInternals,
  provider: MusicProvider,
  queries: string[],
  track: BangumiMusicTrack,
  cookie: MusicCookieInput | undefined,
  budget: { search: number },
  /** 带番剧名/中文名的检索词：命中它们的候选标记为「番剧上下文命中」。 */
  scopeQueries: readonly string[] = []
): Promise<{ candidates: SongSearchResult[]; animeScopedIds: Set<string> }> => {
  const searches = await Promise.all(
    queries.map(async (query) => {
      if (budget.search <= 0) return { query, results: [] as SongSearchResult[] };
      budget.search -= 1;
      try {
        return { query, results: await provider.search(query, ANIME_SONG_SEARCH_LIMIT, cookie) };
      } catch (error) {
        if (!isUnusableSongCandidate(error)) throw error;
        return { query, results: [] as SongSearchResult[] };
      }
    })
  );

  const merged = new Map<string, SongSearchResult>();
  const animeScopedIds = new Set<string>();
  for (const { query, results } of searches) {
    // 标记必须做在「已合并」判断**之前**：候选可能先在裸曲名检索里进池、
    // 之后才在带番剧名的检索里出现，那一次出现才是「属于本番」的证据。
    const scoped = scopeQueries.includes(query);
    for (const candidate of results) {
      if (scoped) animeScopedIds.add(candidate.id);
      if (merged.has(candidate.id)) continue;
      if (!isSongCandidateMatch(candidate, track.title)) continue;
      merged.set(candidate.id, candidate);
    }
  }
  return { candidates: [...merged.values()], animeScopedIds };
};

/**
 * 「专辑型条目」的兜底解析：多检索词搜专辑，取最匹配那张的曲目。
 *
 * Bangumi 把大量资源挂成整张专辑条目（角色歌合辑 / 印象曲集 / OST / 精选集），
 * 条目名就是专辑名。这类条目按曲名检索必然无候选，按专辑名却能直接搜到；
 * 命中的专辑里的歌全部属于这部番，可以出题 —— 猜番模式下玩家猜的是番剧名，
 * 曲目名只用于结算展示，因此不必强求曲名与条目名一致。
 *
 * 仍然剔除专辑里的伴奏 / 纯音乐 / 现场 / 翻唱分轨（见 `isUnplayableAlbumTrack`），
 * 它们不是可出的原曲；剩下的顺序随机，避免每次都从专辑第一轨出题。
 */
export const resolveAlbumTrackCandidates = async (
  service: SonGuessrServiceInternals,
  provider: MusicProvider,
  track: BangumiMusicTrack,
  anime: BangumiSubjectDetails,
  cookie: MusicCookieInput | undefined,
  budget: { search: number }
): Promise<SongSearchResult[]> => {
  // 供应商不支持专辑能力时静默跳过（接口方法都是可选的）。
  if (!provider.searchAlbums || !provider.getAlbumSongs) return [];
  const animeNames = [anime.name, anime.nameCn].filter((name): name is string => Boolean(name));

  // 同一条目的多个检索词之间没有依赖，**必须并行回源**（与 searchAnimeTrackCandidates 一致）：
  // 串行发会把专辑路径变成 3~6 次顺序等待，自动出题的等待时间直接翻倍。
  const searches = await Promise.all(
    buildAlbumQueries(track, anime).map(async (query) => {
      if (budget.search <= 0) return [] as SongAlbumSearchResult[];
      budget.search -= 1;
      try {
        return await retryOnce(() => provider.searchAlbums!(query, ALBUM_SEARCH_LIMIT, cookie));
      } catch (error) {
        if (!isUnusableSongCandidate(error)) throw error;
        return [] as SongAlbumSearchResult[];
      }
    })
  );
  const collected: SongAlbumSearchResult[] = searches.flat();
  if (collected.length === 0) return [];

  const unique = new Map<string, SongAlbumSearchResult>();
  for (const album of collected) if (!unique.has(album.id)) unique.set(album.id, album);
  const trackArtists = track.artist ? normalizedArtists(track.artist) : new Set<string>();
  const artistHit = (album: SongAlbumSearchResult): boolean => {
    if (trackArtists.size === 0 || !album.artist) return false;
    const albumArtists = normalizedArtists(album.artist);
    return [...trackArtists].some((name) => albumArtists.has(name));
  };
  const album = [...unique.values()]
    .map((entry) => {
      const artistMatches = artistHit(entry);
      return {
        entry,
        artistMatches,
        score: albumNameScore(entry.name, track.title, animeNames, artistMatches),
      };
    })
    .filter((item) => {
      if (item.score <= 0) return false;
      if (item.artistMatches) return true;
      // 歌手对不上时只认两种归属证据：专辑名与条目名**全等**（搜到的就是同名那张盘），
      // 或专辑名自带番剧归属（含番剧名 + 发行上下文）。
      // 「专辑名 ⊂ 条目名」的**子串**命中在陌生歌手手里是同名顶替的高危形态 ——
      // 实测事故：条目《TVアニメ Summer Pockets "leave a mark"》（角色歌集，艺人
      // 是本作 CV）被 LUREKS 2026 年的无关同名专辑《Leave a Mark》以 60 分顶替，
      // 专辑曲目直接出题。与 resolveAnimeLevelCandidates 的 belongsToAnime 同口径。
      if (item.score >= ALBUM_NAME_EXACT_SCORE) return true;
      const normalizedEntry = normalizeSongTitle(item.entry.name);
      return animeNames.some((name) => {
        const normalizedName = normalizeSongTitle(name);
        return (
          normalizedName.length >= 4 &&
          normalizedEntry.includes(normalizedName) &&
          ANIME_RELEASE_CONTEXT_PATTERN.test(item.entry.name)
        );
      });
    })
    // 同名专辑常有别人的版本，艺术家与 Bangumi 记录对得上的优先（数据集补录 artist
    // 之后这条才真正可用）；其余按名称相似度，序号命中因此能压过隔壁那张。
    .sort(
      (left, right) =>
        Number(right.artistMatches) - Number(left.artistMatches) || right.score - left.score
    )
    .at(0)?.entry;
  if (!album || budget.search <= 0) return [];

  budget.search -= 1;
  let songs: SongSearchResult[];
  try {
    songs = await retryOnce(() => provider.getAlbumSongs!(album.id, cookie));
  } catch (error) {
    if (!isUnusableSongCandidate(error)) throw error;
    return [];
  }
  const playable = songs.filter((song) => !isUnplayableAlbumTrack(song.title));
  // 原版优先：同盘里的 Remix / TV Size 分轨只是「版本不同」（整盘都是版本分轨时
  // 兜底可出），但原版存在时不得随机抢先。
  const originals = playable.filter((song) => !ALTERNATE_VERSION_PATTERN.test(song.title));
  const alternates = playable.filter((song) => ALTERNATE_VERSION_PATTERN.test(song.title));
  return [...shuffle(originals, service.random), ...shuffle(alternates, service.random)];
};

/**
 * 番剧级兜底：条目级解析全部失败时，用番剧名检索单曲，只要歌确实属于这部番就出题。
 *
 * 为什么需要：Bangumi 的条目名可能既不是歌名、也与网易云的命名对不上
 * （《「クラスターエッジ」キャラクターコレクション》搜专辑一张都搜不到，但用番剧
 * **原名** `CLUSTER EDGE` 能搜出该番的《ココロのつぼみ》《FLY HIGH》）。
 *
 * 只保留两种能证明「属于本番」的候选：
 * - 专辑名含番剧名（任一形态）；
 * - 歌名与该番任一 Bangumi 曲目标题一致（跨条目互证）。
 *
 * 因此可能出到该番的**其它**曲目而非条目指名的那张专辑，这是有意的取舍：猜番模式下
 * 玩家猜的是番剧名，出一首确实属于该番的歌远好于整条出不了题。
 */
export const resolveAnimeLevelCandidates = async (
  service: SonGuessrServiceInternals,
  provider: MusicProvider,
  anime: BangumiSubjectDetails,
  cookie: MusicCookieInput | undefined,
  budget: { search: number }
): Promise<SongSearchResult[]> => {
  const animeNames = [anime.name, anime.nameCn].filter((name): name is string => Boolean(name));
  if (animeNames.length === 0) return [];
  // 同样并行回源（见 resolveAlbumTrackCandidates 的说明）：番剧名与中文名之间无依赖。
  const searches = await Promise.all(
    animeNames.map(async (name) => {
      if (budget.search <= 0) return [] as SongSearchResult[];
      budget.search -= 1;
      try {
        return await retryOnce(() => provider.search(name, ANIME_SONG_SEARCH_LIMIT, cookie));
      } catch (error) {
        if (!isUnusableSongCandidate(error)) throw error;
        return [] as SongSearchResult[];
      }
    })
  );
  const collected = new Map<string, SongSearchResult>();
  for (const found of searches) {
    for (const candidate of found)
      if (!collected.has(candidate.id)) collected.set(candidate.id, candidate);
  }
  const otherTrackTitles = anime.musicTracks.map((entry) => entry.title);
  const belongsToAnime = (candidate: SongSearchResult): boolean => {
    const album = candidate.album ?? "";
    // 专辑名含番剧名**还不够**：番剧名撞车的外文歌/同名歌，专辑名往往也叫同一个名字。
    // 必须再有一层发行上下文（动画 / 原声带 / 主题歌 / 角色歌 …）才算证据。
    if (
      animeNames.some((name) => album.includes(name)) &&
      ANIME_RELEASE_CONTEXT_PATTERN.test(album)
    ) {
      return true;
    }
    return otherTrackTitles.some((title) => isSongTitleMatch(candidate.title, title));
  };
  return shuffle([...collected.values()].filter(belongsToAnime), service.random);
};

export const resolveAnimeMatchedSongs = async (
  service: SonGuessrServiceInternals,
  anime: BangumiSubjectDetails,
  connection: ConnectionRecord
): Promise<BangumiSongCandidate[]> => {
  const provider = service.options.musicProvider;
  const { room } = service.requireRoomPlayer(connection);
  if (anime.musicTracks.length === 0) return [];
  // 与自动出题同源：番剧名既用于拼检索词，也用于「候选是否确属本番」的锚点判定。
  const animeNames = [anime.name, anime.nameCn].filter((name): name is string => Boolean(name));

  const budget = { search: ANIME_SONG_SEARCH_BUDGET, detail: ANIME_SONG_DETAIL_BUDGET };
  // 与自动出题同口径按成败归还租约，凭据失效才能在这里摘号。
  return withAggregatedAccounts(service, room, async (cookie) => {
    const ctx: AnimeTrackMatchContext = {
      provider,
      cookie,
      anime,
      animeNames,
      budget,
      results: [],
      seenSongIds: new Set<string>(),
    };
    for (const track of anime.musicTracks) {
      if (budget.search <= 0) break;
      await matchAnimeTrack(service, ctx, track);
    }
    await fillAnimeLevelFallback(service, ctx);
    return ctx.results;
  });
};

/** 单个音乐条目：常规检索 → 专辑兜底 → 按展示规则写入结果。 */
export const matchAnimeTrack = async (
  service: SonGuessrServiceInternals,
  ctx: AnimeTrackMatchContext,
  track: BangumiMusicTrack
): Promise<void> => {
  const { queries, scopeQueries } = buildTrackQueries(track, ctx.anime);

  let matchedCandidates: SongSearchResult[] = [];
  try {
    const matched = await searchAnimeTrackCandidates(
      service,
      ctx.provider,
      queries,
      track,
      ctx.cookie,
      ctx.budget,
      scopeQueries
    );
    matchedCandidates = rankEvidencedCandidates(matched, track, ctx.animeNames);
  } catch (error) {
    if (!isUnusableSongCandidate(error)) throw error;
  }

  /** 候选是否来自专辑兜底 —— 决定列表是只取最高分一首还是整张列出（见下方展示规则）。 */
  let albumFallback = false;
  if (matchedCandidates.length === 0 && isAlbumLikeTrackKind(track.kind)) {
    try {
      matchedCandidates = await resolveAlbumTrackCandidates(
        service,
        ctx.provider,
        track,
        ctx.anime,
        ctx.cookie,
        ctx.budget
      );
      albumFallback = true;
    } catch (error) {
      if (!isUnusableSongCandidate(error)) throw error;
    }
  }

  // 手动选曲列表的展示规则：常规检索的候选已按原版优先分降序排列，每个条目只保留
  // **最高分的那一个** —— 同一首歌在网易云常有原版 / 翻唱 / 现场 / 器乐等多个版本，
  // 全部列出会把列表刷成「好几首一样的 OP」并把翻唱混进来（用户实测反馈）。
  // 专辑兜底返回的是整张专辑的**不同曲目**（不是同一首歌的多版本），全部保留供挑选；
  // 被跨条目去重挡下的候选直接跳过，不顺延到同条目的次名版本，否则翻唱又会被带回来。
  registerMatchedSongs(
    service,
    ctx,
    track,
    albumFallback ? matchedCandidates : matchedCandidates.slice(0, 1)
  );
};

/** 把条目候选写进手动选曲列表；已在别的条目出现过的歌曲直接跳过。 */
export const registerMatchedSongs = (
  service: SonGuessrServiceInternals,
  ctx: AnimeTrackMatchContext,
  track: BangumiMusicTrack,
  candidates: SongSearchResult[]
): void => {
  for (const song of candidates) {
    if (ctx.seenSongIds.has(song.id)) continue;
    ctx.seenSongIds.add(song.id);
    // 类型同样按「歌曲自身文本」细化（与自动出题的 refineTrackKind 同源）。
    ctx.results.push({
      track: {
        ...track,
        kind: refineTrackKindByText(track.kind, `${song.title} ${song.album ?? ""}`),
      },
      song,
    });
  }
};

/** 番剧级兜底：条目全无命中且有剩余预算时，按整张番剧再搜一次。 */
export const fillAnimeLevelFallback = async (
  service: SonGuessrServiceInternals,
  ctx: AnimeTrackMatchContext
): Promise<void> => {
  if (ctx.results.length > 0 || ctx.budget.search <= 0) return;

  try {
    const animeLevelSongs = await resolveAnimeLevelCandidates(
      service,
      ctx.provider,
      ctx.anime,
      ctx.cookie,
      ctx.budget
    );
    for (const song of animeLevelSongs) {
      if (ctx.seenSongIds.has(song.id)) continue;
      ctx.seenSongIds.add(song.id);
      // 番剧级兜底没有「条目」可言，类型只能从歌曲自身文本推（原声带 / 特典 CD /
      // 角色歌…）；推不出来时才落到主题曲。
      ctx.results.push({
        track: {
          title: song.title,
          artist: song.artist,
          kind: refineTrackKindByText("theme", `${song.title} ${song.album ?? ""}`),
        },
        song,
      });
    }
  } catch (error) {
    if (!isUnusableSongCandidate(error)) throw error;
  }
};

export const refineTrackKind = (
  service: SonGuessrServiceInternals,
  kind: BangumiMusicTrackKind,
  song: SongDetails
): BangumiMusicTrackKind => {
  // 歌曲元数据里指向具体主题曲类型的信号（片头 / 片尾 / 插入歌）优先于 Bangumi 关联
  // 条目的粗分类，`theme` 这个桶再用发行形态细化（原声带 / 特典 CD / …）。
  // 判定统一在 shared 的 `refineTrackKindByText`，服务端与客户端徽章共用同一份规则。
  return refineTrackKindByText(
    kind,
    `${song.title} ${song.album ?? ""} ${song.encyclopedia.tags.join(" ")}`
  );
};
