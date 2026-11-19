import { AppError } from "../../domain/Errors";
import type { ConnectionRecord } from "../../shared/Index";
import type { SonGuessrContext } from "./Context";
import { startAutomaticRound } from "./AutomaticRounds";
import { refreshMusicSessionAccount } from "./MusicAuth";
import { hasEnabledPoolAccount, musicPool, primaryPoolEntry } from "./MusicPool";
import {
  SUBMIT_SONG_TIMEOUT_MS,
  musicAuthOperationKey,
  roomRuntime,
  type MusicAuthPlatform,
  type SonGuessrPlayerRecord,
  type SonGuessrRoomRecord,
} from "./Records";
import { activePlayers, appendSystemMessage, type SongCommandAt } from "./RoomAccess";
import { clearRoundMarks, submitterCandidates } from "./RoundParticipants";

/** 房间正在开局：自动与手动两种开局共用同一口径，设置、开局与入池开关都按它拦。 */
export const isRoomStarting = (room: SonGuessrRoomRecord): boolean =>
  room.runtime?.automaticRoundLoading === true || room.runtime?.manualRoundStarting === true;

export async function startGame(ctx: SonGuessrContext, at: SongCommandAt) {
  const { connection, room, seat: player } = at;
  const automatic = room.solo || room.settings.questionMode === "automatic";

  // 自动与手动开局均先占锁，避免重复点击并发创建两轮。
  const operation = Symbol("automaticRound");
  acquireStartLock(room, automatic, operation);
  try {
    if (!hasEnabledPoolAccount(ctx, room, "netease") && !hasEnabledPoolAccount(ctx, room, "qq")) {
      throw new AppError("MUSIC_LOGIN_REQUIRED", "开始游戏前请先扫码登录音乐账号");
    }
    const provider = ctx.options.musicProvider;
    const getLoginStatus = provider.getLoginStatus?.bind(provider);
    if (!getLoginStatus) {
      throw new AppError("MUSIC_AUTH_UNAVAILABLE", "音乐登录状态校验不可用");
    }
    // 复核每端当前会被选中的那一号：复核的意义是「开局前发现凭据已失效」，
    // 池里排在前面的号失效就会被选中，逐个复核只会把开局拖成 N 倍慢。
    const revalidations = (["netease", "qq"] as const).flatMap((platform) => {
      const entry = primaryPoolEntry(ctx, room, platform);
      return entry
        ? [
            {
              platform,
              entry,
              operation:
                room.runtime?.musicAuthOperations?.[
                  musicAuthOperationKey(entry.playerId, platform)
                ],
              label: platform === "qq" ? "QQ音乐" : "网易云",
            },
          ]
        : [];
    });
    const verifySession = (platform?: MusicAuthPlatform) => {
      if (
        ctx.rooms.get(room.id) !== room ||
        room.hostPlayerId !== player.id ||
        connection.roomId !== room.id ||
        connection.playerId !== player.id ||
        !player.online
      ) {
        throw new AppError("MUSIC_SESSION_INVALID", "音乐会话已变更，请重新开始");
      }
      for (const target of revalidations) {
        if (platform !== undefined && target.platform !== platform) continue;
        const current =
          room.runtime?.musicAuthOperations?.[
            musicAuthOperationKey(target.entry.playerId, target.platform)
          ];
        if (!musicPool(room).includes(target.entry) || current !== target.operation) {
          throw new AppError("MUSIC_SESSION_INVALID", `${target.label}会话已变更，请重新开始`);
        }
      }
    };
    for (const target of revalidations) {
      await refreshMusicSessionAccount(ctx, {
        room,
        platform: target.platform,
        entry: target.entry,
        operation: target.operation,
        label: target.label,
        verifySession,
        getLoginStatus,
      });
    }

    // 上面的复核跨了 await：回来先确认房间还在、阶段没被别的流程推进，再动任何状态。
    if (ctx.rooms.get(room.id) !== room || room.phase !== "waiting") {
      throw new AppError("ROUND_EXPIRED", "出题操作已失效");
    }

    // 开局同样是轮次起点：把只可能在离线期间留下的席位预约先结算，再按最终席位查准备。
    applyQueuedMemberships(room);
    ensurePlayersReadyToStart(ctx, room, automatic);

    room.pendingSubmitterPlayerId = undefined;
    room.pendingSubmitterDeadlineAt = undefined;
    room.pendingSubmitterAssignedAt = undefined;
    room.submitterPrompt = undefined;
    room.currentRound = undefined;
    room.roundSummary = undefined;
    if (automatic) {
      await startAutomaticRound(ctx, room, () => {
        verifySession();
        if (room.phase !== "waiting" || room.runtime?.automaticRoundOperation !== operation) {
          throw new AppError("ROUND_EXPIRED", "出题操作已失效");
        }
      });
    } else {
      room.phase = "choosingSubmitter";
    }
    room.finalScores = undefined;
    ctx.touch(room);
    ctx.publishRoom(room);
    ctx.publishLobby();
    ctx.log("song.game.started", room.id, player.id);
    return { started: true };
  } finally {
    releaseStartLock(room, automatic, operation);
  }
}

