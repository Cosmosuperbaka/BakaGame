import { AppError } from "../../domain/Errors";
import {
  evaluateBlankGuess,
  evaluateBlankGuessDraft,
  getWinnerAfterBlankFailure,
  recordEliminations,
  shouldEnterFinalBlankGuess,
} from "../../domain/Rules";
import type {
  BlankGuessRecord,
  FeedbackContinuation,
  FeedbackNext,
  GameRound,
  PhaseTimerState,
  RoundFeedback,
  WhoIsFakerPhase,
  WhoIsFakerRoomRecord,
} from "../../shared/Index";
import { runBots } from "./dev/BotActors";
import { broadcastPhaseAndPublish, requeuePendingDisconnects } from "./PendingDisconnects";
import { armPhaseTimer, clearPhaseTimer, finishRound, restoreInterruptedTimer } from "./PhaseFlow";
import { publishRoom } from "./RoomPublish";
import { ensurePhaseNotBlocked } from "./RoundRules";
import { requireRound, type WhoIsFakerSeatAt } from "./RoomAccess";
import type { WhoIsFakerContext } from "./Context";

export const submitBlankGuess = async (
  ctx: WhoIsFakerContext,
  at: WhoIsFakerSeatAt,
  words: [string, string]
) => {
  // 白板可以主动猜，也可以在被动 blankGuess 阶段猜，但总次数只有一次。
  const { room, seat: player } = at;
  const round = requireRound(room);
  const state = round.assignments[player.id];

  if (!state || state.role !== "blank") {
    throw new AppError("ACTION_FORBIDDEN", "只有白板可以猜词");
  }

  if (!state.alive) {
    throw new AppError("ACTION_FORBIDDEN", "白板出局后不能再猜词");
  }

  if (round.blankGuessUsed) {
    throw new AppError("BLANK_GUESS_USED", "白板已经使用过猜词机会");
  }

  // 猜词已改为阻塞阶段：必须先进入 blankGuess，且只有本人能提交。
  if (round.phase !== "blankGuess" || round.blankGuessContext?.playerId !== player.id) {
    throw new AppError("ACTION_FORBIDDEN", "当前不能进行白板猜词");
  }

  if (round.blankGuessContext.pendingReview) {
    throw new AppError("ACTION_FORBIDDEN", "本次猜词正在等待主持人裁定");
  }

  const guess = evaluateBlankGuess(round, words, ctx.now(), round.blankGuessContext.reason);

  // 机会在提交这一刻就消耗掉，裁定只决定这一次算不算猜中。
  round.blankGuessUsed = true;
  round.blankGuessRecords.push(guess);
  ctx.touch(room);

  await ctx.log({
    type: "game.blank_guess_submitted",
    createdAt: ctx.now(),
    roomId: room.id,
    playerId: player.id,
    payload: {
      success: guess.success,
    },
  });

  if (guess.success) {
    enterBlankGuessFeedback(ctx, room, guess, false, {
      type: "finish",
      winner: "blank",
      reason: "白板猜中全部词语，获得胜利",
    });
  } else {
    // 自动比对只认完全一致。细微差异交由主持人裁定，阶段继续阻塞。
    round.blankGuessContext.pendingReview = { words: guess.guessedWords };
    round.blankGuessContext.draft = guess.guessedWords;
    ctx.appendSystemMessage(room, `${player.name} 的猜词未完全匹配，等待主持人裁定`);
  }

  publishRoom(ctx, room);
  await runBots(ctx, room);

  return { success: guess.success, pendingReview: !guess.success };
};

