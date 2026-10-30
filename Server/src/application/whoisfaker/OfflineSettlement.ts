import { AppError } from "../../domain/Errors";
import { createEvent } from "../../transport/Packets";
import { recordEliminations } from "../../domain/Rules";
import {
  ROOM_ID_TEST_MODE,
  type ConnectionRecord,
  type GameRound,
  type RoundHistoryEntry,
  type WhoIsFakerPhase,
  type WhoIsFakerPlayerRecord,
  type WhoIsFakerRoomRecord,
} from "../../shared/Index";
import { HOST_RECONNECT_TIMEOUT_MS, QUESTIONER_RECONNECT_TIMEOUT_MS } from "../../config/Constants";
import {
  applyEliminationAndMove,
  predictFeedbackNext,
  resolveAbandonedBlankGuess,
  startFallbackBlankGuessTimer,
} from "./BlankGuess";
import { runBots } from "./BotActors";
import { clearPhaseTimer, finishRound } from "./PhaseFlow";
import { broadcastRoomEvent, getCurrentSpeechState, publishLobby, publishRoom } from "./RoomViews";
import { getOnlineCount, normalizeRoomRoleConfig } from "./RoundRules";
import type { WhoIsFakerServiceInternals } from "./ServiceInternals";

/** 玩家离线的两种来源：连接断开与主动离开房间。 */
export type PlayerOfflineReason = "disconnect" | "leave";

/** 离线处理的上下文：房主身份在清理前读一次，供各阶段共用。 */
type OfflineContext = {
  room: WhoIsFakerRoomRecord;
  playerId: string;
  player: WhoIsFakerPlayerRecord;
  reason: PlayerOfflineReason;
  wasHost: boolean;
};

/** 强制移除的上下文：踢人通知、出局恢复与收尾日志共用同一份快照。 */
type ForcedRemovalContext = {
  room: WhoIsFakerRoomRecord;
  playerId: string;
  player: WhoIsFakerPlayerRecord;
  reason: string;
  preserved: RoundPreservation;
};

/** 移除前从回合里抄下来的待恢复数据，回合未开始时全为空。 */
type RoundPreservation = {
  votes?: GameRound["votes"];
  nightActions?: GameRound["nightActions"];
  tieBreak?: GameRound["tieBreak"];
  supplementActive?: boolean;
};

/** 白板猜词者离场可能当场终局，此时必须跳过踢人收尾与日志。 */
type ForcedRemovalFlow = "continue" | "done";

/** 0 分真人旁观者掉线后没有保留价值，立即移出。 */
const isExpendableSpectator = (ctx: OfflineContext): boolean => {
  const { player, reason, wasHost } = ctx;
  return (
    reason === "disconnect" &&
    player.membership === "spectator" &&
    player.score === 0 &&
    !player.isBot &&
    !wasHost
  );
};

export const resolveDisconnect = async (
  service: WhoIsFakerServiceInternals,
  connection: ConnectionRecord,
  targetPlayerId: string,
  resolution: "wait" | "eliminate"
) => {
  // 只有出题人能决定掉线正式玩家是继续等待还是直接淘汰。
  const { room, player } = service.requireRoomPlayer(connection);
  const round = service.requireRound(room);
  service.ensureQuestioner(round, player.id);

  if (!round.pendingDisconnectPlayerIds.includes(targetPlayerId)) {
    throw new AppError("PLAYER_NOT_PENDING", "当前没有等待处理的掉线玩家");
  }
  clearPendingDisconnect(round, targetPlayerId);

  if (resolution === "eliminate") {
    await forceRemovePlayer(service, room, targetPlayerId, "掉线后被出题人移出");
  } else {
    service.appendSystemMessage(
      room,
      `${room.players[targetPlayerId]?.name ?? "玩家"} 的掉线状态已保留`
    );
    // 关键修复：若掉线者正是猜词中的白板，选择保留等待时挂载 60 秒倒计时兜底，超时自动按失败结算切回残局，杜绝死锁
    if (round.phase === "blankGuess" && round.blankGuessContext?.playerId === targetPlayerId) {
      startFallbackBlankGuessTimer(service, room, 60);
    }
  }

  service.touch(room);
  await service.log({
    type: "game.disconnect_resolved",
    createdAt: service.now(),
    roomId: room.id,
    playerId: player.id,
    payload: {
      targetPlayerId,
      resolution,
    },
  });

  publishRoom(service, room);
  await runBots(service, room);

  return { resolved: true };
};