/** 自动与手动开局互斥：占住对应的开局标记。 */
function acquireStartLock(room: SonGuessrRoomRecord, automatic: boolean, operation: symbol) {
  if (!automatic) {
    roomRuntime(room).manualRoundStarting = true;
    return;
  }

  roomRuntime(room).automaticRoundOperation = operation;
  roomRuntime(room).automaticRoundLoading = true;
}

/** 开局标记只在仍属于本次操作时清空，避免踩掉后来者的锁。 */
function releaseStartLock(room: SonGuessrRoomRecord, automatic: boolean, operation: symbol) {
  if (!automatic) {
    roomRuntime(room).manualRoundStarting = false;
    return;
  }

  if (room.runtime?.automaticRoundOperation !== operation) return;
  roomRuntime(room).automaticRoundOperation = undefined;
  roomRuntime(room).automaticRoundLoading = false;
}

/** 开局门槛：至少两名在线真人且全部准备；手动开局还得有可选出题人。 */
function ensurePlayersReadyToStart(
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  automatic: boolean
) {
  // 单人房间由系统直接出题，没有出题人与准备环节。
  if (room.solo) return;

  const players = activePlayers(room);
  if (players.length < 2) throw new AppError("NOT_ENOUGH_PLAYERS", "至少需要两名正式玩家");
  if (players.some((candidate) => !candidate.isReady)) {
    throw new AppError("PLAYERS_NOT_READY", "仍有玩家未准备");
  }
  if (!automatic && submitterCandidates(ctx, room).length === 0) {
    throw new AppError(
      "NO_SUBMITTER_CANDIDATE",
      "暂无可选出题人：出题人的队友会一起观战，需要留下猜歌的玩家"
    );
  }
}

/** 指定出题人：时限从此刻起算，同时记下起点作为后续顺延的封顶基准。 */
function assignSubmitterDeadline(ctx: SonGuessrContext, room: SonGuessrRoomRecord) {
  room.pendingSubmitterAssignedAt = ctx.now();
  room.pendingSubmitterDeadlineAt = ctx.now() + SUBMIT_SONG_TIMEOUT_MS;
}

/** 出题人提交时顺延时限，但以指定时刻起算的两个时限封顶：选题阶段必须有服务端硬上限。 */
export function extendSubmitterDeadline(ctx: SonGuessrContext, room: SonGuessrRoomRecord) {
  const assignedAt = room.pendingSubmitterAssignedAt ?? ctx.now();
  room.pendingSubmitterDeadlineAt = Math.min(
    ctx.now() + SUBMIT_SONG_TIMEOUT_MS,
    assignedAt + 2 * SUBMIT_SONG_TIMEOUT_MS
  );
}

export function chooseSubmitter(ctx: SonGuessrContext, at: SongCommandAt, targetPlayerId: string) {
  const { room } = at;
  const target = room.players[targetPlayerId];
  if (!target || !target.online || target.membership === "kicked" || target.isBot) {
    throw new AppError("INVALID_TARGET", "出题人必须是在线真人玩家");
  }
  if (!submitterCandidates(ctx, room).includes(target)) {
    throw new AppError("INVALID_TARGET", "指定后没有可以猜歌的玩家：出题人的队友会一起观战");
  }

  room.pendingSubmitterPlayerId = target.id;
  assignSubmitterDeadline(ctx, room);
  room.submitterPrompt = undefined;
  room.phase = "submittingSong";
  room.roundSummary = undefined;
  ctx.touch(room);
  ctx.publishRoom(room);
  ctx.publishLobby();
  return { submitterPlayerId: target.id };
}

