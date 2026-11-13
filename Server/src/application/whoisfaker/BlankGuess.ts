import { BLANK_GUESS_DRAFT_PUBLISH_WINDOW_MS } from "../../config/Constants";
import { AppError } from "../../domain/Errors";
import {
  evaluateBlankGuess,
  evaluateBlankGuessDraft,
  getWinnerAfterBlankFailure,
} from "../../domain/Rules";
import type {
  BlankGuessRecord,
  FeedbackContinuation,
  GameRound,
  PhaseTimerState,
  WhoIsFakerRoomRecord,
} from "../../shared/Index";
import { enterFeedback } from "./Feedback";
import { runBots } from "./dev/BotActors";
import { broadcastPhaseAndPublish, requeuePendingDisconnects } from "./PendingDisconnects";
import { finishRound } from "./RoundSettlement";
import { armPhaseTimer, clearPhaseTimer, restoreInterruptedTimer } from "./PhaseTimers";
import { publishRoom } from "./RoomPublish";
import { ensurePhaseNotBlocked } from "./RoundRules";
import { requireRound, type WhoIsFakerSeatAt } from "./RoomAccess";
import type { WhoIsFakerContext } from "./Context";

/** 草稿发布合并窗口的定时器名：同房同名只留一个，正好表达「窗口内只挂一个待发布」。 */
const BLANK_DRAFT_TIMER = "blankGuessDraftPublish";

/** 猜词的共同前置：本人是白板、还活着、这局的猜词机会还没用掉；校验顺序即错误码的先后。 */
const requireLiveBlankWithChance = (round: GameRound, playerId: string): void => {
  const state = round.assignments[playerId];

  if (!state || state.role !== "blank") {
    throw new AppError("ACTION_FORBIDDEN", "只有白板可以猜词");
  }

  if (!state.alive) {
    throw new AppError("ACTION_FORBIDDEN", "白板出局后不能再猜词");
  }

  if (round.blankGuessUsed) {
    throw new AppError("BLANK_GUESS_USED", "白板已经使用过猜词机会");
  }
};

export const submitBlankGuess = async (
  ctx: WhoIsFakerContext,
  at: WhoIsFakerSeatAt,
  words: [string, string]
) => {
  // 白板可以主动猜，也可以在被动 blankGuess 阶段猜，但总次数只有一次。
  const { room, seat: player } = at;
  const round = requireRound(room);

  requireLiveBlankWithChance(round, player.id);

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

  requireLiveBlankWithChance(round, player.id);

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

  // 草稿本身立刻落进房间状态（提交、重连与任何一次别的发布都读得到最新值），
  // 只把「全房扇出」合并：窗口内的多次更新由窗口末尾发布一次，最后一次的值不会丢。
  round.blankGuessContext.draft = words;
  ctx.touch(room);
  if (!ctx.timers.isArmed(room.id, BLANK_DRAFT_TIMER)) {
    ctx.timers.arm(room.id, BLANK_DRAFT_TIMER, BLANK_GUESS_DRAFT_PUBLISH_WINDOW_MS, () => {
      // 窗口期间阶段可能已经走远，或本次猜词已提交待裁定（提交与阶段转换自己发布过）：
      // 那些发布带出的已经是最新状态，这里不再补发。
      const context = room.round?.blankGuessContext;
      if (ctx.rooms.get(room.id) !== room || room.round?.phase !== "blankGuess") return;
      if (!context || context.pendingReview) return;
      publishRoom(ctx, room);
    });
  }
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

/**
 * 平票候选按仍存活的人重算并写回；不足两人时清掉平票状态并返回 true。
 * 平票状态丢失（没有候选名单）同样算不足。
 */
const collapseTieBreakCandidates = (round: GameRound): boolean => {
  const alive = (round.tieBreak?.candidateIds ?? []).filter((id) => round.assignments[id]?.alive);
  if (!round.tieBreak || alive.length <= 1) {
    round.tieBreak = undefined;
    return true;
  }
  round.tieBreak.candidateIds = alive;
  return false;
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
    // 猜词期间平票候选可能被移除：按仍在场的人重算，不足两人的平票没有意义，直接入夜晚，
    // 原平票加赛暂存的倒计时随之作废。
    const tieBreakCollapsed =
      context.resumePhase === "tieBreak" && collapseTieBreakCandidates(round);
    round.phase = tieBreakCollapsed ? "night" : context.resumePhase;
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
      !tieBreakCollapsed &&
      context.interruptedRemainingTimerMs !== undefined &&
      context.interruptedRemainingTimerMs > 0
    ) {
      restoreInterruptedTimer(ctx, room, context.interruptedRemainingTimerMs);
    }
  }
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
