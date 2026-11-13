import type { PhaseTimerState, WhoIsFakerRoomRecord } from "../../shared/Index";
import { publishRoom } from "./RoomPublish";
import { ensurePhaseNotBlocked } from "./RoundRules";
import { requireRound, type WhoIsFakerSeatAt } from "./RoomAccess";
import type { WhoIsFakerContext } from "./Context";

export const startPhaseTimer = (
  ctx: WhoIsFakerContext,
  at: WhoIsFakerSeatAt,
  durationSeconds: number
) => {
  const { room } = at;
  // 回合存在、阶段支持倒计时、发起人是出题人（测试房不限）都已由命令表守卫确认，
  // 这里取出回合只为收窄类型。
  const round = requireRound(room);
  const phase = round.phase;
  ensurePhaseNotBlocked(round);

  clearPhaseTimer(ctx, room);

  const now = ctx.now();
  const endsAt = now + durationSeconds * 1000;
  const timerState: PhaseTimerState = {
    durationSeconds,
    endsAt,
    phase,
    speechMode: round.speechMode,
    tieBreakStage: round.tieBreak?.stage,
  };

  round.phaseTimer = timerState;

  armPhaseTimer(ctx, room, timerState, endsAt - ctx.now());

  ctx.touch(room);
  ctx.appendSystemMessage(room, `主持人开启了本阶段倒计时（${durationSeconds / 60}分钟）`);
  publishRoom(ctx, room);

  return { phaseTimer: timerState };
};

export const stopPhaseTimer = (ctx: WhoIsFakerContext, at: WhoIsFakerSeatAt) => {
  const { room } = at;
  // 出题人判定（测试房不限）已由命令表守卫完成，这里取出回合只为收窄类型。
  const round = requireRound(room);

  const hadTimer = Boolean(round.phaseTimer);
  clearPhaseTimer(ctx, room);

  if (hadTimer) {
    ctx.touch(room);
    ctx.appendSystemMessage(room, "主持人取消了本阶段倒计时");
    publishRoom(ctx, room);
  }

  return { stopped: true };
};

/** 阶段倒计时在房间定时器里的名字：同房只有一个，重挂先清。 */
const PHASE_TIMER = "phase";

/**
 * 挂阶段倒计时的唯一入口（开启、恢复被打断的倒计时、白板猜词兜底、快照恢复共用）。
 * 回调的比对基准一律取调度时刻捕获的阶段、发言模式与 PK 档位：读 round.phase 等于拿当前值
 * 和它自己比，阶段在中途被推进时这道守卫恒成立，迟到的定时器照样强制推进。
 */
export const armPhaseTimer = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  timerState: PhaseTimerState,
  delayMs: number
): void => {
  ctx.timers.arm(room.id, PHASE_TIMER, delayMs, () =>
    ctx.onPhaseTimeout(room.id, timerState.phase, timerState.speechMode, timerState.tieBreakStage)
  );
};

export const clearPhaseTimer = (ctx: WhoIsFakerContext, room: WhoIsFakerRoomRecord): void => {
  ctx.timers.clear(room.id, PHASE_TIMER);
  if (room.round?.phaseTimer) {
    room.round.phaseTimer = undefined;
  }
};

/** 补充发言全部完成后切回原阶段；返回是否发生了切换。 */
export const completeSupplementIfReady = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord
): boolean => {
  const round = room.round;
  const supplement = round?.supplement;
  if (
    !round ||
    !supplement ||
    supplement.donePlayers.length < supplement.requestedPlayerIds.length
  ) {
    return false;
  }
  round.supplement = undefined;
  if (round.phase === "blankGuess" && round.blankGuessContext?.resumePhase === "description") {
    round.blankGuessContext.resumePhase = supplement.resumePhase;
    // 原补充已完成，其剩余倒计时不能移植到恢复后的投票。
    round.blankGuessContext.interruptedRemainingTimerMs = undefined;
  } else {
    clearPhaseTimer(ctx, room);
    round.phase = supplement.resumePhase;
    round.speechMode = supplement.resumePhase === "description" ? "normal" : undefined;
  }
  return true;
};

export const restoreInterruptedTimer = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  remainingMs: number
): void => {
  const round = room.round;
  if (!round) return;
  clearPhaseTimer(ctx, room);
  const endsAt = ctx.now() + remainingMs;
  const durationSeconds = Math.max(1, Math.round(remainingMs / 1000));
  const timerState: PhaseTimerState = {
    durationSeconds,
    endsAt,
    phase: round.phase,
    speechMode: round.speechMode,
    tieBreakStage: round.tieBreak?.stage,
  };
  round.phaseTimer = timerState;
  armPhaseTimer(ctx, room, timerState, remainingMs);
};