export const handlePlayerOffline = async (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord,
  playerId: string,
  reason: PlayerOfflineReason
) => {
  // 这里集中处理“玩家不在线”带来的所有副作用：局外移除、局内待决、空房清理。
  const player = room.players[playerId];
  if (!player) {
    return;
  }

  const round = room.round;
  const ctx: OfflineContext = {
    room,
    playerId,
    player,
    reason,
    wasHost: room.hostPlayerId === player.id,
  };

  markPlayerDisconnected(service, ctx);
  releaseHostSlot(service, ctx);
  // 0分数的旁观者掉线立即移除
  if (isExpendableSpectator(ctx)) {
    delete room.players[player.id];
  }

  if (!round || round.phase === "gameOver") {
    await settleOfflineOutsideRound(service, ctx);
    return;
  }

  await settleOfflineInsideRound(service, ctx, round);

  if (ctx.wasHost && reason === "leave") {
    service.reassignHost(room);
  }

  service.touch(room);
  await service.log({
    type: `player.${reason}`,
    createdAt: service.now(),
    roomId: room.id,
    playerId,
  });

  await publishOrCloseIfEmpty(service, room, reason);
};

/** 标记离线并解绑连接；整房都没人在线时才起空房计时。 */
const markPlayerDisconnected = (service: WhoIsFakerServiceInternals, ctx: OfflineContext) => {
  const room = ctx.room;
  const player = ctx.player;
  player.online = false;
  player.connectionId = undefined;
  player.lastSeenAt = service.now();
  const connection = service.connectionRegistry.findConnectionByPlayerId(player.id);
  if (connection) {
    service.connectionRegistry.detach(connection);
  }

  if (getOnlineCount(room) === 0 && shouldAutoCloseWhenEmpty(room)) {
    room.emptySinceAt ??= service.now();
  }
};

/** 房主席位让位：显式离开直接腾空，掉线则给一个重连截止时刻。 */
const releaseHostSlot = (service: WhoIsFakerServiceInternals, ctx: OfflineContext) => {
  if (!ctx.wasHost) {
    return;
  }

  if (ctx.reason === "leave") {
    ctx.room.hostPlayerId = "";
    ctx.room.hostReconnectDeadlineAt = undefined;
    return;
  }

  ctx.room.hostReconnectDeadlineAt = service.now() + HOST_RECONNECT_TIMEOUT_MS;
};

/** 局外掉线：显式离开的真人无条件移出房间，房主离开后重选房主。 */
const settleOfflineOutsideRound = async (
  service: WhoIsFakerServiceInternals,
  ctx: OfflineContext
) => {
  const room = ctx.room;
  if (ctx.reason === "leave" && !ctx.player.isBot) {
    // 玩家显式离开时，无条件将其从房间列表中清理
    delete room.players[ctx.player.id];
  }

  if (ctx.wasHost && ctx.reason === "leave") {
    // 先临时置空，让 reassignHost 按加入时间重新选出首位。
    room.hostPlayerId = "";
    service.reassignHost(room);
  }

  normalizeRoomRoleConfig(room);
  service.touch(room);
  await publishOrCloseIfEmpty(service, room, ctx.reason);
};

/** 局内掉线：出题人显式离开即终止本局，其余按掉线淘汰决策处理。 */
const settleOfflineInsideRound = async (
  service: WhoIsFakerServiceInternals,
  ctx: OfflineContext,
  round: GameRound
) => {
  if (ctx.reason === "leave") {
    await removeLeavingPlayer(service, ctx, round);
    return;
  }

  await queueOfflineDecision(service, ctx, round);
};

/** 出题人主动退出直接终止本局，其余玩家按离开强制移出。 */
const removeLeavingPlayer = async (
  service: WhoIsFakerServiceInternals,
  ctx: OfflineContext,
  round: GameRound
) => {
  const room = ctx.room;
  const player = ctx.player;
  if (round.questionerPlayerId === player.id) {
    await finishRound(service, room, "aborted", "出题人主动退出房间，本局已终止");
  } else {
    await forceRemovePlayer(service, room, player.id, "leave");
  }

  if (!player.isBot) {
    delete room.players[player.id];
  }
};

