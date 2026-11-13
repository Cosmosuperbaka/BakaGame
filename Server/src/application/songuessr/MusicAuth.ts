import { AppError } from "../../domain/Errors";
import { MAX_SONGUESSR_COOKIE_LENGTH, type ConnectionRecord } from "../../shared/Index";
import type { MusicLoginSession } from "../../infrastructure/music/MusicProvider";
import { createEvent } from "../../transport/Packets";
import {
  MUSIC_COOKIE_FRESH_MS,
  MusicAuthPlatform,
  MusicSessionRevalidation,
  SonGuessrMusicPoolEntry,
  SonGuessrPlayerRecord,
  SonGuessrRoomRecord,
  musicAuthOperationKey,
  roomRuntime,
} from "./Records";
import type { SonGuessrContext } from "./Context";
import { isCoolingDown, markEntryInvalidated, musicPool, wakeMusicPoolWaiters } from "./MusicPool";
import type { SongCommandAt } from "./RoomAccess";

/** 猜歌音乐账号的登录、凭据装载与共享开关：写池条目的入口，取号与租约在 MusicPool。 */

/**
 * 三条登录命令共用的按连接额度，排在本地校验与能力检查之后、任何上游调用之前：
 * 登录上游要求不高频重复调用，循环发登录命令会把号打进风控。
 */
const requireAuthQuota = (ctx: SonGuessrContext, connection: ConnectionRecord): void => {
  if (!ctx.musicAuthLimiter.allow(connection.id, ctx.now())) {
    throw new AppError("RATE_LIMITED", "登录请求过于频繁，请稍后再试");
  }
};

export const createMusicQrLogin = async (
  ctx: SonGuessrContext,
  at: SongCommandAt,
  platform: "netease" | "qq" = "netease",
  type?: "qq" | "wx" | "mobile"
) => {
  const provider = ctx.options.musicProvider;
  const createQrLogin = provider.createQrLogin?.bind(provider);
  if (!createQrLogin) throw new AppError("MUSIC_AUTH_UNAVAILABLE", "音乐登录功能不可用");
  requireAuthQuota(ctx, at.connection);
  return createQrLogin(platform, type);
};

export const checkMusicQrLogin = async (
  ctx: SonGuessrContext,
  at: SongCommandAt,
  keyValue: string,
  platform: "netease" | "qq" = "netease",
  type?: "qq" | "wx" | "mobile"
) => {
  const { connection, room, seat: player } = at;
  const key = keyValue.trim();
  if (!key || key.length > 512) throw new AppError("INVALID_LOGIN", "二维码登录密钥无效");
  const provider = ctx.options.musicProvider;
  const checkQrLogin = provider.checkQrLogin?.bind(provider);
  if (!checkQrLogin) throw new AppError("MUSIC_AUTH_UNAVAILABLE", "音乐登录功能不可用");
  requireAuthQuota(ctx, connection);
  const verify = beginMusicAuthentication(ctx, room, player, connection, platform);
  const result = await checkQrLogin(key, platform, type);
  verify();
  if (result.status !== "authorized" || !result.session) {
    return { status: result.status, message: result.message };
  }
  const session = installMusicSession(ctx, room, player.id, result.session);
  ctx.touch(room);
  ctx.publishRoom(room);
  return {
    status: result.status,
    message: result.message,
    cookie: session.cookie,
    account: session.account,
  };
};

