import { publishMusicSession, requireMusicCookie } from "./MusicAuth";
import { AppError } from "../../domain/Errors";
import { type SongDetails } from "../../shared/Index";
import type { MusicCookieInput, MusicLoginSession } from "../../infrastructure/music/MusicProvider";
import {
  MUSIC_SESSION_REFRESH_INTERVAL_MS,
  MUSIC_SESSION_REFRESH_SWEEP_MS,
  MusicAuthPlatform,
  SonGuessrMusicPoolEntry,
  SonGuessrRoomRecord,
  SonGuessrRoundRecord,
} from "./Records";
import type { SonGuessrContext } from "./Context";
import {
  hasAvailablePoolAccount,
  isPoolEntryUsable,
  markEntryInvalidated,
  musicPool,
  withSongAccount,
} from "./MusicPool";

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

/** 后台续期节流：巡检每 10 秒一次，真正扫凭证的间隔由这里控制。 */
export const scheduleMusicSessionRefresh = (ctx: SonGuessrContext, currentTime: number): void => {
  if (ctx.musicRefreshSweepInFlight || currentTime < ctx.nextMusicRefreshSweepAt) return;
  ctx.nextMusicRefreshSweepAt = currentTime + MUSIC_SESSION_REFRESH_SWEEP_MS;
  ctx.musicRefreshSweepInFlight = true;
  void refreshDueMusicSessions(ctx).finally(() => {
    ctx.musicRefreshSweepInFlight = false;
  });
};

/**
 * 主动续期池内的 QQ 凭证。
 *
 * QQ 的 musickey 比网易云短命，且网页扫码的续期字段与移动端不同；只在开局复核时
 * 换一次不够。这里按 6 小时节奏在 key 过期前换新，失败不立即摘号（网络抖动很常见），
 * 只有平台明确判死才关闭开关并提示号主重登。
 */
export const refreshDueMusicSessions = async (ctx: SonGuessrContext): Promise<void> => {
  const provider = ctx.options.musicProvider;
  const getLoginStatus = provider.getLoginStatus?.bind(provider);
  if (!getLoginStatus) return;

  for (const room of [...ctx.rooms.values()]) {
    if (ctx.rooms.get(room.id) !== room) continue;
    for (const entry of [...musicPool(room)]) {
      if (!shouldRefreshMusicEntry(ctx, entry)) continue;
      await refreshMusicPoolEntry(ctx, room, entry, getLoginStatus);
    }
  }
};

export const shouldRefreshMusicEntry = (
  ctx: SonGuessrContext,
  entry: SonGuessrMusicPoolEntry
): boolean => {
  if (entry.platform !== "qq" || !isPoolEntryUsable(entry, ctx.now())) return false;
  const lastRefreshed = entry.cookieRefreshedAt ?? entry.addedAt;
  return (
    ctx.now() - lastRefreshed >=
    (ctx.options.musicSessionRefreshIntervalMs ?? MUSIC_SESSION_REFRESH_INTERVAL_MS)
  );
};

export const refreshMusicPoolEntry = async (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  entry: SonGuessrMusicPoolEntry,
  getLoginStatus: (
    cookie: string,
    platform?: MusicAuthPlatform,
    options?: { forceRefresh?: boolean }
  ) => Promise<MusicLoginSession>
): Promise<void> => {
  // 号主在续期等待期间重新登录会原地替换同一条目，「还在池里」恒真；必须同时核对
  // 凭据没换过，否则旧 Cookie 的续期结果（或失效判定）会盖掉刚登录的新凭据。
  const sentCookie = entry.cookie;
  const superseded = () => !musicPool(room).includes(entry) || entry.cookie !== sentCookie;
  try {
    const result = await getLoginStatus(sentCookie, "qq", { forceRefresh: true });
    if (superseded()) return;
    const cookieChanged = result.cookie !== entry.cookie;
    entry.cookie = requireMusicCookie(result.cookie);
    entry.account = result.account;
    entry.cookieRefreshedAt = ctx.now();
    entry.lastFailureReason = undefined;
    if (cookieChanged) publishMusicSession(ctx, room, entry);
  } catch (error) {
    if (superseded()) return;
    if (error instanceof AppError && error.code === "MUSIC_SESSION_INVALID") {
      markEntryInvalidated(ctx, entry, "QQ 音乐登录状态已失效，请重新扫码登录");
      ctx.publishRoom(room);
      return;
    }
    const hadReason = entry.lastFailureReason !== undefined;
    entry.lastFailureReason = error instanceof Error ? error.message : "QQ 音乐凭证续期失败";
    if (!hadReason) ctx.publishRoom(room);
  }
};