/** 出题人掉线留出重连窗口；其余玩家由全房决定是否进入淘汰投票。 */
const queueOfflineDecision = async (
  service: WhoIsFakerServiceInternals,
  ctx: OfflineContext,
  round: GameRound
) => {
  const room = ctx.room;
  const player = ctx.player;
  if (round.questionerPlayerId === player.id) {
    round.questionerReconnectDeadlineAt = service.now() + QUESTIONER_RECONNECT_TIMEOUT_MS;
    service.appendSystemMessage(room, "出题人已掉线，系统开始等待其重新连接");
    return;
  }

  if (shouldQueueDisconnectForDecision(service, round, player)) {
    enqueuePendingDisconnect(round, player.id);
    broadcastRoomEvent(service, room, "game.disconnectDecisionRequested", {
      roomId: room.id,
      playerId: ctx.playerId,
    });
  }
};

/** 显式离开可能让房间只剩空壳：空了就关房，否则照常广播快照与大厅。 */
const publishOrCloseIfEmpty = async (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord,
  reason: PlayerOfflineReason
) => {
  if (reason === "leave" && getOnlineCount(room) === 0) {
    await service.closeRoom(room, "empty");
    return;
  }

  publishRoom(service, room);
  publishLobby(service);
};

/**
 * 空房是否应当自动关闭。测试房间要能在最后一人刷新页面后仍然存在，
 * 否则每次刷新都会丢掉正在调试的房间状态。
 */
export const shouldAutoCloseWhenEmpty = (room: WhoIsFakerRoomRecord) => {
  return room.id !== ROOM_ID_TEST_MODE;
};

export const forceRemovePlayer = async (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord,
  playerId: string,
  reason: string
) => {
  // 强制移除既可能来自房主踢人，也可能来自掉线淘汰决策。
  const player = room.players[playerId];
  if (!player) {
    return;
  }

  sendKickNotice(service, room, player);
  markPlayerAsKicked(player);

  // 先清掉回合里的引用，再抄恢复现场要用的快照：补充发言可能正好在这次清理中被判定完成。
  const preserved: RoundPreservation = room.round
    ? scrubPlayerFromRound(service, room, room.round, player.id)
    : {};
  const ctx: ForcedRemovalContext = { room, playerId, player, reason, preserved };

  recordRemovalHistory(service, ctx);

  const round = room.round;
  if (round?.phase === "feedback" && round.assignments[player.id]?.alive) {
    recordFeedbackElimination(service, ctx, round);
  } else if (round?.assignments[player.id]?.alive && round.phase !== "gameOver") {
    if ((await exitAlivePlayer(service, ctx, round)) === "done") return;
  }

  await finishForcedRemoval(service, ctx);
};

/** 被踢的一方要先收到房间关闭事件，连接与玩家的绑定随即解开。 */
const sendKickNotice = (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord,
  player: WhoIsFakerPlayerRecord
) => {
  const connection = service.getConnectionByPlayer(player.id);
  if (!connection) return;

  (connection.sendPacket ?? connection.send)(
    createEvent("room.closed", {
      roomId: room.id,
      reason: "kicked",
    })
  );
  service.connectionRegistry.detach(connection);
};

const markPlayerAsKicked = (player: WhoIsFakerPlayerRecord) => {
  player.online = false;
  player.connectionId = undefined;
  player.membership = "kicked";
  player.isReady = false;
};

/**
 * 把这名玩家从当前回合的每一处引用中抹掉，并返回抹除后现场的回滚快照。
 * 快照必须在清理之后抄：补充发言被判定完成时，`supplement` 已经不在回合上了。
 */