export const useMusicCookie = async (
  ctx: SonGuessrContext,
  at: SongCommandAt,
  cookieValue: string,
  platform: "netease" | "qq" = "netease"
) => {
  const { connection, room, seat: player } = at;
  const cookie = requireMusicCookie(cookieValue);
  const provider = ctx.options.musicProvider;
  const getLoginStatus = provider.getLoginStatus?.bind(provider);
  if (!getLoginStatus) throw new AppError("MUSIC_AUTH_UNAVAILABLE", "音乐登录功能不可用");
  requireAuthQuota(ctx, connection);
  const verify = beginMusicAuthentication(ctx, room, player, connection, platform);
  let result: Awaited<ReturnType<typeof getLoginStatus>>;
  try {
    result = await getLoginStatus(cookie, platform);
  } catch (error) {
    // 凭据过期、上游限流与上游故障在日志里都只是一条 400；留下错误码才分得清
    // 是玩家本机凭据失效（预期）还是上游出了问题。凭据内容不进日志。
    ctx.log("song.auth.cookieRejected", room.id, player.id, {
      platform,
      code: error instanceof AppError ? error.code : "UNKNOWN",
    });
    throw error;
  }
  verify();
  // 本机凭据只是副本；服务端同账号若已续期出更新的 Cookie，优先保留服务端那份。
  const session = installMusicSession(ctx, room, player.id, result, {
    preferExistingCookie: true,
  });
  ctx.touch(room);
  ctx.publishRoom(room);
  return { account: session.account, cookie: session.cookie };
};

export const clearMusicAccount = (
  ctx: SonGuessrContext,
  at: SongCommandAt,
  platform: "netease" | "qq" | "all" = "all"
) => {
  const { room, seat: player } = at;
  clearMusicSession(ctx, room, player.id, platform);
  ctx.touch(room);
  ctx.publishRoom(room);
  return { cleared: true };
};

export const beginMusicAuthentication = (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  player: SonGuessrPlayerRecord,
  connection: ConnectionRecord,
  platform: "netease" | "qq" = "netease"
) => {
  const operation = Symbol(`musicAuthentication_${platform}`);
  const key = musicAuthOperationKey(player.id, platform);
  (roomRuntime(room).musicAuthOperations ??= {})[key] = operation;
  return () => {
    if (
      ctx.rooms.get(room.id) !== room ||
      room.runtime?.musicAuthOperations?.[key] !== operation ||
      room.players[player.id] !== player ||
      !player.online ||
      connection.roomId !== room.id ||
      connection.playerId !== player.id
    ) {
      throw new AppError("MUSIC_SESSION_INVALID", "音乐登录操作已失效，请重新登录");
    }
  };
};

/**
 * 收下一个玩家贡献的账号：同一个玩家同一平台只保留一号，重登即覆盖并解除冷却。
 *
 * 任何在房玩家都能贡献自己的号（不再限于房主）：池是「谁的号谁做主」，
 * 开关、离房、掉线都按贡献者结算。
 */
