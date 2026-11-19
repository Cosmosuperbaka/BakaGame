import { AppError } from "../../domain/Errors";
import { shuffle } from "../../domain/Rules";
import {
  ALL_BANGUMI_TRACK_KINDS,
  refineTrackKindByText,
  type BangumiMusicTrack,
  type BangumiMusicTrackKind,
  type BangumiSubjectDetails,
  type SongDetails,
  type SongSearchResult,
} from "../../shared/Index";
import {
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
import { withAggregatedAccounts } from "./MusicPool";
import {
  ANIME_SONG_DETAIL_BUDGET,
  ANIME_SONG_SEARCH_BUDGET,
  ANIME_TRACK_DETAIL_ATTEMPTS,
  ANIME_TRACK_LOOKUP_LIMIT,
  DEFAULT_SETTINGS,
  isUnusableSongCandidate,
  type SonGuessrRoomRecord,
} from "./Records";
import { isAlbumLikeTrackKind } from "./SongTitleMatching";
import type { SonGuessrContext } from "./Context";
import {
  searchAnimeTrackCandidates,
  resolveAlbumTrackCandidates,
  resolveAnimeLevelCandidates,
} from "./AnimeCandidateSearch";

/** 猜番自动选曲：洗牌后逐曲目检索、验证可播并产出题目，兜底槽与预算由同一个 lookup 对象贯穿。 */

export const resolveAnimeSong = async (
  ctx: SonGuessrContext,
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
    ctx.random
  ).slice(0, ANIME_TRACK_LOOKUP_LIMIT);
  // 整段解析（多个候选、每个都可能多次回源）共用一次取号：这确实是同一批在途请求，
  // 一次一租比每个内部请求各自取号更省，也让池里的在途数反映真实的占用者。
  // 按成败归还：内部只吞单曲不可用，凭据判死、风控与限流原样透传到这里摘号或冷却。
  return withAggregatedAccounts(ctx, room, (cookie) =>
    pickAnimeSong(ctx, candidates, {
      provider: ctx.options.musicProvider,
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
  ctx: SonGuessrContext,
  candidates: BangumiMusicTrack[],
  lookup: AnimeSongLookup
): Promise<AnimeSongPick> => {
  for (const track of candidates) {
    if (lookup.budget.search <= 0 || lookup.budget.detail <= 0) break;
    const pick = await resolveTrackSong(ctx, lookup, track);
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
  ctx: SonGuessrContext,
  lookup: AnimeSongLookup,
  track: BangumiMusicTrack
): Promise<AnimeSongPick | undefined> => {
  const { provider, cookie, budget, animeNames } = lookup;
  const { queries, scopeQueries } = buildTrackQueries(track, lookup.anime);
  // 同一曲目的多个检索词之间没有依赖，并行回源把最坏等待压到一次上游往返。
  // 带番剧名的检索词单独标出来：命中它们的候选是「确实属于本番」的强证据。
  const matched = await searchAnimeTrackCandidates(
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
  const pool = await resolveTrackPool(ctx, lookup, track, ranked);
  // 三条路都没拿到可出的歌时换下一首关联曲目，绝不硬塞弱候选。
  if (pool.list.length === 0) return undefined;
  return verifyTrackPool(ctx, lookup, pool);
};

/**
 * 条目的候选池三级来源：常规检索 → 专辑型条目 → 番剧级兜底。
 * 只有「常规检索」这一条路允许放宽身份与年代（见 `looseFallback`）。
 */
export const resolveTrackPool = async (
  ctx: SonGuessrContext,
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
      ctx,
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
  const animePool = await resolveAnimeLevelCandidates(ctx, provider, anime, cookie, budget);
  return { track, list: animePool, fromAnimeLevel: true, looseFallback: false };
};

/**
 * 逐首验证候选池：热度预筛 → 取详情 → 否决非人声 → 按让位形态记兜底槽。
 * 台词轨、翻唱与年份错配都只是「让位」，一律返还验证名额，
 * 否则成批排在前面的劣质候选会把 `ANIME_TRACK_DETAIL_ATTEMPTS` 吃光，
 * 排在后面的原版连被验证的机会都没有。
 */
export const verifyTrackPool = async (
  ctx: SonGuessrContext,
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
    if (await isCandidateTooCold(ctx, lookup, candidate.id)) continue;
    const song = await loadPlayableSong(ctx, lookup, candidate.id);
    if (!song) continue;
    if (isBelowMinPopularity(song, lookup.minPopularity)) continue;
    // 台词轨 / 伴奏 / 纯音乐一律否决，且**不占验证名额**：特典 CD 里它们常成批
    // 排在前面，若让它们吃掉 ANIME_TRACK_DETAIL_ATTEMPTS，真正的歌连被验证的机会都没有。
    // 宁可这部番出不了题，也不能放一段对白让玩家猜。
    if (isNonVocalTrack(song.title)) {
      attempts -= 1;
      continue;
    }
    const pick = buildTrackPick(pool.track, song, pool.fromAnimeLevel);
    const kind = fallbackKindOfSong(song, lookup.anime, lookup.recentSongIds);
    if (!kind) return pick;
    recordFallbackPick(lookup, pool, { index, candidate, kind, pick });
    if (kind !== "recent") attempts -= 1;
  }
  return undefined;
};

/** 红心数预筛：热度明确不达标的候选不值得拉详情；查询本身失败按「不知道」放行。 */
export const isCandidateTooCold = async (
  ctx: SonGuessrContext,
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
  ctx: SonGuessrContext,
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
  track: BangumiMusicTrack,
  song: SongDetails,
  fromAnimeLevel: boolean
): AnimeSongPick => {
  return {
    song,
    track: {
      ...track,
      kind: refineTrackKind(fromAnimeLevel ? "theme" : track.kind, song),
    },
  };
};

/** 把让位候选记进对应兜底槽；翻唱还要把它自带的原曲插回队首。 */
export const recordFallbackPick = (
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

export const refineTrackKind = (
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
