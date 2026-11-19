import { AppError } from "../../domain/Errors";
import {
  computeVoteOutcome,
  getWinnerAfterBlankFailure,
  recordEliminations,
  resolveNightEliminations,
} from "../../domain/Rules";
import type { WhoIsFakerRoomRecord } from "../../shared/Index";
import { continueAfterBlankFailure } from "./BlankGuess";
import {
  applyTieBreakContinuation,
  enterFeedback,
  tryTransitionToFinaleBlankGuess,
} from "./Feedback";
import { finishRound } from "./RoundSettlement";
import { createDescriptionOrder, getAliveAssignedPlayerIds } from "./RoundRules";
import { requireRound } from "./RoomAccess";
import type { WhoIsFakerContext } from "./Context";

/** 投票判定的结果：本轮出局的人，或进入平票 PK 的候选人（二者至多有一个非空）。 */
export type VoteDecision = {
  eliminatedIds: string[];
  tieBreakCandidateIds: string[] | undefined;
};

/**
 * 由票型与在场人数判定本轮出局还是进平票 PK，不碰房间状态。
 * `aliveCount` 是在场玩家数：首轮平票时只有存在非候选玩家可在第二轮投票，才进平票 PK。
 */
export const decideVoteResult = (
  tieBreak: boolean,
  outcome: ReturnType<typeof computeVoteOutcome>,
  aliveCount: number
): VoteDecision => {
  const leaders = outcome.leaders;
  let eliminatedIds: string[] = [];
  let tieBreakCandidateIds: string[] | undefined;

  if (!tieBreak) {
    if (leaders.length > 0 && (leaders.length > 1 || outcome.abstainCount >= outcome.maxVotes)) {
      // 平票或弃票数达到最高票：若非全员平票（有非候选玩家可在第二轮投票），则进入平票PK；
      // 全员平票则无人出局，直接入夜。
      if (leaders.length < aliveCount) {
        tieBreakCandidateIds = [...leaders];
      }
    } else if (leaders.length === 1) {
      eliminatedIds = [leaders[0]];
    }
    // 全员弃票或无得票者：无人出局
  } else if (
    leaders.length === 1 &&
    outcome.maxVotes > 0 &&
    outcome.abstainCount < outcome.maxVotes
  ) {
    // 第二轮平票PK投票：仅当产生单一最高票时淘汰该玩家，再次平票或全员弃票则无人出局
    eliminatedIds = [leaders[0]];
  }

  return { eliminatedIds, tieBreakCandidateIds };
};

export const resolveVoting = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  tieBreak: boolean
) => {
  // 投票结算：出局立即落地并进入反馈，胜负与下一阶段留到出题人继续时统一判定。
  const round = requireRound(room);
  const votes = (tieBreak ? (round.tieBreak?.votes ?? []) : round.votes).map((vote) => ({
    ...vote,
  }));
  round.voteHistory.push({
    day: round.day,
    tieBreak,
    votes: votes.map((vote) => ({ ...vote })),
  });
  const aliveIds = getAliveAssignedPlayerIds(ctx, room);
  const outcome = computeVoteOutcome(votes);
  const leaders = outcome.leaders;

  await ctx.log({
    type: "game.vote_resolved",
    createdAt: ctx.now(),
    roomId: room.id,
    payload: {
      tieBreak,
      leaders,
      counts: outcome.counts,
    },
  });

  const { eliminatedIds, tieBreakCandidateIds } = decideVoteResult(
    tieBreak,
    outcome,
    aliveIds.length
  );

  if (eliminatedIds.length > 0) {
    recordEliminations(
      round.assignments,
      eliminatedIds,
      tieBreak ? "平票再次出局" : "投票出局",
      ctx.now()
    );
  }

  round.history.push({
    kind: "vote",
    day: round.day,
    createdAt: ctx.now(),
    tieBreak: tieBreak || undefined,
    votes: votes.map((vote) => ({ ...vote })),
    eliminatedPlayerIds: [...eliminatedIds],
    tieBreakCandidateIds: tieBreakCandidateIds ? [...tieBreakCandidateIds] : undefined,
  });

  round.votes = [];
  round.tieBreak = undefined;
  enterFeedback(
    ctx,
    room,
    {
      kind: "vote",
      day: round.day,
      tieBreak: tieBreak || undefined,
      votes,
      eliminatedPlayerIds: eliminatedIds,
      tieBreakCandidateIds,
    },
    tieBreakCandidateIds
      ? { type: "tieBreak", candidateIds: tieBreakCandidateIds }
      : { type: "advance", to: "night", winnerReason: "阶段结算后已满足胜利条件" }
  );
};

export const resolveNight = async (ctx: WhoIsFakerContext, room: WhoIsFakerRoomRecord) => {
  // 夜晚结算：出局立即落地并进入天亮反馈（只公开死者，不公开凶手），
  // 白板残局猜词与胜负留到出题人继续时判定。
  const round = requireRound(room);
  const actions = round.nightActions.map((action) => ({
    actorId: action.actorId,
    actorRole: action.actorRole,
    targetId: action.targetId,
  }));

  const eliminatedIds = resolveNightEliminations(round.nightActions);

  if (eliminatedIds.length > 0) {
    recordEliminations(round.assignments, eliminatedIds, "夜晚结算", ctx.now());
  }

  round.history.push({
    kind: "night",
    day: round.day,
    createdAt: ctx.now(),
    actions,
    eliminatedPlayerIds: [...eliminatedIds],
  });

  await ctx.log({
    type: "game.night_resolved",
    createdAt: ctx.now(),
    roomId: room.id,
    payload: {
      eliminatedIds,
    },
  });

  round.nightActions = [];
  enterFeedback(
    ctx,
    room,
    { kind: "night", day: round.day, eliminatedPlayerIds: eliminatedIds },
    { type: "advance", to: "daybreak", winnerReason: "夜晚结算后已满足胜利条件" }
  );
};

/** 出题人在反馈阶段点继续：执行结算时存下的续接动作。 */
export const applyFeedbackContinuation = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord
) => {
  const round = requireRound(room);
  const continuation = round.feedbackContinuation;

  if (!continuation) {
    throw new AppError("INVALID_PHASE", "当前反馈没有可继续的结果");
  }

  round.feedback = undefined;
  round.feedbackContinuation = undefined;

  if (continuation.type === "finish") {
    await finishRound(ctx, room, continuation.winner, continuation.reason);
    return;
  }

  if (continuation.type === "blankFailed") {
    await continueAfterBlankFailure(ctx, room, round, continuation);
    return;
  }

  if (tryTransitionToFinaleBlankGuess(ctx, room)) {
    return;
  }

  const winner = getWinnerAfterBlankFailure(round.assignments);

  if (winner) {
    await finishRound(
      ctx,
      room,
      winner,
      continuation.type === "advance" ? continuation.winnerReason : "阶段结算后已满足胜利条件"
    );
    return;
  }

  round.votes = [];
  round.nightActions = [];
  round.tieBreak = undefined;

  if (continuation.type === "tieBreak") {
    applyTieBreakContinuation(round, continuation);
    return;
  }

  if (continuation.to === "night") {
    round.phase = "night";
    round.speechMode = undefined;
    return;
  }

  // 天亮：进入下一天的描述。
  round.phase = "description";
  round.speechMode = "normal";
  round.day += 1;
  round.descriptionCycle += 1;
  round.descriptionOrder = createDescriptionOrder(ctx, room);
  round.descriptionSubmittedBy = [];
  round.supplement = undefined;
};