export const installMusicSession = (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  ownerPlayerId: string,
  session: MusicLoginSession,
  options: { preferExistingCookie?: boolean } = {}
): MusicLoginSession => {
  const incomingCookie = requireMusicCookie(session.cookie);
  const isQq = session.account.platform === "qq";
  const account = {
    platform: session.account.platform || "netease",
    userId: session.account.userId?.slice(0, 64),
    nickname: session.account.nickname.slice(0, 80) || (isQq ? "QQ音乐用户" : "网易云用户"),
    avatarUrl: session.account.avatarUrl?.slice(0, 2_048),
    vipStatus: session.account.vipStatus,
    vipType: session.account.vipType,
    vipExpireTime: session.account.vipExpireTime,
    vipTier: session.account.vipTier,
    vipLevel: session.account.vipLevel,
    vipYear: session.account.vipYear,
  };
  const platform: MusicAuthPlatform = isQq ? "qq" : "netease";
  // 局中登录进来的号默认不入池（`enabled: false`）：开关「只在等待阶段可改、开局锁死」是 B4 的
  // 硬约束，默认打开等于绕开它。回到准备页后由号主自己打开，池子因此在局中只会变小不会变大。
  // 开局加载期间阶段仍是 waiting，但开关已经锁死：同样不入池。
  const active =
    room.phase === "waiting" &&
    !room.runtime?.automaticRoundLoading &&
    !room.runtime?.manualRoundStarting;
  const pool = musicPool(room);
  const existing = pool.find(
    (entry) => entry.playerId === ownerPlayerId && entry.platform === platform
  );
  // 客户端回到准备页会自动重传本机凭据。服务端可能已经在后台续期出一份更新的
  // Cookie；同一账号时优先保留这份，并把结果回给客户端，避免用旧副本覆盖新凭据。
  const preferExisting =
    options.preferExistingCookie === true &&
    existing !== undefined &&
    existing.account.userId &&
    account.userId &&
    existing.account.userId === account.userId &&
    existing.cookieRefreshedAt !== undefined &&
    existing.lastFailureReason === undefined &&
    !isCoolingDown(existing, ctx.now()) &&
    ctx.now() - existing.cookieRefreshedAt <= MUSIC_COOKIE_FRESH_MS;
  const cookie = preferExisting ? existing.cookie : incomingCookie;
  if (existing) {
    // 同一份凭据重新装载不改开关：客户端回到准备页会自动重传本机凭据，若一律按阶段置位，
    // 玩家自己关掉的共享就会被这次重传悄悄打开（开关状态应当只由号主改、由服务端记）。
    // 续期只换了 Cookie 字符串、账号没变，仍算同一份凭据；换账号才算重新登录。
    const sameCredential =
      existing.account.userId && account.userId
        ? existing.account.userId === account.userId
        : existing.cookie === cookie;
    const cookieChanged = existing.cookie !== cookie;
    existing.cookie = cookie;
    existing.account = account;
    // 被平台判死时开关是服务端代关的，不是号主的选择：同账号重登也要按新凭据恢复。
    existing.enabled = sameCredential && !existing.invalidated ? existing.enabled : active;
    existing.invalidated = undefined;
    existing.cooldownUntil = undefined;
    existing.rateLimitStrikes = undefined;
    existing.lastFailureReason = undefined;
    existing.recentOk = 0;
    existing.recentTotal = 0;
    if (cookieChanged) existing.cookieRefreshedAt = ctx.now();
  } else {
    pool.push({
      playerId: ownerPlayerId,
      platform,
      cookie,
      account,
      enabled: active,
      addedAt: ctx.now(),
      inFlight: 0,
      recentOk: 0,
      recentTotal: 0,
      cookieRefreshedAt: ctx.now(),
    });
  }
  // 新号或重登可能刚好满足正在排队的请求。
  wakeMusicPoolWaiters(ctx, room.id);
  return { cookie, account };
};

export const requireMusicCookie = (value: string): string => {
  const cookie = value.trim();
  if (!cookie || cookie.length > MAX_SONGUESSR_COOKIE_LENGTH) {
    throw new AppError("MUSIC_SESSION_INVALID", "音乐登录状态无效");
  }
  return cookie;
};

/**
 * 摘掉某个玩家贡献的号。
 *
 * 只动退出的人自己的号：房间里的号分属不同玩家，房主退房不该顺手清掉别人的。
 */
export const clearMusicSession = (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  ownerPlayerId?: string,
  platform: "netease" | "qq" | "all" = "all"
): boolean => {
  const pool = musicPool(room);
  const before = pool.length;
  // 在途登录锁按「人 + 平台」清：清掉自己的号时顺手作废自己那一次在途登录，
  // 不动别人正在跑的那次（否则 A 退出登录会把 B 的扫码结果一起作废）。
  const platforms: MusicAuthPlatform[] = platform === "all" ? ["netease", "qq"] : [platform];
  if (ownerPlayerId !== undefined && room.runtime?.musicAuthOperations) {
    for (const key of platforms) {
      delete room.runtime?.musicAuthOperations[musicAuthOperationKey(ownerPlayerId, key)];
    }
  }
  room.musicPool = pool.filter(
    (entry) =>
      (platform !== "all" && entry.platform !== platform) ||
      (ownerPlayerId !== undefined && entry.playerId !== ownerPlayerId)
  );
  const cleared = room.musicPool.length !== before;
  // 有号被摘掉时也要叫醒等号者：它们可能因此直接判定「本平台无凭据」而降级。
  if (cleared) wakeMusicPoolWaiters(ctx, room.id);
  return cleared;
};

/**
 * 贡献者改自己的共享开关。只在等待阶段可改，开局即锁死：出题链路已经在按池取号，
 * 中途抽走一个正在被用的号会让回合直接断在半路。
 */
