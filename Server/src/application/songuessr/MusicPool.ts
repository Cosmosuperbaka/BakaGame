import { AppError } from "../../domain/Errors";
import type {
  MusicCookieInput,
  MusicPlatform,
  MusicSearchOptions,
} from "../../infrastructure/music/MusicProvider";
import type { SongPlayabilityContext } from "../../infrastructure/music/MusicDeduplicator";
import {
  MUSIC_POOL_COOLDOWN_MS,
  MUSIC_POOL_MAX_COOLDOWN_MS,
  MUSIC_POOL_MAX_IN_FLIGHT,
  MUSIC_POOL_QUEUE_TIMEOUT_MS,
  MUSIC_POOL_STATS_WINDOW,
  MusicAccountLease,
  MusicAuthPlatform,
  SonGuessrMusicPoolEntry,
  SonGuessrRoomRecord,
} from "./Records";
import type { SonGuessrContext } from "./Context";

/**
 * 房间里的音乐账号池：可用性判定、取号与租约、等号队列、凭据判死与聚合租约。
 * 池条目与等号表只有这里读写，其余模块经这里的函数取号、还号。
 */

/** 池内所有条目；房间记录里没有池时按空池建一个，调用方不必各自判空。 */
export const musicPool = (room: SonGuessrRoomRecord): SonGuessrMusicPoolEntry[] => {
  room.musicPool ??= [];
  return room.musicPool;
};

/**
 * 该号当下能不能用：开关开着、不在冷却里。
 *
 * 不看贡献者在线与否：掉线有宽限期，宽限内人还在房里，号照用；超期由
 * `cleanupOfflinePlayers` 连号一起清掉。也不看在途数：快照展示、开局复核与
 * VIP 标注只需要知道「这号是否可用」，取号时才卡并发。
 */
export const isPoolEntryUsable = (entry: SonGuessrMusicPoolEntry, now: number): boolean => {
  if (!entry.enabled) return false;
  if (isCoolingDown(entry, now)) return false;
  return true;
};

/**
 * 冷却是否还在生效。顺手把过期的冷却清掉：冷却到点就是自动恢复在途可用，
 * 留着它既会让快照一直显示「冷却中」，也会让开局判定永远把这个号排除在外。
 */
export const isCoolingDown = (entry: SonGuessrMusicPoolEntry, now: number): boolean => {
  if (entry.cooldownUntil === undefined) return false;
  if (entry.cooldownUntil > now) return true;
  entry.cooldownUntil = undefined;
  return false;
};

