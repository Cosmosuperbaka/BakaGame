import { AppError } from "../../domain/Errors";
import {
  type GameRound,
  type WhoIsFakerPhase,
  type WhoIsFakerRoomRecord,
} from "../../shared/Index";
import { applyEliminationAndMove } from "./Feedback";
import { runBots } from "./dev/BotActors";
import { requeuePendingDisconnects } from "./PendingDisconnects";
import { clearPhaseTimer } from "./PhaseTimers";
import { publishLobby, publishRoom } from "./RoomPublish";
import { applyFeedbackContinuation, resolveNight, resolveVoting } from "./Resolution";
import { finishRound } from "./RoundSettlement";
import {
  ensureAllReady,
  ensureMinimumPlayers,
  ensurePhaseNotBlocked,
  getPendingActorIds,
  isDescriptionComplete,
  isTwoPlayerUndercoverEndgame,
} from "./RoundRules";
import { ensureHost, ensureQuestioner, requireRound, type WhoIsFakerSeatAt } from "./RoomAccess";
import type { WhoIsFakerContext } from "./Context";

export const advancePhase = async (ctx: WhoIsFakerContext, at: WhoIsFakerSeatAt) => {
  // waiting 由房主开局；gameOver 先退回等待房间，避免跳过下一局准备环节。
  const { room, seat: player } = at;
  const phase = room.round?.phase ?? "waiting";

  if (phase === "gameOver") {
    ensureHost(room, player.id);
    const advanceAllowedAt = ctx.gameOverAdvanceAllowedAtByRoomId.get(room.id) ?? 0;
    if (ctx.now() < advanceAllowedAt) {
      throw new AppError("PHASE_RESULT_PENDING", "阶段结果展示中，请稍候");
    }
    returnRoomToWaiting(ctx, room);
    return { phase: "waiting" as WhoIsFakerPhase };
  }

  if (phase === "waiting") {
    ensureHost(room, player.id);
    ensureAllReady(room);
    ensureMinimumPlayers(room);
    await startRound(ctx, room);
    return { phase: room.round?.phase ?? "waiting" };
  }

  const round = requireRound(room);
  // 测试房跳转后可能没有出题人，反馈继续与计时一样放开给房内任何人，免得卡在反馈里。
  if (!(phase === "feedback" && ctx.testRooms.isTestRoom(room.id))) {
    ensureQuestioner(round, player.id);
  }
  ensurePhaseNotBlocked(round);

  // 白板从补充发言中途猜词失败时，反馈期间补充上下文仍保留，不能挡住继续。
  if (round.supplement && phase !== "feedback") {
    throw new AppError("PHASE_INCOMPLETE", "出题人发起的补充发言尚未完成");
  }

  switch (phase) {
    case "description":
      await advanceFromDescription(ctx, room, round);
      break;
    case "voting":
      await advanceFromVoting(ctx, room);
      break;
    case "tieBreak":
      await advanceFromTieBreak(ctx, room, round);
      break;
    case "night":
      await advanceFromNight(ctx, room);
      break;
    case "feedback":
      await applyFeedbackContinuation(ctx, room);
      break;
    default:
      throw new AppError("INVALID_PHASE", "当前阶段不能手动推进");
  }

  ctx.touch(room);
  // 新阶段可能开始等待某个此前被放过的掉线玩家，这里补上暂停。
  requeuePendingDisconnects(ctx, room);
  await ctx.log({
    type: "game.phase_changed",
    createdAt: ctx.now(),
    roomId: room.id,
    playerId: player.id,
    payload: {
      phase: room.round?.phase ?? "waiting",
    },
  });

  publishRoom(ctx, room);
  await runBots(ctx, room);

  return { phase: room.round?.phase ?? "waiting" };
};

const advanceFromDescription = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound
) => {
  if (!isDescriptionComplete(round)) {
    throw new AppError("PHASE_INCOMPLETE", "仍有玩家尚未描述");
  }
  clearPhaseTimer(ctx, room);
  if (isTwoPlayerUndercoverEndgame(round)) {
    await finishRound(ctx, room, "undercover", "2人残局卧底胜");
    return;
  }
  round.phase = "voting";
  round.speechMode = undefined;
  round.votes = [];
};