const scrubPlayerFromRound = (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord,
  round: GameRound,
  playerId: string
): RoundPreservation => {
  clearPendingDisconnect(round, playerId);
  round.votes = round.votes.filter(
    (vote) => vote.voterId !== playerId && vote.targetId !== playerId
  );
  round.nightActions = round.nightActions.filter(
    (action) => action.actorId !== playerId && action.targetId !== playerId
  );
  round.descriptionOrder = round.descriptionOrder.filter(
    (descriptionPlayerId) => descriptionPlayerId !== playerId
  );
  round.descriptionSubmittedBy = round.descriptionSubmittedBy.filter(
    (submittedPlayerId) => submittedPlayerId !== playerId
  );

  if (round.tieBreak) {
    round.tieBreak.candidateIds = round.tieBreak.candidateIds.filter(
      (candidateId) => candidateId !== playerId
    );
    round.tieBreak.descriptionsDone = round.tieBreak.descriptionsDone.filter(
      (donePlayerId) => donePlayerId !== playerId
    );
    round.tieBreak.votes = round.tieBreak.votes.filter(
      (vote) => vote.voterId !== playerId && vote.targetId !== playerId
    );
  }

  if (round.supplement) {
    round.supplement.requestedPlayerIds = round.supplement.requestedPlayerIds.filter(
      (requestedPlayerId) => requestedPlayerId !== playerId
    );
    round.supplement.donePlayers = round.supplement.donePlayers.filter(
      (donePlayerId) => donePlayerId !== playerId
    );

    service.completeSupplementIfReady(room);
  }

  return {
    votes: [...round.votes],
    nightActions: round.nightActions.map((action) => ({ ...action })),
    tieBreak: round.tieBreak
      ? {
          ...round.tieBreak,
          candidateIds: [...round.tieBreak.candidateIds],
          descriptionsDone: [...round.tieBreak.descriptionsDone],
          votes: round.tieBreak.votes.map((vote) => ({ ...vote })),
        }
      : undefined,
    supplementActive: Boolean(round.supplement),
  };
};

/** 移除记录只留给仍在局的玩家：终局轮次与已出局的玩家都不再追加。 */
const recordRemovalHistory = (service: WhoIsFakerServiceInternals, ctx: ForcedRemovalContext) => {
  const round = ctx.room.round;
  if (!round?.assignments[ctx.player.id]?.alive || round.phase === "gameOver") return;

  round.history.push({
    kind: "removal",
    day: round.day,
    createdAt: service.now(),
    playerId: ctx.player.id,
    reason: toRemovalHistoryReason(ctx.reason),
  });
};

const toRemovalHistoryReason = (
  reason: string
): Extract<RoundHistoryEntry, { kind: "removal" }>["reason"] => {
  if (reason === "leave") return "left";
  if (reason === "timeout") return "timeout";
  if (reason === "掉线后被出题人移出") return "disconnected";
  return "kicked";
};

/**
 * 反馈阶段只记出局、不改阶段：去向在继续时按当时局面重新判定，
 * 也不让离场改写已经展示的结果（例如白板已经猜中）。
 */
const recordFeedbackElimination = (
  service: WhoIsFakerServiceInternals,
  ctx: ForcedRemovalContext,
  round: GameRound
) => {
  recordEliminations(round.assignments, [ctx.player.id], ctx.reason, service.now());
  if (round.feedbackContinuation?.type === "blankFailed") {
    round.feedbackContinuation.rosterChanged = true;
  }
  if (round.feedback && round.feedbackContinuation) {
    round.feedback.next = predictFeedbackNext(round, round.feedbackContinuation);
  }
};

/** 在场玩家出局分两条路：白板猜词者离场要作废猜词，其余玩家按恢复阶段回位。 */
const exitAlivePlayer = async (
  service: WhoIsFakerServiceInternals,
  ctx: ForcedRemovalContext,
  round: GameRound
): Promise<ForcedRemovalFlow> => {
  const isGuesser =
    round.phase === "blankGuess" && round.blankGuessContext?.playerId === ctx.player.id;

  if (isGuesser) {
    return await exitAsBlankGuesser(service, ctx, round);
  }

  await exitRosterMember(service, ctx, round);
  return "continue";
};