/** 池内某平台有没有当下可用的号：VIP 标注与「池空短路」都读这一条，不看并发。 */
export const hasAvailablePoolAccount = (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  platform: MusicAuthPlatform,
  options: { requireVip?: boolean } = {}
): boolean => {
  const now = ctx.now();
  return musicPool(room).some(
    (entry) =>
      entry.platform === platform &&
      isPoolEntryUsable(entry, now) &&
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
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  platform: MusicAuthPlatform,
  options: { requireVip?: boolean } = {}
): Promise<MusicAccountLease | undefined> => {
  const deadline = ctx.now() + MUSIC_POOL_QUEUE_TIMEOUT_MS;
  for (;;) {
    if (ctx.rooms.get(room.id) !== room) return undefined;
    const available = pickMusicPoolEntry(ctx, room, platform, options, true);
    if (available) return leaseMusicPoolEntry(ctx, room, available, platform);
    const usable = pickMusicPoolEntry(ctx, room, platform, options, false);
    // 没有任何可用凭据（平台未配置 / 全部冷却 / 没有会员号）：这才允许降级。
    if (!usable) return undefined;
    const remaining = deadline - ctx.now();
    if (remaining <= 0) {
      // 繁忙超时：不降级，取在途最少的可用号直接跑，由 provider 的队列接住。
      return leaseMusicPoolEntry(ctx, room, usable, platform);
    }
    await waitForMusicPoolSlot(ctx, room.id, remaining);
  }
};

/** 取号候选：`enforceCap` 为 false 时只按「有凭据且可用」，用于判断是否存在替代号。 */
export const pickMusicPoolEntry = (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  platform: MusicAuthPlatform,
  options: { requireVip?: boolean },
  enforceCap: boolean
): SonGuessrMusicPoolEntry | undefined => {
  const now = ctx.now();
  const usable = musicPool(room).filter(
    (entry) => entry.platform === platform && isPoolEntryUsable(entry, now)
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
  ctx: SonGuessrContext,
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
    release: (result) => releaseMusicAccount(ctx, room.id, entry, result),
  };
};

/** 等一个空位；租约归还、池子增删或开关变化都会唤醒。是否放弃等待由调用方决定。 */
export const waitForMusicPoolSlot = (
  ctx: SonGuessrContext,
  roomId: string,
  timeoutMs: number
): Promise<void> => {
  return new Promise((resolve) => {
    let created = ctx.musicPoolWaiters.get(roomId);
    if (!created) {
      created = new Set();
      ctx.musicPoolWaiters.set(roomId, created);
    }
    const waiters = created;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      waiters.delete(finish);
      if (waiters.size === 0) ctx.musicPoolWaiters.delete(roomId);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    waiters.add(finish);
  });
};

/** 唤醒某房的等号者；租约归还与池子变化都要叫一次，否则等号请求会白等到超时。 */
export const wakeMusicPoolWaiters = (ctx: SonGuessrContext, roomId: string): void => {
  const waiters = ctx.musicPoolWaiters.get(roomId);
  if (!waiters) return;
  ctx.musicPoolWaiters.delete(roomId);
  for (const wake of [...waiters]) wake();
};

/**
 * 凭据被平台判死：关开关、打失效标记并冷却，条目留在池里。
 * 三条判死路径（取号归还、后台续期、开局复核）共用这一处，号主才能在面板上看到
 * 「失效、需要重登」；重登会清掉标记并恢复开关（见 `installMusicSession`）。
 */
export const markEntryInvalidated = (
  ctx: SonGuessrContext,
  entry: SonGuessrMusicPoolEntry,
  reason: string
): void => {
  entry.enabled = false;
  entry.invalidated = true;
  entry.cooldownUntil = ctx.now() + MUSIC_POOL_COOLDOWN_MS;
  entry.lastFailureReason = reason;
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
 * 上游暂时的态度、凭据多半还有效，只冷却到点自动恢复，不擅自改号主的开关。限流冷却
 * 按连续命中次数翻倍，避免同一个还没恢复的号每 5 分钟回来再撞一次。
 */
export const releaseMusicAccount = (
  ctx: SonGuessrContext,
  roomId: string,
  entry: SonGuessrMusicPoolEntry,
  result: { ok: boolean; reason?: string; code?: string }
): void => {
  entry.inFlight = Math.max(0, entry.inFlight - 1);
  entry.recentTotal = Math.min(entry.recentTotal + 1, MUSIC_POOL_STATS_WINDOW);
  if (result.ok) {
    entry.recentOk = Math.min(entry.recentOk + 1, MUSIC_POOL_STATS_WINDOW);
    entry.lastFailureReason = undefined;
    entry.rateLimitStrikes = undefined;
  } else {
    entry.lastFailureReason = result.reason ?? "上游请求失败";
    if (result.code === "MUSIC_SESSION_INVALID") {
      markEntryInvalidated(ctx, entry, entry.lastFailureReason);
    } else if (result.code === "MUSIC_LOGIN_RISK") {
      entry.cooldownUntil = ctx.now() + MUSIC_POOL_COOLDOWN_MS;
    } else if (result.code === "MUSIC_API_RATE_LIMITED") {
      // 连续限流说明这个号的额度还没恢复，按次数拉长冷却；固定 5 分钟会在恢复窗口
      // （实测最长可达二十分钟以上）里反复把它放回池子、再撞一轮 405。
      const strikes = Math.min((entry.rateLimitStrikes ?? 0) + 1, 4);
      entry.rateLimitStrikes = strikes;
      const cooldownMs = Math.min(
        MUSIC_POOL_MAX_COOLDOWN_MS,
        MUSIC_POOL_COOLDOWN_MS * 2 ** (strikes - 1)
      );
      entry.cooldownUntil = ctx.now() + cooldownMs;
    }
  }
  // 空出一个在途位：叫醒本房排队的请求，让它们重新竞争。
  wakeMusicPoolWaiters(ctx, roomId);
};

/** 归还租约时的结果；`platform` 标明失败归属哪个平台，缺省视为两端都可能有份。 */
type LeaseReleaseResult = {
  ok: boolean;
  reason?: string;
  code?: string;
  platform?: MusicAuthPlatform;
};

/** 错误到平台的归属：上游抛出的错误不带平台，由知道自己在调哪个平台的调用点登记。 */
const errorPlatforms = new WeakMap<object, MusicAuthPlatform>();

/**
 * 租约内跑一次上游请求，无论成败都归还租约，异常原样抛回。
 * 平台归属只有聚合租约会读：单平台租约只有一个号，失败记在谁身上没有歧义。
 */
const runLeased = async <T, TCookie>(
  lease: { cookie: TCookie; release: (result: LeaseReleaseResult) => void },
  run: (cookie: TCookie) => Promise<T>
): Promise<T> => {
  try {
    const value = await run(lease.cookie);
    lease.release({ ok: true });
    return value;
  } catch (error) {
    lease.release({
      ok: false,
      code: error instanceof AppError ? error.code : "",
      reason: error instanceof Error ? error.message : String(error),
      platform: typeof error === "object" && error !== null ? errorPlatforms.get(error) : undefined,
    });
    throw error;
  }
};

/**
 * 按曲目所属平台取号跑一次上游请求，无论成败都归还租约。
 *
 * `songId` 是 URN（`netease:` / `qq:`），未知前缀按网易云处理；该平台有凭据但都在忙时
 * 先排队，只有**没有任何可用凭据**时 `cookie` 才为 undefined（网易云匿名检索仍可用，
 * QQ 由聚合器短路），由调用方与上游决定结果。
 *
 * 租约账号被上游限流时，归还租约已经把它放进冷却；同一次业务请求里直接换号或走匿名
 * 出口再试一次。限流只说明那一条出口打满了，不该让玩家点的「开始 / 下一轮」整轮失败。
 */
export const withSongAccount = async <T>(
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  songId: string | undefined,
  run: (cookie: string | undefined) => Promise<T>,
  options: { requireVip?: boolean } = {}
): Promise<T> => {
  const platform: MusicAuthPlatform = songId?.startsWith("qq:") ? "qq" : "netease";
  const lease = await acquireMusicAccount(ctx, room, platform, options);
  if (!lease) return run(undefined);
  try {
    return await runLeased(lease, run);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "MUSIC_API_RATE_LIMITED") throw error;
    const fallback = await acquireMusicAccount(ctx, room, platform, options);
    return fallback ? runLeased(fallback, run) : run(undefined);
  }
};

/**
 * 声明这次上游调用只属于某个平台：它失败时，聚合租约只把失败记在该平台的账号上，
 * 另一端的健康账号不会被连带判死或冷却。
 */
export const onMusicPlatform = async <T>(
  platform: MusicAuthPlatform,
  task: Promise<T>
): Promise<T> => {
  try {
    return await task;
  } catch (error) {
    if (typeof error === "object" && error !== null) errorPlatforms.set(error, platform);
    throw error;
  }
};

export const acquireAggregatedAccounts = async (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord
): Promise<{
  cookie: MusicCookieInput | undefined;
  release: (result: LeaseReleaseResult) => void;
}> => {
  const [netease, qq] = await Promise.all([
    acquireMusicAccount(ctx, room, "netease"),
    acquireMusicAccount(ctx, room, "qq"),
  ]);
  return {
    cookie:
      netease || qq
        ? { ...(netease ? { netease: netease.cookie } : {}), ...(qq ? { qq: qq.cookie } : {}) }
        : undefined,
    release: (result) => {
      // 失败归属另一端时，这一端的请求本身没有出错，按成功归还。
      const forPlatform = (platform: MusicAuthPlatform) =>
        result.platform !== undefined && result.platform !== platform ? { ok: true } : result;
      netease?.release(forPlatform("netease"));
      qq?.release(forPlatform("qq"));
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
 *
 * 与 `withSongAccount` 同一口径：账号被上游限流时归还租约即已冷却，同一次业务请求
 * 换剩余账号或匿名出口再跑一次，不让一次账号级限流变成玩家看到的整轮失败。
 */
export const withAggregatedAccounts = async <T>(
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  run: (cookie: MusicCookieInput | undefined) => Promise<T>
): Promise<T> => {
  const lease = await acquireAggregatedAccounts(ctx, room);
  try {
    return await runLeased(lease, run);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "MUSIC_API_RATE_LIMITED") throw error;
    return runLeased(await acquireAggregatedAccounts(ctx, room), run);
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
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord
): MusicSearchOptions => {
  const vipPlatforms: MusicPlatform[] = [];
  if (hasAvailablePoolAccount(ctx, room, "netease", { requireVip: true }))
    vipPlatforms.push("netease");
  if (hasAvailablePoolAccount(ctx, room, "qq", { requireVip: true })) vipPlatforms.push("qq");
  const neteaseAvailable = hasAvailablePoolAccount(ctx, room, "netease");
  const qqAvailable = hasAvailablePoolAccount(ctx, room, "qq");
  const platformPreference: MusicPlatform[] =
    qqAvailable && !neteaseAvailable ? ["qq", "netease"] : ["netease", "qq"];
  return { vipPlatforms, platformPreference };
};

/** 自动选曲的软排序上下文：与检索共用同一套可播判定。 */
export const songPlayabilityContext = (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord
): SongPlayabilityContext => {
  const qqAvailable = hasAvailablePoolAccount(ctx, room, "qq");
  const qqVip = hasAvailablePoolAccount(ctx, room, "qq", { requireVip: true });
  return {
    availablePlatforms: qqAvailable ? ["netease", "qq"] : ["netease"],
    vipPlatforms: qqVip ? ["qq"] : [],
  };
};

/** 池内每端当下会被选中的号：快照的账号展示与开局复核都读这一条（不看在途）。 */
export const primaryPoolEntry = (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  platform: MusicAuthPlatform
): SonGuessrMusicPoolEntry | undefined => {
  const now = ctx.now();
  return musicPool(room)
    .filter((entry) => entry.platform === platform && isPoolEntryUsable(entry, now))
    .sort((left, right) => {
      if (left.inFlight !== right.inFlight) return left.inFlight - right.inFlight;
      if (left.addedAt !== right.addedAt) return left.addedAt - right.addedAt;
      return left.playerId.localeCompare(right.playerId);
    })[0];
};

/** 池内某端有没有「开关开着、不在冷却里」的号：开局判定与快照的就绪位都用这一条（不看在途）。 */
export const hasEnabledPoolAccount = (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  platform: MusicAuthPlatform
): boolean => {
  const now = ctx.now();
  return musicPool(room).some(
    (entry) => entry.platform === platform && entry.enabled && !isCoolingDown(entry, now)
  );
};