export const setPoolSharing = (
  ctx: SonGuessrContext,
  at: SongCommandAt,
  platform: MusicAuthPlatform,
  enabled: boolean
) => {
  const { room, seat: player } = at;
  // 自动开局加载期间阶段仍停在 waiting，但出题链路已经在按池取号，同样算已开局。
  if (room.phase !== "waiting" || room.runtime?.automaticRoundLoading) {
    throw new AppError("INVALID_PHASE", "开局后不能再改账号共享开关");
  }
  const entry = musicPool(room).find(
    (candidate) => candidate.playerId === player.id && candidate.platform === platform
  );
  if (!entry) throw new AppError("MUSIC_SESSION_INVALID", "请先登录该平台账号");
  if (entry.enabled !== enabled) {
    entry.enabled = enabled;
    // 打开开关可能让排队的请求立刻有号可用；关闭则让它们重新判断是否还有别的号。
    wakeMusicPoolWaiters(ctx, room.id);
    ctx.touch(room);
    ctx.publishRoom(room);
    ctx.log("song.auth.poolSharing", room.id, player.id, { platform, enabled });
  }
  return { enabled: entry.enabled };
};

/** 开局前逐端复核音乐会话；登录态已变更就清掉该端会话并广播，其余失败按上游接口错误上报。 */
export const refreshMusicSessionAccount = async (
  ctx: SonGuessrContext,
  check: MusicSessionRevalidation
): Promise<void> => {
  const { room, platform, entry, operation, label, verifySession, getLoginStatus } = check;
  // 复核期间号主重登会原地换掉凭据：新凭据是刚登录拿到的，旧凭据的复核结果一律作废。
  const sentCookie = entry.cookie;
  try {
    // QQ 的 key 寿命短：开局复核顺便强制换新，避免「还能用就不续期、过期后才救」。
    const result = await getLoginStatus(sentCookie, platform, {
      forceRefresh: platform === "qq",
    });
    verifySession(platform);
    if (entry.cookie !== sentCookie) return;
    const cookieChanged = result.cookie !== entry.cookie;
    entry.account = result.account;
    if (cookieChanged) {
      entry.cookie = requireMusicCookie(result.cookie);
      // 服务端替号主续期后，把新 Cookie 只发给号主自己的连接，客户端同步本机副本。
      publishMusicSession(ctx, room, entry);
    }
    entry.cookieRefreshedAt = ctx.now();
  } catch (error) {
    if (error instanceof AppError) {
      const key = musicAuthOperationKey(entry.playerId, platform);
      if (
        error.code === "MUSIC_SESSION_INVALID" &&
        musicPool(room).includes(entry) &&
        entry.cookie === sentCookie &&
        room.runtime?.musicAuthOperations?.[key] === operation
      ) {
        // 凭据已被平台判死：关掉这一号并标记失效，条目留在面板里提示号主重登
        // （其余号与其它玩家的号都不动），房间因此可能整体降级到「无号」，由开局门槛承接。
        markEntryInvalidated(ctx, entry, `${label}登录状态已失效，请重新扫码登录`);
        wakeMusicPoolWaiters(ctx, room.id);
        ctx.publishRoom(room);
      }
      throw error;
    }
    throw new AppError("MUSIC_API_FAILED", `${label}登录状态校验失败，请稍后重试`);
  }
};

/**
 * 把续期后的凭据只发给号主自己的连接。
 *
 * 客户端会在本机保存一份凭据；服务端后台续期后如果不同步，下一次进房会拿旧副本
 * 覆盖新 Cookie，时间一长就只能重新扫码。这里只发 `entry.playerId` 的连接，
 * 不广播、不落快照、不写日志。
 *
 * 座位被 Agent 接管时同样只发人类页面：这份凭据只为本机存档，Agent 用不上，
 * 而第三方账号凭据与人类会话凭证同属「不交给 Agent」的人类凭据。
 */
export const publishMusicSession = (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  entry: SonGuessrMusicPoolEntry
) => {
  for (const connection of ctx.connections.getRoomConnections(room.id)) {
    if (connection.playerId !== entry.playerId || connection.isAgent === true) continue;
    connection.send(
      createEvent("song.auth.session", {
        platform: entry.platform,
        cookie: entry.cookie,
        account: entry.account,
      })
    );
  }
};