export async function nextRound(ctx: SonGuessrContext, at: SongCommandAt) {
  const { connection, room, seat: player } = at;
  if (room.solo || room.settings.questionMode === "automatic")
    return beginAutomaticNextRound(ctx, connection, room, player);
  return beginManualNextRound(ctx, room);
}

/**
 * 出题人失效（断线、离房、被踢或选题超时）：退回选出题人阶段，并把原因写进房间公告。
 * 只有当前待出题人能解除这个阶段，别人的断线不该把选题中的出题人踢下来。
 *
 * 这个阶段只有出题人能推进房间，界面又会自动收起选歌面板，不说明原因的切换在玩家眼里
 * 就是「页面莫名回到选人」，房主也不知道该不该重选同一个人。
 */
export function releasePendingSubmitter(
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  playerId: string,
  reason: string
) {
  if (room.phase !== "submittingSong" || room.pendingSubmitterPlayerId !== playerId) return;
  room.pendingSubmitterPlayerId = undefined;
  room.pendingSubmitterDeadlineAt = undefined;
  room.pendingSubmitterAssignedAt = undefined;
  room.submitterPrompt = reason;
  room.phase = "choosingSubmitter";
  appendSystemMessage(ctx, room, reason);
}

/** 人数不足以开局：退回等待阶段，两名玩家的准备状态清零。 */
function fallBackToWaiting(ctx: SonGuessrContext, room: SonGuessrRoomRecord) {
  room.pendingSubmitterPlayerId = undefined;
  room.pendingSubmitterDeadlineAt = undefined;
  room.pendingSubmitterAssignedAt = undefined;
  room.submitterPrompt = undefined;
  room.phase = "waiting";
  clearRoundMarks(room);
  resetReadyState(room);
  ctx.touch(room);
  ctx.publishRoom(room);
  ctx.publishLobby();
}

/** 单人房永远满足开局人数，其余房间要两名在线正式玩家。 */
function hasNextRoundQuorum(room: SonGuessrRoomRecord) {
  if (room.solo) return true;
  return activePlayers(room).filter((candidate) => candidate.online).length >= 2;
}

/** 自动出题下一回合：抽题期间房主可能换人或回合被别处推进，失效即丢弃结果。 */
async function beginAutomaticNextRound(
  ctx: SonGuessrContext,
  connection: ConnectionRecord,
  room: SonGuessrRoomRecord,
  player: SonGuessrPlayerRecord
) {
  if (room.runtime?.automaticRoundLoading) throw new AppError("ROUND_BUSY", "正在准备下一回合");
  const previousRound = room.currentRound;
  const previousSummary = room.roundSummary;
  const operation = Symbol("automaticRound");
  roomRuntime(room).automaticRoundOperation = operation;
  roomRuntime(room).automaticRoundLoading = true;
  const isCurrent = () =>
    ctx.rooms.get(room.id) === room &&
    room.runtime?.automaticRoundOperation === operation &&
    room.phase === "roundResult" &&
    room.currentRound === previousRound &&
    room.hostPlayerId === player.id &&
    player.online &&
    connection.roomId === room.id &&
    connection.playerId === player.id;
  const verify = () => {
    if (!isCurrent()) throw new AppError("ROUND_EXPIRED", "出题操作已失效");
  };
  try {
    applyQueuedMemberships(room);
    if (!hasNextRoundQuorum(room)) {
      room.currentRound = undefined;
      room.roundSummary = undefined;
      fallBackToWaiting(ctx, room);
      return { nextRound: room.roundNumber + 1, waiting: true };
    }
    await startAutomaticRound(ctx, room, verify);
  } catch (error) {
    // 自动题库临时失败时保留答案页，房主可以重试或回到等待阶段，
    // 不能留下既没有 currentRound 也没有 roundSummary 的悬空状态。
    if (isCurrent()) {
      room.currentRound = previousRound;
      room.roundSummary = previousSummary;
      room.phase = "roundResult";
    }
    throw error;
  } finally {
    if (room.runtime?.automaticRoundOperation === operation) {
      roomRuntime(room).automaticRoundOperation = undefined;
      roomRuntime(room).automaticRoundLoading = false;
    }
  }
  ctx.touch(room);
  ctx.publishRoom(room);
  ctx.publishLobby();
  return { nextRound: room.roundNumber + 1 };
}

