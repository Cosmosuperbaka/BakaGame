import { AppError } from "../../domain/Errors";
import { createEvent } from "../../transport/Packets";
import { isRoleConfigSatisfied, recordEliminations } from "../../domain/Rules";
import {
  type GameRound,
  type RoundHistoryEntry,
  type WhoIsFakerPhase,
  type WhoIsFakerPlayerRecord,
  type WhoIsFakerRoomRecord,
} from "../../shared/Index";
import { QUESTIONER_RECONNECT_TIMEOUT_MS } from "../../config/Constants";
import {
  applyEliminationAndMove,
  predictFeedbackNext,
  resolveAbandonedBlankGuess,
  startFallbackBlankGuessTimer,
} from "./BlankGuess";
import { reassignHost } from "../room/HostPolicy";
import { markSeatOffline } from "../room/SeatBinding";
import { runBots } from "./dev/BotActors";
import { countOnline } from "../room/RoomSummaries";
import { finishRound } from "./PhaseFlow";
import { clearPhaseTimer, completeSupplementIfReady } from "./PhaseTimers";
import { broadcastRoomEvent, publishLobby, publishRoom } from "./RoomPublish";
import { closeRoom } from "./RoomClosure";
import {
  clearPendingDisconnect,
  enqueuePendingDisconnect,
  requeuePendingDisconnects,
  shouldQueueDisconnectForDecision,
} from "./PendingDisconnects";
import {
  getParticipantCount,
  hasValidQuestionerCandidate,
  normalizeRoomRoleConfig,
} from "./RoundRules";
import { requireRound, type WhoIsFakerSeatAt } from "./RoomAccess";
import type { WhoIsFakerContext } from "./Context";

/** 玩家离线的两种来源：连接断开与主动离开房间。 */
type PlayerOfflineReason = "disconnect" | "leave";

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

export const resolveDisconnect = async (
  ctx: WhoIsFakerContext,
  at: WhoIsFakerSeatAt,
  targetPlayerId: string,
  resolution: "wait" | "eliminate"
) => {
  // 只有出题人能决定掉线正式玩家是继续等待还是直接淘汰：出题人判定由命令表守卫完成，
  // 这里取出回合只为收窄类型。
  const { room, seat: player } = at;
  const round = requireRound(room);

  if (!round.pendingDisconnectPlayerIds.includes(targetPlayerId)) {
    throw new AppError("PLAYER_NOT_PENDING", "当前没有等待处理的掉线玩家");
  }
  clearPendingDisconnect(round, targetPlayerId);

  if (resolution === "eliminate") {
    await forceRemovePlayer(ctx, room, targetPlayerId, "掉线后被出题人移出");
  } else {
    ctx.appendSystemMessage(
      room,
      `${room.players[targetPlayerId]?.name ?? "玩家"} 的掉线状态已保留`
    );
    // 关键修复：若掉线者正是猜词中的白板，选择保留等待时挂载 60 秒倒计时兜底，超时自动按失败结算切回残局，杜绝死锁
    if (round.phase === "blankGuess" && round.blankGuessContext?.playerId === targetPlayerId) {
      startFallbackBlankGuessTimer(ctx, room, 60);
    }
  }

  ctx.touch(room);
  await ctx.log({
    type: "game.disconnect_resolved",
    createdAt: ctx.now(),
    roomId: room.id,
    playerId: player.id,
    payload: {
      targetPlayerId,
      resolution,
    },
  });

  publishRoom(ctx, room);
  await runBots(ctx, room);

  return { resolved: true };
};

export const handlePlayerOffline = async (
  ctx: WhoIsFakerContext,
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
  const flow: OfflineContext = {
    room,
    playerId,
    player,
    reason,
    wasHost: room.hostPlayerId === player.id,
  };

  markPlayerDisconnected(ctx, flow);

  if (!round || round.phase === "gameOver") {
    await settleOfflineOutsideRound(ctx, flow);
    return;
  }

  await settleOfflineInsideRound(ctx, flow, round);

  if (flow.wasHost && reason === "leave") {
    reassignHost(room, Object.values(room.players));
  }

  ctx.touch(room);
  await ctx.log({
    type: `player.${reason}`,
    createdAt: ctx.now(),
    roomId: room.id,
    playerId,
  });

  await publishOrCloseIfEmpty(ctx, room, reason);
};

/**
 * 标记离线并解绑连接；整房都没人在线时才起空房计时（测试房豁免），
 * 房主掉线时由内核给出重连截止时刻。
 */
const markPlayerDisconnected = (ctx: WhoIsFakerContext, flow: OfflineContext) => {
  markSeatOffline(ctx.seatContext, flow.room, flow.player, {
    emptyRoomExempt: !shouldAutoCloseWhenEmpty(ctx, flow.room),
  });
};

