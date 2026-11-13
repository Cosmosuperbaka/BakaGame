import { createEvent } from "../../transport/Packets";
import {
  getWinnerAfterBlankFailure,
  isRoleConfigSatisfied,
  recordEliminations,
} from "../../domain/Rules";
import {
  type GameRound,
  type RoundHistoryEntry,
  type WhoIsFakerPhase,
  type WhoIsFakerPlayerRecord,
  type WhoIsFakerRoomRecord,
} from "../../shared/Index";
import { resolveAbandonedBlankGuess } from "./BlankGuess";
import { predictFeedbackNext, settleOutcome } from "./Feedback";
import { publishRoom } from "./RoomPublish";
import { reassignHost } from "../room/HostPolicy";
import { clearPendingDisconnect, requeuePendingDisconnects } from "./PendingDisconnects";
import { clearPhaseTimer, completeSupplementIfReady } from "./PhaseTimers";
import { finishRound } from "./RoundSettlement";
import {
  getParticipantCount,
  hasValidQuestionerCandidate,
  normalizeRoomRoleConfig,
} from "./RoundRules";
import type { WhoIsFakerContext } from "./Context";

/** 强制移除的上下文：踢人通知、出局结算与收尾日志共用。 */
type ForcedRemovalContext = {
  room: WhoIsFakerRoomRecord;
  playerId: string;
  player: WhoIsFakerPlayerRecord;
  reason: string;
  /** 抹除引用之后，回合上是否仍有没补完的补充发言（补充可能正好在这次抹除中被判定完成）。 */
  supplementActive: boolean;
};

/** 出局后回到的阶段：开局前的两个阶段没有出局的概念，不在其内。 */
type ResumePhase = Exclude<WhoIsFakerPhase, "assigningQuestioner" | "wordSubmission">;

/** 白板猜词者离场可能当场终局，此时必须跳过踢人收尾与日志。 */
type ForcedRemovalFlow = "continue" | "done";

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

  // 先清掉回合里的引用：补充发言可能正好在这次清理中被判定完成，是否仍在补充要在清理之后看。
  const supplementActive = room.round
    ? scrubPlayerFromRound(ctx, room, room.round, player.id)
    : false;
  const flow: ForcedRemovalContext = { room, playerId, player, reason, supplementActive };

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
 * 把这名玩家从当前回合的每一处引用中抹掉，返回抹除之后补充发言是否仍在进行。
 * 要在清理之后看：补充发言被判定完成时，`supplement` 已经不在回合上了。
 */
const scrubPlayerFromRound = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound,
  playerId: string
): boolean => {
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

  return Boolean(round.supplement);
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
    effectivePhase === "tieBreak" && (round.tieBreak?.candidateIds.length ?? 0) <= 1
      ? "night"
      : effectivePhase;

  await eliminateAndSettle(ctx, flow, round, targetNextPhase);
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
    previousPhase === "tieBreak" && (round.tieBreak?.candidateIds.length ?? 0) <= 1
      ? "night"
      : getResumePhaseAfterForcedRemoval(previousPhase);
  await eliminateAndSettle(ctx, flow, round, resumePhase);

  // 平票候选不足改入夜晚时阶段变了：原阶段的倒计时不能留在快照里。
  if (!round.summary && round.phase !== previousPhase) clearPhaseTimer(ctx, flow.room);
};

/**
 * 记淘汰并决定结算去向：先把这名玩家记为出局并发布一次快照，再判残局猜词与胜负。
 * 局面没有分出结果时，回合就留在（或回到）`resumePhase`，只清掉那个阶段用不到的临时容器，
 * 抹除引用之后留下的投票、夜晚行动与平票状态原样保留，不再先清空整个回合再从快照恢复。
 */
const eliminateAndSettle = async (
  ctx: WhoIsFakerContext,
  flow: ForcedRemovalContext,
  round: GameRound,
  resumePhase: ResumePhase
) => {
  recordEliminations(round.assignments, [flow.player.id], flow.reason, ctx.now());
  publishRoom(ctx, flow.room);

  // 白板猜词未决（含已提交待裁定）：已有的猜词上下文原样保留，草稿与待裁定标记都不丢；
  // 残局成立就只在它上面补写预定胜者，猜完无论对错都按预定胜者结算，不回被打断的阶段，
  // 白板也不必重新猜。
  const guessing = round.phase === "blankGuess" ? round.blankGuessContext : undefined;
  if (guessing) {
    const winner = getWinnerAfterBlankFailure(round.assignments);
    if (winner) guessing.deferredWinner = winner;
    return;
  }

  // 已经结算则到此为止；进了残局猜词（只可能从没有猜词的阶段进入）：白板猜词优先，阶段不动，
  // 被它打断的补充发言、平票加赛、投票与夜晚行动原样留着，等猜词收束后走恢复路径回去，
  // 发言模式也不写成被打断阶段的模式。
  if ((await settleOutcome(ctx, flow.room)) !== "open") return;

  round.phase = resumePhase;
  round.speechMode =
    resumePhase === "description"
      ? flow.supplementActive
        ? "supplement"
        : "normal"
      : resumePhase === "tieBreak" && round.tieBreak
        ? round.tieBreak.stage === "description"
          ? "tieBreak"
          : undefined
        : undefined;
  if (!(resumePhase === "voting" || flow.supplementActive)) round.votes = [];
  if (resumePhase !== "night") round.nightActions = [];
  if (resumePhase !== "tieBreak") round.tieBreak = undefined;
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