/** 手动出题下一回合：轮换开启则自动指定出题人，否则回到选出题人阶段。 */
function beginManualNextRound(ctx: SonGuessrContext, room: SonGuessrRoomRecord) {
  // 全程同步没有 await：不需要任何开局锁，并发的请求不可能插进来。
  const previousSubmitterId = room.currentRound?.submitterPlayerId;
  room.currentRound = undefined;
  room.roundSummary = undefined;
  applyQueuedMemberships(room);
  if (!hasNextRoundQuorum(room)) {
    fallBackToWaiting(ctx, room);
    return { nextRound: room.roundNumber + 1, waiting: true };
  }
  const nextSubmitter = room.settings.autoRotateSubmitter
    ? nextRotatingSubmitter(ctx, room, previousSubmitterId)
    : undefined;
  // 「再来一轮」已经把界面切到下一轮：上一轮的结局不跟着进新回合。
  clearRoundMarks(room);
  // 没轮到出题人时保留原 pendingSubmitterPlayerId，只换阶段。
  if (nextSubmitter) {
    room.pendingSubmitterPlayerId = nextSubmitter.id;
    assignSubmitterDeadline(ctx, room);
    room.submitterPrompt = undefined;
    room.phase = "submittingSong";
  } else {
    room.phase = "choosingSubmitter";
  }
  ctx.touch(room);
  ctx.publishRoom(room);
  ctx.publishLobby();
  return { nextRound: room.roundNumber + 1 };
}

export function finishGame(ctx: SonGuessrContext, at: SongCommandAt) {
  const { room } = at;
  roomRuntime(room).automaticRoundOperation = undefined;
  roomRuntime(room).automaticRoundLoading = false;
  room.phase = "waiting";
  room.pendingSubmitterPlayerId = undefined;
  room.pendingSubmitterDeadlineAt = undefined;
  room.pendingSubmitterAssignedAt = undefined;
  room.submitterPrompt = undefined;
  room.currentRound = undefined;
  room.roundSummary = undefined;
  room.finalScores = undefined;
  clearRoundMarks(room);
  applyQueuedMemberships(room);
  resetReadyState(room);
  ctx.touch(room);
  ctx.publishRoom(room);
  ctx.publishLobby();
  return { waiting: true, roundNumber: room.roundNumber };
}

function applyQueuedMemberships(room: SonGuessrRoomRecord) {
  for (const player of Object.values(room.players)) {
    const membership = player.nextRoundMembership;
    if (!membership || player.membership === "kicked") continue;
    if (membership === "spectator" && !room.allowSpectators) continue;
    if (membership === "active" && !player.online) continue;
    player.nextRoundMembership = undefined;
    player.membership = membership;
    if (membership === "spectator") player.team = null;
    player.isReady = membership === "active" && (player.id === room.hostPlayerId || player.isBot);
  }
}

function resetReadyState(room: SonGuessrRoomRecord) {
  for (const candidate of Object.values(room.players)) {
    candidate.isReady =
      candidate.membership === "active" && (candidate.id === room.hostPlayerId || candidate.isBot);
  }
}

function nextRotatingSubmitter(
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  previousSubmitterId?: string
) {
  // 轮流也只轮到留得下猜歌玩家的人：整队出题会把队友一起带去观战。
  const eligible = new Set(submitterCandidates(ctx, room));
  const candidates = Object.values(room.players)
    .filter((player) => player.membership === "active" && eligible.has(player))
    .sort((left, right) => left.joinedAt - right.joinedAt);
  if (candidates.length === 0) return undefined;
  const previousIndex = candidates.findIndex((player) => player.id === previousSubmitterId);
  return candidates[(previousIndex + 1 + candidates.length) % candidates.length];
}