export const enterBlankGuess = async (ctx: WhoIsFakerContext, at: WhoIsFakerSeatAt) => {
  // 白板主动猜词：先把房间切进阻塞阶段，其他人一起等这一次猜词。
  const { room, seat: player } = at;
  const round = requireRound(room);
  const state = round.assignments[player.id];

  if (!state || state.role !== "blank") {
    throw new AppError("ACTION_FORBIDDEN", "只有白板可以猜词");
  }

  if (!state.alive) {
    throw new AppError("ACTION_FORBIDDEN", "白板出局后不能再猜词");
  }

  if (round.blankGuessUsed) {
    throw new AppError("BLANK_GUESS_USED", "白板已经使用过猜词机会");
  }

  if (round.phase === "blankGuess") {
    throw new AppError("INVALID_PHASE", "已经处于白板猜词阶段");
  }

  // 只有已经发过词、且还没结算的阶段才能中途插入猜词。
  const resumePhase = round.phase;

  if (
    resumePhase !== "description" &&
    resumePhase !== "voting" &&
    resumePhase !== "tieBreak" &&
    resumePhase !== "night"
  ) {
    throw new AppError("INVALID_PHASE", "当前阶段不能进入白板猜词");
  }

  ensurePhaseNotBlocked(round);

  // 暂存被打断阶段的剩余倒计时毫秒数
  const timerState = round.phaseTimer;
  const remainingTimerMs =
    timerState && timerState.endsAt > ctx.now()
      ? Math.max(1_000, timerState.endsAt - ctx.now())
      : undefined;

  clearPhaseTimer(ctx, room);
  round.blankGuessContext = {
    playerId: player.id,
    reason: "active",
    resumePhase,
    interruptedRemainingTimerMs: remainingTimerMs,
  };
  round.phase = "blankGuess";
  round.speechMode = undefined;

  ctx.touch(room);
  ctx.appendSystemMessage(room, `${player.name} 发起了白板猜词`);

  await ctx.log({
    type: "game.blank_guess_entered",
    createdAt: ctx.now(),
    roomId: room.id,
    playerId: player.id,
    payload: { reason: "active" },
  });

  broadcastPhaseAndPublish(ctx, room);
  return { phase: round.phase };
};

export const updateBlankGuessDraft = async (
  ctx: WhoIsFakerContext,
  at: WhoIsFakerSeatAt,
  words: [string, string]
) => {
  // 猜词过程本身是这一阶段的看点，草稿实时广播给全房。
  const { room, seat: player } = at;
  const round = requireRound(room);

  if (round.phase !== "blankGuess" || round.blankGuessContext?.playerId !== player.id) {
    throw new AppError("ACTION_FORBIDDEN", "当前不能更新猜词内容");
  }

  if (round.blankGuessContext.pendingReview) {
    throw new AppError("ACTION_FORBIDDEN", "本次猜词正在等待主持人裁定");
  }

  round.blankGuessContext.draft = words;
  ctx.touch(room);
  publishRoom(ctx, room);
  return { updated: true };
};

export const reviewBlankGuess = async (
  ctx: WhoIsFakerContext,
  at: WhoIsFakerSeatAt,
  approve: boolean
) => {
  // 自动比对只认完全一致，主持人在此纠正细微差异导致的误判。
  // 出题人判定已由命令表守卫完成，这里取出回合只为收窄类型。
  const { room, seat: player } = at;
  const round = requireRound(room);

  const pending = round.blankGuessContext?.pendingReview;

  if (round.phase !== "blankGuess" || !pending) {
    throw new AppError("ACTION_FORBIDDEN", "当前没有待裁定的白板猜词");
  }

  const record = round.blankGuessRecords.at(-1);

  if (!record) {
    throw new AppError("ACTION_FORBIDDEN", "当前没有待裁定的白板猜词");
  }

  clearPhaseTimer(ctx, room);
  round.blankGuessContext!.pendingReview = undefined;

  await ctx.log({
    type: "game.blank_guess_reviewed",
    createdAt: ctx.now(),
    roomId: room.id,
    playerId: player.id,
    payload: { approve },
  });

  if (approve) {
    record.success = true;
    record.approvedByQuestioner = true;
  }
  enterBlankGuessFeedback(
    ctx,
    room,
    record,
    true,
    approve
      ? { type: "finish", winner: "blank", reason: "白板猜词经主持人判定有效，获得胜利" }
      : { type: "blankFailed", message: "白板猜词未通过，游戏继续" }
  );

  ctx.touch(room);
  requeuePendingDisconnects(ctx, room);
  broadcastPhaseAndPublish(ctx, room);
  await runBots(ctx, room);

  return { approved: approve };
};

