import { AppError } from "../../domain/Errors";
import type { SongDetails } from "../../shared/Index";
import type { MusicCookieInput } from "../../infrastructure/music/MusicProvider";
import type { SonGuessrRoomRecord, SonGuessrRoundRecord } from "./Records";
import type { SonGuessrContext } from "./Context";
import { hasAvailablePoolAccount, withSongAccount } from "./MusicPool";

/** 出题与刷新播放地址时的取曲：候选音源按房内账号排序，每个候选各自租号。 */

/**
 * 候选音源排序：本房有可用账号的平台排在前面，其余保持原相对顺序。
 *
 * 只有 QQ 账号的房间，网易云一侧是匿名出口；匿名出口共用一条分钟级限流线，
 * 一旦被限流玩家会反复看到「操作频繁」。有 QQ 账号时先走 QQ 候选，匿名网易云只做兜底，
 * 而不是反过来先撞限流再回退。
 */
export const prioritizeCandidatesByRoomAccounts = (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  candidateIds: readonly string[]
): string[] => {
  const rank = (id: string) =>
    hasAvailablePoolAccount(ctx, room, id.startsWith("qq:") ? "qq" : "netease") ? 0 : 1;
  return candidateIds
    .map((id, index) => ({ id, index, rank: rank(id) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((item) => item.id);
};

/**
 * 按「主选 + 检索时给出的备用音源」取完整歌曲。
 *
 * 每个候选按自己的平台租号，只有 QQ 候选才可能要求会员号。已知候选全部失败后，
 * 才回落到聚合器原来的「按歌名+歌手跨平台搜索」兜底；客户端没带备用源时保持
 * 改造前的单次调用，不额外多打一次主源。
 */
export const loadSongWithSources = async (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  songId: string,
  sources?: readonly string[],
  requiresVip?: boolean
): Promise<{ song: SongDetails; alternateSongIds: string[] }> => {
  const candidates = prioritizeCandidatesByRoomAccounts(ctx, room, [songId, ...(sources ?? [])])
    .filter((id, index, list) => list.indexOf(id) === index)
    .slice(0, 6);
  const requireVipFor = (candidateId: string) =>
    requiresVip === true && candidateId.startsWith("qq:");

  if (candidates.length === 1) {
    const song = await withSongAccount(
      ctx,
      room,
      songId,
      (cookie) => ctx.options.musicProvider.getSong(songId, cookie),
      { requireVip: requireVipFor(songId) }
    );
    return { song, alternateSongIds: [] };
  }

  for (const candidateId of candidates) {
    try {
      const song = await withSongAccount(
        ctx,
        room,
        candidateId,
        (cookie) =>
          ctx.options.musicProvider.getSong(candidateId, cookie, { allowFailover: false }),
        { requireVip: requireVipFor(candidateId) }
      );
      return {
        song,
        alternateSongIds: candidates.filter((id) => id !== candidateId),
      };
    } catch {
      // 换下一个已知候选；单平台失效或限流不该直接判整首不可用。
    }
  }

  // 已知候选都放不出来时，保留原有的跨平台按歌名兜底。
  const song = await withSongAccount(
    ctx,
    room,
    songId,
    (cookie) => ctx.options.musicProvider.getSong(songId, cookie),
    { requireVip: requireVipFor(songId) }
  );
  return { song, alternateSongIds: candidates.filter((id) => id !== songId) };
};

/** 刷新本回合播放地址：当前源失败时按已知备用源逐个再试，全部失败才抛最后一个错误。 */
export const refreshRoundAudio = async (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  round: SonGuessrRoundRecord,
  refresh: (songId: string, cookie?: MusicCookieInput) => Promise<string>
): Promise<string> => {
  const candidateIds = prioritizeCandidatesByRoomAccounts(ctx, room, [
    round.song.id,
    ...(round.alternateSongIds ?? []),
  ]).filter((id, index, list) => list.indexOf(id) === index);
  let lastError: unknown;
  for (const candidateId of candidateIds) {
    try {
      return await withSongAccount(
        ctx,
        room,
        candidateId,
        (cookie) => refresh(candidateId, cookie),
        {
          requireVip:
            candidateId === round.song.id &&
            candidateId.startsWith("qq:") &&
            round.song.requiresVip === true,
        }
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new AppError("SONG_UNAVAILABLE", "无法刷新播放地址");
};