const advanceFromVoting = async (ctx: WhoIsFakerContext, room: WhoIsFakerRoomRecord) => {
  if (getPendingActorIds(requireRound(room)).length > 0) {
    throw new AppError("PHASE_INCOMPLETE", "仍有玩家尚未投票");
  }
  clearPhaseTimer(ctx, room);
  await resolveVoting(ctx, room, false);
};

/** 平票：候选不足直接进夜晚，否则按补充描述、PK 投票两个子状态推进。 */
const advanceFromTieBreak = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound
) => {
  if (!round.tieBreak || round.tieBreak.candidateIds.length <= 1) {
    clearPhaseTimer(ctx, room);
    await applyEliminationAndMove(ctx, room, [], "平票候选不足，直接进入夜晚", "night");
    return;
  }

  if (round.tieBreak.stage === "description") {
    if (getPendingActorIds(round).length > 0) {
      throw new AppError("PHASE_INCOMPLETE", "平票玩家尚未完成补充描述");
    }

    clearPhaseTimer(ctx, room);
    round.tieBreak.stage = "vote";
    round.speechMode = undefined;
    round.tieBreak.votes = [];
    return;
  }

  if (getPendingActorIds(round).length > 0) {
    throw new AppError("PHASE_INCOMPLETE", "平票投票尚未完成");
  }

  clearPhaseTimer(ctx, room);
  await resolveVoting(ctx, room, true);
};

const advanceFromNight = async (ctx: WhoIsFakerContext, room: WhoIsFakerRoomRecord) => {
  if (getPendingActorIds(requireRound(room)).length > 0) {
    throw new AppError("PHASE_INCOMPLETE", "仍有玩家尚未提交夜晚操作");
  }
  clearPhaseTimer(ctx, room);
  await resolveNight(ctx, room);
};

export const startRound = async (ctx: WhoIsFakerContext, room: WhoIsFakerRoomRecord) => {
  clearPhaseTimer(ctx, room);
  room.roundCount = (room.roundCount ?? 0) + 1;
  // 每次开局都创建全新的 round 对象，避免上一局残留状态污染新局。
  room.round = {
    id: ctx.createId("round"),
    phase: "assigningQuestioner",
    day: 1,
    assignments: {},
    descriptionCycle: 0,
    descriptionOrder: [],
    tieBreakCount: 0,
    descriptions: [],
    descriptionSubmittedBy: [],
    votes: [],
    voteHistory: [],
    nightActions: [],
    blankGuessUsed: false,
    blankGuessRecords: [],
    pendingDisconnectPlayerIds: [],
    history: [],
  };
  ctx.roundStartedAtById.set(room.round.id, ctx.now());

  ctx.touch(room);

  await ctx.log({
    type: "game.started",
    createdAt: ctx.now(),
    roomId: room.id,
    payload: {
      playerCount: Object.values(room.players).filter((item) => item.membership === "active")
        .length,
    },
  });

  publishRoom(ctx, room);
};

export const returnRoomToWaiting = (ctx: WhoIsFakerContext, room: WhoIsFakerRoomRecord) => {
  clearPhaseTimer(ctx, room);
  ctx.gameOverAdvanceAllowedAtByRoomId.delete(room.id);
  // 正常结算时记录侧已取走开局时间；测试房直接跳回等待会跳过结算，这里兜底，否则每跳一次漏一条。
  if (room.round) ctx.roundStartedAtById.delete(room.round.id);
  room.round = undefined;
  for (const player of Object.values(room.players)) {
    // 机器人无法自行点击准备；旁观者则始终不参与准备计数。
    player.isReady = player.membership === "active" && player.isBot;
  }

  ctx.touch(room);
  publishRoom(ctx, room);
  publishLobby(ctx);
};
