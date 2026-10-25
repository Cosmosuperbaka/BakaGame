import { AppError } from "../../domain/Errors";
import {
  MAX_SONGUESSR_COOKIE_LENGTH,
  type ConnectionRecord,
  type SongDetails,
} from "../../shared/Index";
import type {
  MusicCookieInput,
  MusicLoginSession,
  MusicPlatform,
  MusicSearchOptions,
} from "../../infrastructure/NeteaseMusicProvider";
import type { SongPlayabilityContext } from "../../infrastructure/MusicDeduplicator";
import { createEvent } from "../../transport/Packets";
import {
  MUSIC_COOKIE_FRESH_MS,
  MUSIC_POOL_COOLDOWN_MS,
  MUSIC_POOL_MAX_IN_FLIGHT,
  MUSIC_POOL_QUEUE_TIMEOUT_MS,
  MUSIC_POOL_STATS_WINDOW,
  MUSIC_SESSION_REFRESH_INTERVAL_MS,
  MUSIC_SESSION_REFRESH_SWEEP_MS,
  MusicAccountLease,
  MusicAuthPlatform,
  MusicSessionRevalidation,
  SonGuessrMusicPoolEntry,
  SonGuessrPlayerRecord,
  SonGuessrRoomRecord,
  SonGuessrRoundRecord,
  musicAuthOperationKey,
} from "./Records";
import type { SonGuessrServiceInternals } from "./ServiceInternals";

/** 猜歌音乐账号池、凭证装载与上游租约：状态仍由 SonGuessrService 持有，这里只放共享行为。 */
export const createMusicQrLogin = async (
  service: SonGuessrServiceInternals,
  connection: ConnectionRecord,
  platform: "netease" | "qq" = "netease",
  type?: "qq" | "wx" | "mobile"
) => {
  service.requireRoomPlayer(connection);
  const provider = service.options.musicProvider;
  const createQrLogin = provider.createQrLogin?.bind(provider);
  if (!createQrLogin) throw new AppError("MUSIC_AUTH_UNAVAILABLE", "音乐登录功能不可用");
  return createQrLogin(platform, type);
};

export const checkMusicQrLogin = async (
  service: SonGuessrServiceInternals,
  connection: ConnectionRecord,
  keyValue: string,
  platform: "netease" | "qq" = "netease",
  type?: "qq" | "wx" | "mobile"
) => {
  const { room, player } = service.requireRoomPlayer(connection);
  const key = keyValue.trim();
  if (!key || key.length > 512) throw new AppError("INVALID_LOGIN", "二维码登录密钥无效");
  const provider = service.options.musicProvider;
  const checkQrLogin = provider.checkQrLogin?.bind(provider);
  if (!checkQrLogin) throw new AppError("MUSIC_AUTH_UNAVAILABLE", "音乐登录功能不可用");
  const verify = beginMusicAuthentication(service, room, player, connection, platform);
  const result = await checkQrLogin(key, platform, type);
  verify();
  if (result.status !== "authorized" || !result.session) {
    return { status: result.status, message: result.message };
  }
  const session = installMusicSession(service, room, player.id, result.session);
  service.touch(room);
  service.publishRoom(room);
  return {
    status: result.status,
    message: result.message,
    cookie: session.cookie,
    account: session.account,
  };
};

export const useMusicCookie = async (
  service: SonGuessrServiceInternals,
  connection: ConnectionRecord,
  cookieValue: string,
  platform: "netease" | "qq" = "netease"
) => {
  const { room, player } = service.requireRoomPlayer(connection);
  const cookie = requireMusicCookie(service, cookieValue);
  const provider = service.options.musicProvider;
  const getLoginStatus = provider.getLoginStatus?.bind(provider);
  if (!getLoginStatus) throw new AppError("MUSIC_AUTH_UNAVAILABLE", "音乐登录功能不可用");
  const verify = beginMusicAuthentication(service, room, player, connection, platform);
  const result = await getLoginStatus(cookie, platform);
  verify();
  // 本机凭据只是副本；服务端同账号若已续期出更新的 Cookie，优先保留服务端那份。
  const session = installMusicSession(service, room, player.id, result, {
    preferExistingCookie: true,
  });
  service.touch(room);
  service.publishRoom(room);
  return { account: session.account, cookie: session.cookie };
};

