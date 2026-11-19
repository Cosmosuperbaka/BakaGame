import { AppError } from "../../domain/Errors";
import {
  refineTrackKindByText,
  type BangumiMusicTrack,
  type BangumiMusicTrackKind,
  type BangumiSongCandidate,
  type BangumiSubjectDetails,
  type ConnectionRecord,
  type SongDetails,
  type SongSearchResult,
} from "../../shared/Index";
import type { MusicCookieInput, MusicProvider } from "../../infrastructure/music/MusicProvider";
import { buildTrackQueries, rankEvidencedCandidates } from "./AnimeSongEvidence";
import { withAggregatedAccounts, withSongAccount } from "./MusicPool";
import {
  ANIME_SONG_DETAIL_BUDGET,
  ANIME_SONG_SEARCH_BUDGET,
  isUnusableSongCandidate,
  type SonGuessrRoomRecord,
} from "./Records";
import { isAlbumLikeTrackKind, isAlbumNameMatch, isSongTitleMatch } from "./SongTitleMatching";
import type { SonGuessrContext } from "./Context";
import { refineTrackKind } from "./AnimeAutoPick";
import {
  searchAnimeTrackCandidates,
  resolveAlbumTrackCandidates,
  resolveAnimeLevelCandidates,
} from "./AnimeCandidateSearch";
import { requireRoomPlayer } from "./RoomAccess";

/** 猜番手动选曲：指定曲目的解析，以及按番剧曲目逐条匹配出可选歌曲列表。 */

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
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  anime: BangumiSubjectDetails,
  songId: string
): Promise<{ song: SongDetails; track: BangumiMusicTrack }> => {
  const provider = ctx.options.musicProvider;
  let song: SongDetails;
  try {
    song = await withSongAccount(ctx, room, songId, (cookie) => provider.getSong(songId, cookie));
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
  const trackKind = refineTrackKind(matchedTrack.kind, song);
  return {
    song,
    track: { ...matchedTrack, kind: trackKind },
  };
};

export const resolveAnimeMatchedSongs = async (
  ctx: SonGuessrContext,
  anime: BangumiSubjectDetails,
  connection: ConnectionRecord
): Promise<BangumiSongCandidate[]> => {
  const provider = ctx.options.musicProvider;
  const { room } = requireRoomPlayer(ctx, connection);
  if (anime.musicTracks.length === 0) return [];
  // 与自动出题同源：番剧名既用于拼检索词，也用于「候选是否确属本番」的锚点判定。
  const animeNames = [anime.name, anime.nameCn].filter((name): name is string => Boolean(name));

  const budget = { search: ANIME_SONG_SEARCH_BUDGET, detail: ANIME_SONG_DETAIL_BUDGET };
  // 与自动出题同口径按成败归还租约，凭据失效才能在这里摘号。
  return withAggregatedAccounts(ctx, room, async (cookie) => {
    const match: AnimeTrackMatchContext = {
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
      await matchAnimeTrack(ctx, match, track);
    }
    await fillAnimeLevelFallback(ctx, match);
    return match.results;
  });
};

/** 单个音乐条目：常规检索 → 专辑兜底 → 按展示规则写入结果。 */
export const matchAnimeTrack = async (
  ctx: SonGuessrContext,
  match: AnimeTrackMatchContext,
  track: BangumiMusicTrack
): Promise<void> => {
  const { queries, scopeQueries } = buildTrackQueries(track, match.anime);

  let matchedCandidates: SongSearchResult[] = [];
  try {
    const matched = await searchAnimeTrackCandidates(
      match.provider,
      queries,
      track,
      match.cookie,
      match.budget,
      scopeQueries
    );
    matchedCandidates = rankEvidencedCandidates(matched, track, match.animeNames);
  } catch (error) {
    if (!isUnusableSongCandidate(error)) throw error;
  }

  /** 候选是否来自专辑兜底 —— 决定列表是只取最高分一首还是整张列出（见下方展示规则）。 */
  let albumFallback = false;
  if (matchedCandidates.length === 0 && isAlbumLikeTrackKind(track.kind)) {
    try {
      matchedCandidates = await resolveAlbumTrackCandidates(
        ctx,
        match.provider,
        track,
        match.anime,
        match.cookie,
        match.budget
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
    match,
    track,
    albumFallback ? matchedCandidates : matchedCandidates.slice(0, 1)
  );
};

/** 把条目候选写进手动选曲列表；已在别的条目出现过的歌曲直接跳过。 */
export const registerMatchedSongs = (
  match: AnimeTrackMatchContext,
  track: BangumiMusicTrack,
  candidates: SongSearchResult[]
): void => {
  for (const song of candidates) {
    if (match.seenSongIds.has(song.id)) continue;
    match.seenSongIds.add(song.id);
    // 类型同样按「歌曲自身文本」细化（与自动出题的 refineTrackKind 同源）。
    match.results.push({
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
  ctx: SonGuessrContext,
  match: AnimeTrackMatchContext
): Promise<void> => {
  if (match.results.length > 0 || match.budget.search <= 0) return;

  try {
    const animeLevelSongs = await resolveAnimeLevelCandidates(
      ctx,
      match.provider,
      match.anime,
      match.cookie,
      match.budget
    );
    for (const song of animeLevelSongs) {
      if (match.seenSongIds.has(song.id)) continue;
      match.seenSongIds.add(song.id);
      // 番剧级兜底没有「条目」可言，类型只能从歌曲自身文本推（原声带 / 特典 CD /
      // 角色歌…）；推不出来时才落到主题曲。
      match.results.push({
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