const exitAsBlankGuesser = async (
  service: WhoIsFakerServiceInternals,
  ctx: ForcedRemovalContext,
  round: GameRound
): Promise<ForcedRemovalFlow> => {
  const { deferredWinner, resumePhase } = round.blankGuessContext!;
  round.blankGuessContext = undefined;
  clearPhaseTimer(service, ctx.room);

  if (deferredWinner) {
    await finishRound(service, ctx.room, deferredWinner, "白板已离场，系统按残局条件结算");
    return "done";
  }

  const effectivePhase = resumePhase ?? "gameOver";
  const targetNextPhase =
    effectivePhase === "tieBreak" && (ctx.preserved.tieBreak?.candidateIds.length ?? 0) <= 1
      ? "night"
      : effectivePhase;

  await applyEliminationAndMove(service, ctx.room, [ctx.player.id], ctx.reason, targetNextPhase);

  // 淘汰可能已经决出胜负：只有回合仍在继续时才需要把清理掉的现场恢复回去。
  const liveRound = ctx.room.round;
  if (liveRound && !liveRound.summary) {
    restoreGuesserRound(liveRound, ctx.preserved, targetNextPhase);
  }
  service.appendSystemMessage(ctx.room, "白板已离场，本次猜词作废，游戏继续");
  return "continue";
};

const exitRosterMember = async (
  service: WhoIsFakerServiceInternals,
  ctx: ForcedRemovalContext,
  round: GameRound
) => {
  const previousPhase = round.phase;
  const resumePhase =
    previousPhase === "tieBreak" && (ctx.preserved.tieBreak?.candidateIds.length ?? 0) <= 1
      ? "night"
      : getResumePhaseAfterForcedRemoval(previousPhase);
  await applyEliminationAndMove(service, ctx.room, [ctx.player.id], ctx.reason, resumePhase);

  const liveRound = ctx.room.round;
  if (liveRound && !liveRound.summary) {
    restoreRosterRound(liveRound, ctx.preserved, resumePhase);
  }
};

const restoreGuesserRound = (
  round: GameRound,
  preserved: RoundPreservation,
  targetNextPhase: Exclude<WhoIsFakerPhase, "assigningQuestioner" | "wordSubmission">
) => {
  if (targetNextPhase === "voting" || preserved.supplementActive) {
    round.votes = preserved.votes ?? [];
  }
  if (targetNextPhase === "night") {
    round.nightActions = preserved.nightActions ?? [];
    round.tieBreak = undefined;
    round.speechMode = undefined;
  }
  if (targetNextPhase === "tieBreak" && preserved.tieBreak) {
    round.tieBreak = preserved.tieBreak;
    round.speechMode = preserved.tieBreak.stage === "description" ? "tieBreak" : undefined;
  }
  if (preserved.supplementActive) {
    round.phase = "description";
    round.speechMode = "supplement";
  }
};

const restoreRosterRound = (
  round: GameRound,
  preserved: RoundPreservation,
  resumePhase: Exclude<WhoIsFakerPhase, "assigningQuestioner" | "wordSubmission">
) => {
  if (resumePhase === "voting" || preserved.supplementActive) {
    round.votes = preserved.votes ?? [];
  }
  if (resumePhase === "night") {
    round.nightActions = preserved.nightActions ?? [];
  }
  if (resumePhase === "tieBreak" && preserved.tieBreak) {
    round.tieBreak = preserved.tieBreak;
    round.speechMode = preserved.tieBreak.stage === "description" ? "tieBreak" : undefined;
  }
  if (resumePhase === "blankGuess") {
    if (preserved.tieBreak) round.tieBreak = preserved.tieBreak;
    if (preserved.votes) round.votes = preserved.votes;
    if (preserved.nightActions) round.nightActions = preserved.nightActions;
  }
  if (preserved.supplementActive) {
    round.phase = "description";
    round.speechMode = "supplement";
  }
};

const finishForcedRemoval = async (
  service: WhoIsFakerServiceInternals,
  ctx: ForcedRemovalContext
) => {
  const room = ctx.room;
  service.reassignHost(room);
  normalizeRoomRoleConfig(room);
  service.touch(room);
  // 猜词的白板被移除后没人能推进阻塞阶段，必须就地收束。
  await resolveAbandonedBlankGuess(service, room);
  await service.maybeAbortRoundAfterRosterChange(room);
  // 移除玩家可能改变阶段或补充发言状态，其他掉线玩家的待决状态要跟着重算：
  // 否则推进会因「仍有玩家未提交」被拒，却没有人被要求处理那次掉线。
  requeuePendingDisconnects(service, room);

  await service.log({
    type: "player.kicked",
    createdAt: service.now(),
    roomId: room.id,
    playerId: ctx.playerId,
    payload: {
      reason: ctx.reason,
    },
  });
};