/** 局外掉线：显式离开的真人无条件移出房间，房主离开后重选房主。 */
const settleOfflineOutsideRound = async (ctx: WhoIsFakerContext, flow: OfflineContext) => {
  const room = flow.room;
  if (flow.reason === "leave" && !flow.player.isBot) {
    // 玩家显式离开时，无条件将其从房间列表中清理
    delete room.players[flow.player.id];
  }

  if (flow.wasHost && flow.reason === "leave") {
    // 离开者的席位已删除，房主指针悬空，按候选规则（在线正式玩家优先、同级按加入先后）重新选人。
    reassignHost(room, Object.values(room.players));
  }

  normalizeRoomRoleConfig(room);
  ctx.touch(room);
  await publishOrCloseIfEmpty(ctx, room, flow.reason);
};

/** 局内掉线：出题人显式离开即终止本局，其余按掉线淘汰决策处理。 */
const settleOfflineInsideRound = async (
  ctx: WhoIsFakerContext,
  flow: OfflineContext,
  round: GameRound
) => {
  if (flow.reason === "leave") {
    await removeLeavingPlayer(ctx, flow, round);
    return;
  }

  await queueOfflineDecision(ctx, flow, round);
};

/** 出题人主动退出直接终止本局，其余玩家按离开强制移出。 */
const removeLeavingPlayer = async (
  ctx: WhoIsFakerContext,
  flow: OfflineContext,
  round: GameRound
) => {
  const room = flow.room;
  const player = flow.player;
  if (round.questionerPlayerId === player.id) {
    await finishRound(ctx, room, "aborted", "出题人主动退出房间，本局已终止");
  } else {
    await forceRemovePlayer(ctx, room, player.id, "leave");
  }

  if (!player.isBot) {
    delete room.players[player.id];
  }
};

/** 出题人掉线留出重连窗口；其余玩家由全房决定是否进入淘汰投票。 */
const queueOfflineDecision = async (
  ctx: WhoIsFakerContext,
  flow: OfflineContext,
  round: GameRound
) => {
  const room = flow.room;
  const player = flow.player;
  if (round.questionerPlayerId === player.id) {
    round.questionerReconnectDeadlineAt = ctx.now() + QUESTIONER_RECONNECT_TIMEOUT_MS;
    ctx.appendSystemMessage(room, "出题人已掉线，系统开始等待其重新连接");
    return;
  }

  if (shouldQueueDisconnectForDecision(ctx, round, player)) {
    enqueuePendingDisconnect(round, player.id);
    broadcastRoomEvent(ctx, room, "game.disconnectDecisionRequested", {
      roomId: room.id,
      playerId: flow.playerId,
    });
  }
};

/** 显式离开可能让房间只剩空壳：空了就关房，否则照常广播快照与大厅。 */
const publishOrCloseIfEmpty = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  reason: PlayerOfflineReason
) => {
  if (reason === "leave" && countOnline(Object.values(room.players)) === 0) {
    await closeRoom(ctx, room, "empty");
    return;
  }

  publishRoom(ctx, room);
  publishLobby(ctx);
};

/**
 * 空房是否应当自动关闭。测试房间要能在最后一人刷新页面后仍然存在，
 * 否则每次刷新都会丢掉正在调试的房间状态。
 */
export const shouldAutoCloseWhenEmpty = (ctx: WhoIsFakerContext, room: WhoIsFakerRoomRecord) => {
  return !ctx.testRooms.isTestRoom(room.id);
};

export const forceRemovePlayer = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  playerId: string,
  reason: string
) => {
  // 强制移除既可能来自房主踢人，也可能来自掉线淘汰决策。
  const player = room.players[playerId];
  if (!player) {
    return;
  }

  sendKickNotice(ctx, room, player);
  markPlayerAsKicked(player);

  // 先清掉回合里的引用，再抄恢复现场要用的快照：补充发言可能正好在这次清理中被判定完成。
  const preserved: RoundPreservation = room.round
    ? scrubPlayerFromRound(ctx, room, room.round, player.id)
    : {};
  const flow: ForcedRemovalContext = { room, playerId, player, reason, preserved };

  recordRemovalHistory(ctx, flow);

  const round = room.round;
  if (round?.phase === "feedback" && round.assignments[player.id]?.alive) {
    recordFeedbackElimination(ctx, flow, round);
  } else if (round?.assignments[player.id]?.alive && round.phase !== "gameOver") {
    if ((await exitAlivePlayer(ctx, flow, round)) === "done") return;
  }

  await finishForcedRemoval(ctx, flow);
};