export const startFallbackBlankGuessTimer = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  durationSeconds = 60
): void => {
  const round = room.round;
  if (!round || round.phase !== "blankGuess") return;
  clearPhaseTimer(ctx, room);
  const endsAt = ctx.now() + durationSeconds * 1000;
  const timerState: PhaseTimerState = {
    durationSeconds,
    endsAt,
    phase: "blankGuess",
    // 平票 PK 中打断猜词时 round.tieBreak 仍保留，守卫比对的是调度时刻捕获的这几项。
    speechMode: round.speechMode,
    tieBreakStage: round.tieBreak?.stage,
  };
  round.phaseTimer = timerState;
  armPhaseTimer(ctx, room, timerState, durationSeconds * 1000);
};

/** 白板猜词超时：没有猜词上下文时什么都不做。 */
export const timeoutBlankGuessPhase = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound
): Promise<void> => {
  const blankContext = round.blankGuessContext;
  if (!blankContext) return;
  await settleBlankGuessTimeout(ctx, room, round, blankContext);
  ctx.touch(room);
  requeuePendingDisconnects(ctx, room);
  broadcastPhaseAndPublish(ctx, room);
  await runBots(ctx, room);
};

/** 裁定「待复核」与「提交草稿」两条路：复核超时按猜错继续，草稿超时按当前草稿直接结算。 */
const settleBlankGuessTimeout = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound,
  blankContext: NonNullable<GameRound["blankGuessContext"]>
): Promise<void> => {
  const pendingRecord = blankContext.pendingReview ? round.blankGuessRecords.at(-1) : undefined;
  if (blankContext.pendingReview && pendingRecord) {
    enterBlankGuessFeedback(ctx, room, pendingRecord, true, {
      type: "blankFailed",
      message: "白板猜词裁定超时未通过，游戏继续",
    });
  } else if (blankContext.pendingReview) {
    blankContext.pendingReview = undefined;
    await resolveFailedBlankGuess(ctx, room, "白板猜词裁定超时未通过，游戏继续");
  } else {
    const guess = evaluateBlankGuessDraft(
      round,
      blankContext.draft ?? ["", ""],
      ctx.now(),
      blankContext.reason
    );
    round.blankGuessUsed = true;
    round.blankGuessRecords.push(guess);
    enterBlankGuessFeedback(
      ctx,
      room,
      guess,
      false,
      guess.success
        ? { type: "finish", winner: "blank", reason: "白板猜中全部词语，获得胜利" }
        : { type: "blankFailed", message: "白板猜词超时失败，游戏继续" }
    );
  }
};

const resolveFailedBlankGuess = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  message: string
) => {
  const round = requireRound(room);
  const context = round.blankGuessContext;
  if (!context) return;
  if (context.deferredWinner) {
    await finishRound(ctx, room, context.deferredWinner, "白板猜词失败，系统按残局条件结算");
    return;
  }
  if (context.resumePhase) {
    round.phase = context.resumePhase;
    round.blankGuessContext = undefined;
    // 补充与 PK 上下文在打断期间保留，恢复时从这些真相源派生发言模式。
    round.speechMode =
      round.phase === "description"
        ? round.supplement
          ? "supplement"
          : "normal"
        : round.phase === "tieBreak" && round.tieBreak?.stage === "description"
          ? "tieBreak"
          : undefined;
    ctx.appendSystemMessage(room, message);
    if (
      context.interruptedRemainingTimerMs !== undefined &&
      context.interruptedRemainingTimerMs > 0
    ) {
      restoreInterruptedTimer(ctx, room, context.interruptedRemainingTimerMs);
    }
  }
};

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