/**
 * 掉线玩家是否需要立刻暂停游戏、等出题人抉择。
 *
 * 判定标准是「当前阶段还在等这个人操作吗」：已经交过描述、投过票的玩家
 * 掉线不影响本阶段推进，暂停只会白等。这类玩家在下一个需要其操作的阶段
 * 由 requeuePendingDisconnects 重新入队。
 */
const shouldQueueDisconnectForDecision = (
  service: WhoIsFakerServiceInternals,
  round: GameRound,
  player: WhoIsFakerPlayerRecord
) => {
  if (player.membership !== "active") {
    return false;
  }

  // 这两个阶段还没有分配身份，也没有「已提交」的概念，只能一律暂停。
  if (round.phase === "assigningQuestioner" || round.phase === "wordSubmission") {
    return true;
  }

  if (!round.assignments[player.id]?.alive) {
    return false;
  }

  switch (round.phase) {
    case "description": {
      // 普通描述、补充发言与平票 PK 共用同一份发言状态，不另写判定。
      const speech = getCurrentSpeechState(round);
      if (!speech) return false;
      return speech.order.includes(player.id) && !speech.submittedPlayerIds.includes(player.id);
    }
    case "voting":
      return !round.votes.some((vote) => vote.voterId === player.id);
    case "tieBreak": {
      if (round.tieBreak?.stage === "description") {
        const speech = getCurrentSpeechState(round);
        if (!speech) return false;
        return speech.order.includes(player.id) && !speech.submittedPlayerIds.includes(player.id);
      }
      // PK 投票阶段候选人本人不投票，因此不必等他。
      if (round.tieBreak?.candidateIds.includes(player.id)) return false;
      return !(round.tieBreak?.votes ?? []).some((vote) => vote.voterId === player.id);
    }
    case "night": {
      const role = round.assignments[player.id]?.role;
      if (role !== "civilian" && role !== "undercover") return false;
      return !round.nightActions.some((action) => action.actorId === player.id);
    }
    case "blankGuess":
      // 只有正在猜词的白板本人会卡住这个阶段。
      return round.blankGuessContext?.playerId === player.id;
    default:
      return false;
  }
};

/**
 * 阶段推进后重新检查掉线玩家：上一阶段被放过的人，
 * 到了需要他操作的阶段就必须在这里补上暂停，否则会永远无人过问。
 */
export const requeuePendingDisconnects = (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord
) => {
  const round = room.round;

  if (!round || round.phase === "gameOver") {
    return;
  }

  round.pendingDisconnectPlayerIds = round.pendingDisconnectPlayerIds.filter((playerId) => {
    const player = room.players[playerId];
    return (
      player &&
      !player.online &&
      !player.isBot &&
      shouldQueueDisconnectForDecision(service, round, player)
    );
  });

  for (const player of Object.values(room.players)) {
    if (player.online || player.isBot) continue;
    if (round.pendingDisconnectPlayerIds.includes(player.id)) continue;
    // 出题人掉线走重连倒计时，不并入待抉择队列。
    if (round.questionerPlayerId === player.id) continue;
    if (!shouldQueueDisconnectForDecision(service, round, player)) continue;

    enqueuePendingDisconnect(round, player.id);
    broadcastRoomEvent(service, room, "game.disconnectDecisionRequested", {
      roomId: room.id,
      playerId: player.id,
    });
  }
};

const enqueuePendingDisconnect = (round: GameRound, playerId: string) => {
  if (!round.pendingDisconnectPlayerIds.includes(playerId)) {
    round.pendingDisconnectPlayerIds.push(playerId);
  }
};

export const clearPendingDisconnect = (round: GameRound, playerId: string) => {
  round.pendingDisconnectPlayerIds = round.pendingDisconnectPlayerIds.filter(
    (pendingPlayerId) => pendingPlayerId !== playerId
  );
};

const getResumePhaseAfterForcedRemoval = (
  phase: WhoIsFakerPhase
): Exclude<WhoIsFakerPhase, "assigningQuestioner" | "wordSubmission"> => {
  if (
    phase === "description" ||
    phase === "voting" ||
    phase === "tieBreak" ||
    phase === "night" ||
    phase === "blankGuess" ||
    phase === "gameOver"
  ) {
    return phase;
  }

  return "gameOver";
};
