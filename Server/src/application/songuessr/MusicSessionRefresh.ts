import { AppError } from "../../domain/Errors";
import type { MusicLoginSession } from "../../infrastructure/music/MusicProvider";
import {
  MUSIC_SESSION_REFRESH_INTERVAL_MS,
  MUSIC_SESSION_REFRESH_SWEEP_MS,
  MusicAuthPlatform,
  SonGuessrMusicPoolEntry,
  SonGuessrRoomRecord,
} from "./Records";
import type { SonGuessrContext } from "./Context";
import { publishMusicSession, requireMusicCookie } from "./MusicAuth";
import { isPoolEntryUsable, markEntryInvalidated, musicPool } from "./MusicPool";

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
