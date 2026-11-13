import {
  getWinnerAfterBlankFailure,
  recordEliminations,
  shouldEnterFinalBlankGuess,
} from "../../domain/Rules";
import type {
  FeedbackContinuation,
  FeedbackNext,
  GameRound,
  RoundFeedback,
  WhoIsFakerPhase,
  WhoIsFakerRoomRecord,
} from "../../shared/Index";
import { clearPhaseTimer } from "./PhaseTimers";
import { publishRoom } from "./RoomPublish";
import { finishRound } from "./RoundSettlement";
import { requireRound } from "./RoomAccess";
import type { WhoIsFakerContext } from "./Context";

export const tryTransitionToFinaleBlankGuess = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord
): boolean => {
  // 被淘汰不自动触发猜词：白板自己决定何时用掉这一次机会（game.enterBlankGuess）。
  // 这里只保留「残局触发」：其他阵营已满足胜负条件但白板仍存活时，
  // 在结算前强制补一次猜词。
  const round = requireRound(room);
  const finalBlankGuess = shouldEnterFinalBlankGuess(round);

  if (finalBlankGuess.shouldGuess && finalBlankGuess.blankPlayerId) {
    round.phase = "blankGuess";
    round.speechMode = undefined;
    round.blankGuessContext = {
      playerId: finalBlankGuess.blankPlayerId,
      reason: "finale",
      resumePhase: "gameOver",
      deferredWinner: finalBlankGuess.deferredWinner,
    };
    return true;
  }

  // 白板被淘汰但残局条件未触发：继续正常流程；死亡白板不再拥有主动猜词入口。
  return false;
};

export const applyEliminationAndMove = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  eliminatedIds: string[],
  reason: string,
  nextPhase: Exclude<WhoIsFakerPhase, "assigningQuestioner" | "wordSubmission">
) => {
  // 所有“有人出局”的阶段都汇总到这里，统一做淘汰、白板插入和胜负判断。
  const round = requireRound(room);

  if (eliminatedIds.length > 0) {
    recordEliminations(round.assignments, eliminatedIds, reason, ctx.now());
    // 保持当前阶段推送一次淘汰后的快照，再进入白板残局或游戏结算。
    publishRoom(ctx, room);
  }

  if (tryTransitionToFinaleBlankGuess(ctx, room)) {
    return;
  }

  const winner = getWinnerAfterBlankFailure(round.assignments);

  if (winner) {
    await finishRound(ctx, room, winner, "阶段结算后已满足胜利条件");
    return;
  }

  round.phase = nextPhase;
  round.speechMode = nextPhase === "description" ? "normal" : undefined;
  round.tieBreak = undefined;
  round.votes = [];
  round.nightActions = [];
};

/**
 * 进入阶段反馈：结算结果已经落地（出局已记录），停在这里展示给全房，
 * 出题人继续后才执行 `continuation`。决出胜负时同样先反馈、继续后再结算。
 */
export const enterFeedback = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  feedback: Omit<RoundFeedback, "next">,
  continuation: FeedbackContinuation
) => {
  const round = requireRound(room);
  clearPhaseTimer(ctx, room);
  round.phase = "feedback";
  round.speechMode = undefined;
  round.feedbackContinuation = continuation;
  round.feedback = { ...feedback, next: predictFeedbackNext(round, continuation) };
};

/** 预告继续后的去向，只用于展示；真正的去向在继续时按当时局面重新判定。 */
export const predictFeedbackNext = (
  round: GameRound,
  continuation: FeedbackContinuation
): FeedbackNext => {
  if (continuation.type === "finish") {
    return "gameOver";
  }

  if (continuation.type === "blankFailed") {
    const context = round.blankGuessContext;
    if (
      !context ||
      context.deferredWinner ||
      (continuation.rosterChanged && getWinnerAfterBlankFailure(round.assignments))
    ) {
      return "gameOver";
    }
    return context.resumePhase ?? "gameOver";
  }

  if (shouldEnterFinalBlankGuess(round).shouldGuess) {
    return "blankGuess";
  }

  if (getWinnerAfterBlankFailure(round.assignments)) {
    return "gameOver";
  }

  if (continuation.type === "tieBreak") {
    return getLiveTieBreakCandidates(round, continuation.candidateIds) ? "tieBreak" : "night";
  }

  return continuation.to === "night" ? "night" : "description";
};

/** 平票候选按继续时仍存活的人重算；原本多人 PK 只剩一人时 PK 失去意义，改为直接入夜。 */
const getLiveTieBreakCandidates = (
  round: GameRound,
  candidateIds: string[]
): string[] | undefined => {
  const alive = candidateIds.filter((id) => round.assignments[id]?.alive);
  return alive.length > 1 || (alive.length === 1 && candidateIds.length === 1) ? alive : undefined;
};

/** 平票续接：候选仍够才新开一轮 PK，不足则直接入夜。 */
export const applyTieBreakContinuation = (
  round: GameRound,
  continuation: Extract<FeedbackContinuation, { type: "tieBreak" }>
) => {
  const candidateIds = getLiveTieBreakCandidates(round, continuation.candidateIds);
  if (!candidateIds) {
    round.phase = "night";
    round.speechMode = undefined;
    return;
  }
  round.tieBreakCount += 1;
  round.phase = "tieBreak";
  round.speechMode = "tieBreak";
  round.tieBreak = {
    candidateIds,
    stage: "description",
    descriptionsDone: [],
    votes: [],
  };
};