/** 被踢的一方要先收到房间关闭事件，连接与玩家的绑定随即解开。 */
const sendKickNotice = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  player: WhoIsFakerPlayerRecord
) => {
  const connection = ctx.connectionRegistry.findConnectionByPlayerId(player.id);
  if (!connection) return;

  (connection.sendPacket ?? connection.send)(
    createEvent("room.closed", {
      roomId: room.id,
      reason: "kicked",
    })
  );
  ctx.connectionRegistry.detach(connection);
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
  ctx: WhoIsFakerContext,
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

    completeSupplementIfReady(ctx, room);
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
const recordRemovalHistory = (ctx: WhoIsFakerContext, flow: ForcedRemovalContext) => {
  const round = flow.room.round;
  if (!round?.assignments[flow.player.id]?.alive || round.phase === "gameOver") return;

  round.history.push({
    kind: "removal",
    day: round.day,
    createdAt: ctx.now(),
    playerId: flow.player.id,
    reason: toRemovalHistoryReason(flow.reason),
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
  ctx: WhoIsFakerContext,
  flow: ForcedRemovalContext,
  round: GameRound
) => {
  recordEliminations(round.assignments, [flow.player.id], flow.reason, ctx.now());
  if (round.feedbackContinuation?.type === "blankFailed") {
    round.feedbackContinuation.rosterChanged = true;
  }
  if (round.feedback && round.feedbackContinuation) {
    round.feedback.next = predictFeedbackNext(round, round.feedbackContinuation);
  }
};

/** 在场玩家出局分两条路：白板猜词者离场要作废猜词，其余玩家按恢复阶段回位。 */
const exitAlivePlayer = async (
  ctx: WhoIsFakerContext,
  flow: ForcedRemovalContext,
  round: GameRound
): Promise<ForcedRemovalFlow> => {
  const isGuesser =
    round.phase === "blankGuess" && round.blankGuessContext?.playerId === flow.player.id;

  if (isGuesser) {
    return await exitAsBlankGuesser(ctx, flow, round);
  }

  await exitRosterMember(ctx, flow, round);
  return "continue";
};

const exitAsBlankGuesser = async (
  ctx: WhoIsFakerContext,
  flow: ForcedRemovalContext,
  round: GameRound
): Promise<ForcedRemovalFlow> => {
  const { deferredWinner, resumePhase } = round.blankGuessContext!;
  round.blankGuessContext = undefined;
  clearPhaseTimer(ctx, flow.room);

  if (deferredWinner) {
    await finishRound(ctx, flow.room, deferredWinner, "白板已离场，系统按残局条件结算");
    return "done";
  }

  const effectivePhase = resumePhase ?? "gameOver";
  const targetNextPhase =
    effectivePhase === "tieBreak" && (flow.preserved.tieBreak?.candidateIds.length ?? 0) <= 1
      ? "night"
      : effectivePhase;

  await applyEliminationAndMove(ctx, flow.room, [flow.player.id], flow.reason, targetNextPhase);

  // 淘汰可能已经决出胜负：只有回合仍在继续时才需要把清理掉的现场恢复回去。
  const liveRound = flow.room.round;
  if (liveRound && !liveRound.summary) {
    restoreGuesserRound(liveRound, flow.preserved, targetNextPhase);
  }
  ctx.appendSystemMessage(flow.room, "白板已离场，本次猜词作废，游戏继续");
  return "continue";
};

const exitRosterMember = async (
  ctx: WhoIsFakerContext,
  flow: ForcedRemovalContext,
  round: GameRound
) => {
  const previousPhase = round.phase;
  const resumePhase =
    previousPhase === "tieBreak" && (flow.preserved.tieBreak?.candidateIds.length ?? 0) <= 1
      ? "night"
      : getResumePhaseAfterForcedRemoval(previousPhase);
  await applyEliminationAndMove(ctx, flow.room, [flow.player.id], flow.reason, resumePhase);

  const liveRound = flow.room.round;
  if (liveRound && !liveRound.summary) {
    restoreRosterRound(liveRound, flow.preserved, resumePhase);
    // 平票候选不足改入夜晚时阶段变了：原阶段的倒计时不能留在快照里。
    if (liveRound.phase !== previousPhase) clearPhaseTimer(ctx, flow.room);
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

/** 名册变动后，开局前的两个阶段若人数已不够，系统取消本局。 */
const maybeAbortRoundAfterRosterChange = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord
) => {
  const round = room.round;

  if (!round || round.phase === "gameOver") {
    return;
  }

  if (round.phase === "assigningQuestioner") {
    if (!hasValidQuestionerCandidate(room)) {
      await finishRound(ctx, room, "aborted", "当前人数不足，系统已取消本局");
    }
    return;
  }

  if (round.phase === "wordSubmission" && round.questionerPlayerId) {
    const satisfied = isRoleConfigSatisfied(
      room.settings.roleConfig,
      getParticipantCount(room, round.questionerPlayerId)
    );
    if (!satisfied) {
      await finishRound(ctx, room, "aborted", "当前人数不足，系统已取消本局");
    }
  }
};

const finishForcedRemoval = async (ctx: WhoIsFakerContext, flow: ForcedRemovalContext) => {
  const room = flow.room;
  reassignHost(room, Object.values(room.players));
  normalizeRoomRoleConfig(room);
  ctx.touch(room);
  // 猜词的白板被移除后没人能推进阻塞阶段，必须就地收束。
  await resolveAbandonedBlankGuess(ctx, room);
  await maybeAbortRoundAfterRosterChange(ctx, room);
  // 移除玩家可能改变阶段或补充发言状态，其他掉线玩家的待决状态要跟着重算：
  // 否则推进会因「仍有玩家未提交」被拒，却没有人被要求处理那次掉线。
  requeuePendingDisconnects(ctx, room);

  await ctx.log({
    type: "player.kicked",
    createdAt: ctx.now(),
    roomId: room.id,
    playerId: flow.playerId,
    payload: {
      reason: flow.reason,
    },
  });
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