/** 白板猜词有了最终结果后进入反馈：猜中即结算，猜错按猜词上下文恢复原阶段或按残局结算。 */
const enterBlankGuessFeedback = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  record: BlankGuessRecord,
  reviewed: boolean,
  continuation: FeedbackContinuation
) => {
  const round = requireRound(room);
  round.history.push({
    kind: "blankGuess",
    day: round.day,
    createdAt: ctx.now(),
    playerId: record.playerId,
    guessedWords: [...record.guessedWords] as [string, string],
    success: record.success,
    reason: record.reason,
    reviewed: reviewed || undefined,
  });
  if (round.blankGuessContext) {
    round.blankGuessContext.pendingReview = undefined;
  }
  enterFeedback(
    ctx,
    room,
    {
      kind: "blankGuess",
      day: round.day,
      eliminatedPlayerIds: [],
      blankGuess: { ...record, guessedWords: [...record.guessedWords] as [string, string] },
      blankGuessReviewed: reviewed || undefined,
    },
    continuation
  );
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

/** 白板猜错的续接：恢复原阶段之前，按是否有人离场复判一次胜负。 */
export const continueAfterBlankFailure = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound,
  continuation: Extract<FeedbackContinuation, { type: "blankFailed" }>
) => {
  await resolveFailedBlankGuess(ctx, room, continuation.message);
  // 反馈期间有人离场可能已经分出胜负，恢复原阶段后再判一次。
  if (round.phase !== "gameOver") {
    const winner = continuation.rosterChanged
      ? getWinnerAfterBlankFailure(round.assignments)
      : undefined;
    if (winner) {
      await finishRound(ctx, room, winner, "阶段结算后已满足胜利条件");
    } else if (round.phase === "feedback") {
      // 猜词上下文缺失时没有可恢复的阶段，退回当天描述，避免停在反馈里无路可走。
      round.blankGuessContext = undefined;
      round.phase = "description";
      round.speechMode = round.supplement ? "supplement" : "normal";
    }
  }
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

/**
 * 猜词的白板离场后收束阻塞阶段。
 *
 * blankGuess 只能由白板本人提交、或出题人裁定来推进，两者都没了就再没有
 * 出口，全房会永远停在这一阶段。所以离场时必须就地结束：残局条件已定的
 * 按该条件结算，否则退回发起猜词时的阶段继续游戏。
 */
export const resolveAbandonedBlankGuess = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord
) => {
  const round = room.round;

  if (round?.phase !== "blankGuess" || !round.blankGuessContext) {
    return;
  }

  const guesser = room.players[round.blankGuessContext.playerId];
  const stillPlaying =
    guesser?.membership === "active" && round.assignments[guesser.id] !== undefined;

  if (stillPlaying) {
    return;
  }

  const { deferredWinner, resumePhase } = round.blankGuessContext;
  round.blankGuessContext = undefined;
  clearPhaseTimer(ctx, room);

  if (deferredWinner) {
    await finishRound(ctx, room, deferredWinner, "白板已离场，系统按残局条件结算");
    return;
  }

  if (resumePhase === "tieBreak") {
    if (!round.tieBreak || round.tieBreak.candidateIds.length <= 1) {
      round.phase = "night";
      round.speechMode = undefined;
      round.tieBreak = undefined;
    } else {
      round.phase = "tieBreak";
      round.speechMode = round.tieBreak.stage === "description" ? "tieBreak" : undefined;
    }
  } else {
    round.phase = resumePhase ?? "gameOver";
    round.speechMode = round.phase === "description" ? "normal" : undefined;
  }

  ctx.appendSystemMessage(room, "白板已离场，本次猜词作废，游戏继续");
};