export const clearMusicAccount = (
  service: SonGuessrServiceInternals,
  connection: ConnectionRecord,
  platform: "netease" | "qq" | "all" = "all"
) => {
  const { room, player } = service.requireRoomPlayer(connection);
  clearMusicSession(service, room, player.id, platform);
  service.touch(room);
  service.publishRoom(room);
  return { cleared: true };
};

export const beginMusicAuthentication = (
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord,
  player: SonGuessrPlayerRecord,
  connection: ConnectionRecord,
  platform: "netease" | "qq" = "netease"
) => {
  const operation = Symbol(`musicAuthentication_${platform}`);
  if (!room.musicAuthOperations) {
    room.musicAuthOperations = {};
  }
  const key = musicAuthOperationKey(player.id, platform);
  room.musicAuthOperations[key] = operation;
  return () => {
    if (
      service.rooms.get(room.id) !== room ||
      room.musicAuthOperations?.[key] !== operation ||
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
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord,
  ownerPlayerId: string,
  session: MusicLoginSession,
  options: { preferExistingCookie?: boolean } = {}
): MusicLoginSession => {
  const incomingCookie = requireMusicCookie(service, session.cookie);
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
  const active = room.phase === "waiting";
  const pool = musicPool(service, room);
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
    !isCoolingDown(service, existing, service.now()) &&
    service.now() - existing.cookieRefreshedAt <= MUSIC_COOKIE_FRESH_MS;
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
    existing.enabled = sameCredential ? existing.enabled : active;
    existing.cooldownUntil = undefined;
    existing.lastFailureReason = undefined;
    existing.recentOk = 0;
    existing.recentTotal = 0;
    if (cookieChanged) existing.cookieRefreshedAt = service.now();
  } else {
    pool.push({
      playerId: ownerPlayerId,
      platform,
      cookie,
      account,
      enabled: active,
      addedAt: service.now(),
      inFlight: 0,
      recentOk: 0,
      recentTotal: 0,
      cookieRefreshedAt: service.now(),
    });
  }
  // 新号或重登可能刚好满足正在排队的请求。
  wakeMusicPoolWaiters(service, room.id);
  return { cookie, account };
};

export const requireMusicCookie = (service: SonGuessrServiceInternals, value: string): string => {
  const cookie = value.trim();
  if (!cookie || cookie.length > MAX_SONGUESSR_COOKIE_LENGTH) {
    throw new AppError("MUSIC_SESSION_INVALID", "音乐登录状态无效");
  }
  return cookie;
};

/** 池内所有条目；房间记录里没有池时按空池建一个，调用方不必各自判空。 */
export const musicPool = (
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord
): SonGuessrMusicPoolEntry[] => {
  room.musicPool ??= [];
  return room.musicPool;
};

/**
 * 摘掉某个玩家贡献的号。
 *
 * 只动退出的人自己的号：房间里的号分属不同玩家，房主退房不该顺手清掉别人的。
 */
export const clearMusicSession = (
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord,
  ownerPlayerId?: string,
  platform: "netease" | "qq" | "all" = "all"
): boolean => {
  const pool = musicPool(service, room);
  const before = pool.length;
  // 在途登录锁按「人 + 平台」清：清掉自己的号时顺手作废自己那一次在途登录，
  // 不动别人正在跑的那次（否则 A 退出登录会把 B 的扫码结果一起作废）。
  const platforms: MusicAuthPlatform[] = platform === "all" ? ["netease", "qq"] : [platform];
  if (ownerPlayerId !== undefined && room.musicAuthOperations) {
    for (const key of platforms) {
      delete room.musicAuthOperations[musicAuthOperationKey(ownerPlayerId, key)];
    }
  }
  room.musicPool = pool.filter(
    (entry) =>
      (platform !== "all" && entry.platform !== platform) ||
      (ownerPlayerId !== undefined && entry.playerId !== ownerPlayerId)
  );
  const cleared = room.musicPool.length !== before;
  // 有号被摘掉时也要叫醒等号者：它们可能因此直接判定「本平台无凭据」而降级。
  if (cleared) wakeMusicPoolWaiters(service, room.id);
  return cleared;
};

/**
 * 贡献者改自己的共享开关。只在等待阶段可改，开局即锁死：出题链路已经在按池取号，
 * 中途抽走一个正在被用的号会让回合直接断在半路。
 */
export const setPoolSharing = (
  service: SonGuessrServiceInternals,
  connection: ConnectionRecord,
  platform: MusicAuthPlatform,
  enabled: boolean
) => {
  const { room, player } = service.requireRoomPlayer(connection);
  if (room.phase !== "waiting") {
    throw new AppError("INVALID_PHASE", "开局后不能再改账号共享开关");
  }
  const entry = musicPool(service, room).find(
    (candidate) => candidate.playerId === player.id && candidate.platform === platform
  );
  if (!entry) throw new AppError("MUSIC_SESSION_INVALID", "请先登录该平台账号");
  if (entry.enabled !== enabled) {
    entry.enabled = enabled;
    // 打开开关可能让排队的请求立刻有号可用；关闭则让它们重新判断是否还有别的号。
    wakeMusicPoolWaiters(service, room.id);
    service.touch(room);
    service.publishRoom(room);
    service.log("song.auth.poolSharing", room.id, player.id, { platform, enabled });
  }
  return { enabled: entry.enabled };
};

/**
 * 该号当下能不能用：开关开着、不在冷却里。
 *
 * 不看贡献者在线与否：掉线有宽限期，宽限内人还在房里，号照用；超期由
 * `cleanupOfflinePlayers` 连号一起清掉。也不看在途数：快照展示、开局复核与
 * VIP 标注只需要知道「这号是否可用」，取号时才卡并发。
 */
export const isPoolEntryUsable = (
  service: SonGuessrServiceInternals,
  entry: SonGuessrMusicPoolEntry,
  now: number
): boolean => {
  if (!entry.enabled) return false;
  if (isCoolingDown(service, entry, now)) return false;
  return true;
};

/**
 * 冷却是否还在生效。顺手把过期的冷却清掉：冷却到点就是自动恢复在途可用，
 * 留着它既会让快照一直显示「冷却中」，也会让开局判定永远把这个号排除在外。
 */
export const isCoolingDown = (
  service: SonGuessrServiceInternals,
  entry: SonGuessrMusicPoolEntry,
  now: number
): boolean => {
  if (entry.cooldownUntil === undefined) return false;
  if (entry.cooldownUntil > now) return true;
  entry.cooldownUntil = undefined;
  return false;
};

/** 池内某平台有没有当下可用的号：VIP 标注与「池空短路」都读这一条，不看并发。 */
export const hasAvailablePoolAccount = (
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord,
  platform: MusicAuthPlatform,
  options: { requireVip?: boolean } = {}
): boolean => {
  const now = service.now();
  return musicPool(service, room).some(
    (entry) =>
      entry.platform === platform &&
      isPoolEntryUsable(service, entry, now) &&
      (!options.requireVip || entry.account.vipStatus === "vip")
  );
};

/**
 * 取号：从池里挑一个当下可用的账号，记一份租约。
 *
 * 排序口径（先按能不能满足，再按谁更闲，最后按稳定的次要键 —— 并发返回顺序不能
 * 影响选谁，否则同一个房间两次同曲出题会挑到不同的号）：
 * 1. QQ 会员专享曲目（`requireVip`）只用会员号：非会员号取不到直链，放它去试既白跑一次
 *    上游，又会把「取不到」记成这个号的近期失败（房主看到的成功率是账号健康的信号，
 *    不该被别的号档位不够连累）；没有会员号可用时返回无租约，由调用方按无号降级处理。
 * 2. 同档按最小在途；
 * 3. 再按加入时间、玩家 id 兜底定序。
 *
 * 并发按「单号 3、整池 3 × 号数」。所有可用号都在途打满时在这里**排队**，任一租约
 * 归还或池子变化就重试；排队超过 `MUSIC_POOL_QUEUE_TIMEOUT_MS` 仍无空位，就取在途最少的
 * 可用号直接跑，交给 provider 的全局队列。只有该平台一个可用凭据都没有（未配置、
 * 全部冷却或没有会员号）时才返回无租约，由调用方降级。
 *
 * 这里的会员档筛选只决定**哪个号来服务这首已经选中的歌**，不参与题目可用性判定：调用方
 * 只对自己已经知道 `requiresVip` 的曲目传这一项，候选是否入池与能不能播仍按实际音频判定
 * （见 `Server/docs/NeteaseMusicApi.md`「猜歌接入约束」）。网易云不按会员档筛：解灰兜底让
 * 它在任何档位都取得到音源，按档筛只会白白缩小池子。
 */
export const acquireMusicAccount = async (
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord,
  platform: MusicAuthPlatform,
  options: { requireVip?: boolean } = {}
): Promise<MusicAccountLease | undefined> => {
  const deadline = service.now() + MUSIC_POOL_QUEUE_TIMEOUT_MS;
  for (;;) {
    if (service.rooms.get(room.id) !== room) return undefined;
    const available = pickMusicPoolEntry(service, room, platform, options, true);
    if (available) return leaseMusicPoolEntry(service, room, available, platform);
    const usable = pickMusicPoolEntry(service, room, platform, options, false);
    // 没有任何可用凭据（平台未配置 / 全部冷却 / 没有会员号）：这才允许降级。
    if (!usable) return undefined;
    const remaining = deadline - service.now();
    if (remaining <= 0) {
      // 繁忙超时：不降级，取在途最少的可用号直接跑，由 provider 的队列接住。
      return leaseMusicPoolEntry(service, room, usable, platform);
    }
    await waitForMusicPoolSlot(service, room.id, remaining);
  }
};

/** 取号候选：`enforceCap` 为 false 时只按「有凭据且可用」，用于判断是否存在替代号。 */
export const pickMusicPoolEntry = (
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord,
  platform: MusicAuthPlatform,
  options: { requireVip?: boolean },
  enforceCap: boolean
): SonGuessrMusicPoolEntry | undefined => {
  const now = service.now();
  const usable = musicPool(service, room).filter(
    (entry) => entry.platform === platform && isPoolEntryUsable(service, entry, now)
  );
  const tiered =
    platform === "qq" && options.requireVip
      ? usable.filter((entry) => entry.account.vipStatus === "vip")
      : usable;
  const candidates = enforceCap
    ? tiered.filter((entry) => entry.inFlight < MUSIC_POOL_MAX_IN_FLIGHT)
    : tiered;
  return [...candidates].sort((left, right) => {
    if (platform === "qq") {
      const leftVip = left.account.vipStatus === "vip" ? 0 : 1;
      const rightVip = right.account.vipStatus === "vip" ? 0 : 1;
      if (leftVip !== rightVip) return leftVip - rightVip;
    }
    if (left.inFlight !== right.inFlight) return left.inFlight - right.inFlight;
    if (left.addedAt !== right.addedAt) return left.addedAt - right.addedAt;
    return left.playerId.localeCompare(right.playerId);
  })[0];
};

export const leaseMusicPoolEntry = (
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord,
  entry: SonGuessrMusicPoolEntry,
  platform: MusicAuthPlatform
): MusicAccountLease => {
  entry.inFlight += 1;
  return {
    roomId: room.id,
    cookie: entry.cookie,
    platform,
    playerId: entry.playerId,
    release: (result) => releaseMusicAccount(service, room.id, entry, result),
  };
};

/** 等一个空位；租约归还、池子增删或开关变化都会唤醒。是否放弃等待由调用方决定。 */
export const waitForMusicPoolSlot = (
  service: SonGuessrServiceInternals,
  roomId: string,
  timeoutMs: number
): Promise<void> => {
  return new Promise((resolve) => {
    let created = service.musicPoolWaiters.get(roomId);
    if (!created) {
      created = new Set();
      service.musicPoolWaiters.set(roomId, created);
    }
    const waiters = created;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      waiters.delete(finish);
      if (waiters.size === 0) service.musicPoolWaiters.delete(roomId);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    waiters.add(finish);
  });
};

/** 唤醒某房的等号者；租约归还与池子变化都要叫一次，否则等号请求会白等到超时。 */
export const wakeMusicPoolWaiters = (service: SonGuessrServiceInternals, roomId: string): void => {
  const waiters = service.musicPoolWaiters.get(roomId);
  if (!waiters) return;
  service.musicPoolWaiters.delete(roomId);
  for (const wake of [...waiters]) wake();
};

/**
 * 归还租约并按结果更新池内状态。
 *
 * 失败口径：凭据被平台判死（`MUSIC_SESSION_INVALID`）与风控/限流
 * （`MUSIC_LOGIN_RISK`、`MUSIC_API_RATE_LIMITED`）都算「这个号当前不能用」，
 * 立即冷却摘下；`SONG_UNAVAILABLE` 这类是曲目本身的问题，只记统计，
 * 不然一首播不了的歌会把一个好好的号坑进冷却。
 *
 * 两种冷却的收尾不同：凭据判死只能靠号主重新登录（重登即清冷却并恢复开关，见
 * `installMusicSession`），所以顺手关掉开关、让快照一眼看出这号要重登；风控与限流是
 * 上游暂时的态度、凭据多半还有效，只冷却到点自动恢复，不擅自改号主的开关。
 */
export const releaseMusicAccount = (
  service: SonGuessrServiceInternals,
  roomId: string,
  entry: SonGuessrMusicPoolEntry,
  result: { ok: boolean; reason?: string; code?: string }
): void => {
  entry.inFlight = Math.max(0, entry.inFlight - 1);
  entry.recentTotal = Math.min(entry.recentTotal + 1, MUSIC_POOL_STATS_WINDOW);
  if (result.ok) {
    entry.recentOk = Math.min(entry.recentOk + 1, MUSIC_POOL_STATS_WINDOW);
    entry.lastFailureReason = undefined;
  } else {
    entry.lastFailureReason = result.reason ?? "上游请求失败";
    if (result.code === "MUSIC_SESSION_INVALID") {
      entry.enabled = false;
      entry.cooldownUntil = service.now() + MUSIC_POOL_COOLDOWN_MS;
    } else if (result.code === "MUSIC_LOGIN_RISK" || result.code === "MUSIC_API_RATE_LIMITED") {
      entry.cooldownUntil = service.now() + MUSIC_POOL_COOLDOWN_MS;
    }
  }
  // 空出一个在途位：叫醒本房排队的请求，让它们重新竞争。
  wakeMusicPoolWaiters(service, roomId);
};

/**
 * 按曲目所属平台取号跑一次上游请求，无论成败都归还租约。
 *
 * `songId` 是 URN（`netease:` / `qq:`），未知前缀按网易云处理；该平台有凭据但都在忙时
 * 先排队，只有**没有任何可用凭据**时 `cookie` 才为 undefined（网易云匿名检索仍可用，
 * QQ 由聚合器短路），由调用方与上游决定结果。
 */
export const withSongAccount = async <T>(
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord,
  songId: string | undefined,
  run: (cookie: string | undefined) => Promise<T>,
  options: { requireVip?: boolean } = {}
): Promise<T> => {
  const platform: MusicAuthPlatform = songId?.startsWith("qq:") ? "qq" : "netease";
  const lease = await acquireMusicAccount(service, room, platform, options);
  if (!lease) return run(undefined);
  try {
    const value = await run(lease.cookie);
    lease.release({ ok: true });
    return value;
  } catch (error) {
    lease.release({
      ok: false,
      code: error instanceof AppError ? error.code : "",
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};

/**
 * 按「主选 + 检索时给出的备用音源」取完整歌曲。
 *
 * 每个候选按自己的平台租号，只有 QQ 候选才可能要求会员号。已知候选全部失败后，
 * 才回落到聚合器原来的「按歌名+歌手跨平台搜索」兜底；客户端没带备用源时保持
 * 改造前的单次调用，不额外多打一次主源。
 */
export const loadSongWithSources = async (
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord,
  songId: string,
  sources?: readonly string[],
  requiresVip?: boolean
): Promise<{ song: SongDetails; alternateSongIds: string[] }> => {
  const candidates = [songId, ...(sources ?? [])]
    .filter((id, index, list) => list.indexOf(id) === index)
    .slice(0, 6);
  const requireVipFor = (candidateId: string) =>
    requiresVip === true && candidateId.startsWith("qq:");

  if (candidates.length === 1) {
    const song = await withSongAccount(
      service,
      room,
      songId,
      (cookie) => service.options.musicProvider.getSong(songId, cookie),
      { requireVip: requireVipFor(songId) }
    );
    return { song, alternateSongIds: [] };
  }

  for (const candidateId of candidates) {
    try {
      const song = await withSongAccount(
        service,
        room,
        candidateId,
        (cookie) =>
          service.options.musicProvider.getSong(candidateId, cookie, { allowFailover: false }),
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
    service,
    room,
    songId,
    (cookie) => service.options.musicProvider.getSong(songId, cookie),
    { requireVip: requireVipFor(songId) }
  );
  return { song, alternateSongIds: candidates.filter((id) => id !== songId) };
};

/** 刷新本回合播放地址：当前源失败时按已知备用源逐个再试，全部失败才抛最后一个错误。 */
export const refreshRoundAudio = async (
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord,
  round: SonGuessrRoundRecord,
  refresh: (songId: string, cookie?: MusicCookieInput) => Promise<string>
): Promise<string> => {
  const candidateIds = [round.song.id, ...(round.alternateSongIds ?? [])].filter(
    (id, index, list) => list.indexOf(id) === index
  );
  let lastError: unknown;
  for (const candidateId of candidateIds) {
    try {
      return await withSongAccount(
        service,
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

export const acquireAggregatedAccounts = async (
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord
): Promise<{
  cookie: MusicCookieInput | undefined;
  release: (result: { ok: boolean; reason?: string; code?: string }) => void;
}> => {
  const [netease, qq] = await Promise.all([
    acquireMusicAccount(service, room, "netease"),
    acquireMusicAccount(service, room, "qq"),
  ]);
  return {
    cookie:
      netease || qq
        ? { ...(netease ? { netease: netease.cookie } : {}), ...(qq ? { qq: qq.cookie } : {}) }
        : undefined,
    release: (result) => {
      netease?.release(result);
      qq?.release(result);
    },
  };
};

/**
 * 聚合检索的凭据：两端各取一号，用完一起归还。
 *
 * **必须按平台给出对象形态**，缺哪家就不写哪家：裸字符串在 `AggregatedMusicProvider`
 * 里会被当成「两家都能用」，于是没挂 QQ 账号的房间照样拿网易云凭据去搜 QQ，
 * 搜出的独占曲目一条都播不了（见 `isPlatformMismatchedCookie` 的判据与 B3 的实测问题）。
 * 池里某端没有可用号就不带该端的键，聚合器据此短路那次检索（B3 与 B4 的联动点）。
 */
export const withAggregatedAccounts = async <T>(
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord,
  run: (cookie: MusicCookieInput | undefined) => Promise<T>
): Promise<T> => {
  const lease = await acquireAggregatedAccounts(service, room);
  try {
    const value = await run(lease.cookie);
    lease.release({ ok: true });
    return value;
  } catch (error) {
    lease.release({
      ok: false,
      code: error instanceof AppError ? error.code : "",
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};

/**
 * 房内账号能力对检索结果的影响。
 *
 * `vipPlatforms` 只用于「可播」标注：QQ 会员专享曲目在池里只有非会员账号时取不到直链，
 * 结果要标不可播放。`platformPreference` 决定共有曲目由哪一侧代表：两边都有账号时
 * 按产品口径网易云优先；只有 QQ 账号的房间反过来，避免把共有曲目默认归到本房没有
 * 直接凭据的网易云。池里有没有 QQ 账号本身由凭据决定，不在这里重复声明。
 */
export const musicSearchOptions = (
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord
): MusicSearchOptions => {
  const vipPlatforms: MusicPlatform[] = [];
  if (hasAvailablePoolAccount(service, room, "netease", { requireVip: true }))
    vipPlatforms.push("netease");
  if (hasAvailablePoolAccount(service, room, "qq", { requireVip: true })) vipPlatforms.push("qq");
  const neteaseAvailable = hasAvailablePoolAccount(service, room, "netease");
  const qqAvailable = hasAvailablePoolAccount(service, room, "qq");
  const platformPreference: MusicPlatform[] =
    qqAvailable && !neteaseAvailable ? ["qq", "netease"] : ["netease", "qq"];
  return { vipPlatforms, platformPreference };
};

/** 自动选曲的软排序上下文：与检索共用同一套可播判定。 */
export const songPlayabilityContext = (
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord
): SongPlayabilityContext => {
  const qqAvailable = hasAvailablePoolAccount(service, room, "qq");
  const qqVip = hasAvailablePoolAccount(service, room, "qq", { requireVip: true });
  return {
    availablePlatforms: qqAvailable ? ["netease", "qq"] : ["netease"],
    vipPlatforms: qqVip ? ["qq"] : [],
  };
};

/** 池内每端当下会被选中的号：快照的账号展示与开局复核都读这一条（不看在途）。 */
export const primaryPoolEntry = (
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord,
  platform: MusicAuthPlatform
): SonGuessrMusicPoolEntry | undefined => {
  const now = service.now();
  return musicPool(service, room)
    .filter((entry) => entry.platform === platform && isPoolEntryUsable(service, entry, now))
    .sort((left, right) => {
      if (left.inFlight !== right.inFlight) return left.inFlight - right.inFlight;
      if (left.addedAt !== right.addedAt) return left.addedAt - right.addedAt;
      return left.playerId.localeCompare(right.playerId);
    })[0];
};

/** 池内某端有没有「开关开着、不在冷却里」的号：开局判定与快照的就绪位都用这一条（不看在途）。 */
export const hasEnabledPoolAccount = (
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord,
  platform: MusicAuthPlatform
): boolean => {
  const now = service.now();
  return musicPool(service, room).some(
    (entry) => entry.platform === platform && entry.enabled && !isCoolingDown(service, entry, now)
  );
};

/** 后台续期节流：巡检每 10 秒一次，真正扫凭证的间隔由这里控制。 */
export const scheduleMusicSessionRefresh = (
  service: SonGuessrServiceInternals,
  currentTime: number
): void => {
  if (service.musicRefreshSweepInFlight || currentTime < service.nextMusicRefreshSweepAt) return;
  service.nextMusicRefreshSweepAt = currentTime + MUSIC_SESSION_REFRESH_SWEEP_MS;
  service.musicRefreshSweepInFlight = true;
  void refreshDueMusicSessions(service).finally(() => {
    service.musicRefreshSweepInFlight = false;
  });
};

/**
 * 主动续期池内的 QQ 凭证。
 *
 * QQ 的 musickey 比网易云短命，且网页扫码的续期字段与移动端不同；只在开局复核时
 * 换一次不够。这里按 6 小时节奏在 key 过期前换新，失败不立即摘号（网络抖动很常见），
 * 只有平台明确判死才关闭开关并提示号主重登。
 */
export const refreshDueMusicSessions = async (
  service: SonGuessrServiceInternals
): Promise<void> => {
  const provider = service.options.musicProvider;
  const getLoginStatus = provider.getLoginStatus?.bind(provider);
  if (!getLoginStatus) return;

  for (const room of [...service.rooms.values()]) {
    if (service.rooms.get(room.id) !== room) continue;
    for (const entry of [...musicPool(service, room)]) {
      if (!shouldRefreshMusicEntry(service, entry)) continue;
      await refreshMusicPoolEntry(service, room, entry, getLoginStatus);
    }
  }
};

export const shouldRefreshMusicEntry = (
  service: SonGuessrServiceInternals,
  entry: SonGuessrMusicPoolEntry
): boolean => {
  if (entry.platform !== "qq" || !isPoolEntryUsable(service, entry, service.now())) return false;
  const lastRefreshed = entry.cookieRefreshedAt ?? entry.addedAt;
  return (
    service.now() - lastRefreshed >=
    (service.options.musicSessionRefreshIntervalMs ?? MUSIC_SESSION_REFRESH_INTERVAL_MS)
  );
};

export const refreshMusicPoolEntry = async (
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord,
  entry: SonGuessrMusicPoolEntry,
  getLoginStatus: (
    cookie: string,
    platform?: MusicAuthPlatform,
    options?: { forceRefresh?: boolean }
  ) => Promise<MusicLoginSession>
): Promise<void> => {
  try {
    const result = await getLoginStatus(entry.cookie, "qq", { forceRefresh: true });
    if (!musicPool(service, room).includes(entry)) return;
    const cookieChanged = result.cookie !== entry.cookie;
    entry.cookie = requireMusicCookie(service, result.cookie);
    entry.account = result.account;
    entry.cookieRefreshedAt = service.now();
    entry.lastFailureReason = undefined;
    if (cookieChanged) publishMusicSession(service, room, entry);
  } catch (error) {
    if (!musicPool(service, room).includes(entry)) return;
    if (error instanceof AppError && error.code === "MUSIC_SESSION_INVALID") {
      entry.enabled = false;
      entry.cooldownUntil = service.now() + MUSIC_POOL_COOLDOWN_MS;
      entry.lastFailureReason = "QQ 音乐登录状态已失效，请重新扫码登录";
      service.publishRoom(room);
      return;
    }
    const hadReason = entry.lastFailureReason !== undefined;
    entry.lastFailureReason = error instanceof Error ? error.message : "QQ 音乐凭证续期失败";
    if (!hadReason) service.publishRoom(room);
  }
};

/** 开局前逐端复核音乐会话；登录态已变更就清掉该端会话并广播，其余失败按上游接口错误上报。 */
export const refreshMusicSessionAccount = async (
  service: SonGuessrServiceInternals,
  check: MusicSessionRevalidation
): Promise<void> => {
  const { room, platform, entry, operation, label, verifySession, getLoginStatus } = check;
  try {
    // QQ 的 key 寿命短：开局复核顺便强制换新，避免「还能用就不续期、过期后才救」。
    const result = await getLoginStatus(entry.cookie, platform, {
      forceRefresh: platform === "qq",
    });
    verifySession(platform);
    const cookieChanged = result.cookie !== entry.cookie;
    entry.account = result.account;
    if (cookieChanged) {
      entry.cookie = requireMusicCookie(service, result.cookie);
      // 服务端替号主续期后，把新 Cookie 只发给号主自己的连接，客户端同步本机副本。
      publishMusicSession(service, room, entry);
    }
    entry.cookieRefreshedAt = service.now();
  } catch (error) {
    if (error instanceof AppError) {
      const key = musicAuthOperationKey(entry.playerId, platform);
      if (
        error.code === "MUSIC_SESSION_INVALID" &&
        musicPool(service, room).includes(entry) &&
        room.musicAuthOperations?.[key] === operation
      ) {
        // 凭据已被平台判死：直接摘掉这一号（其余号与其它玩家的号都不动），
        // 房间因此可能整体降级到「无号」，由开局门槛或运行期短路承接。
        room.musicPool = musicPool(service, room).filter((candidate) => candidate !== entry);
        wakeMusicPoolWaiters(service, room.id);
        service.publishRoom(room);
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
 */
export const publishMusicSession = (
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord,
  entry: SonGuessrMusicPoolEntry
) => {
  for (const connection of service.connections.getRoomConnections(room.id)) {
    if (connection.playerId !== entry.playerId) continue;
    connection.send(
      createEvent("song.auth.session", {
        platform: entry.platform,
        cookie: entry.cookie,
        account: entry.account,
      })
    );
  }
};
