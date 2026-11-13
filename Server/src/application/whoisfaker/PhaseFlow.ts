import { AppError } from "../../domain/Errors";
import {
  ABSTAIN_TARGET_ID,
  type GameRound,
  type SpeechMode,
  type TieBreakStage,
  type WhoIsFakerPhase,
  type WhoIsFakerRoomRecord,
} from "../../shared/Index";
import { timeoutBlankGuessPhase } from "./BlankGuess";
import { applyEliminationAndMove } from "./Feedback";
import { runBots } from "./dev/BotActors";
import { requeuePendingDisconnects } from "./PendingDisconnects";
import { clearPhaseTimer, completeSupplementIfReady } from "./PhaseTimers";
import { publishLobby, publishRoom } from "./RoomPublish";
import { applyFeedbackContinuation, resolveNight, resolveVoting } from "./Resolution";
import { finishRound } from "./RoundSettlement";
import {
  createDescription,
  ensureAllReady,
  ensureMinimumPlayers,
  ensurePhaseNotBlocked,
  getAliveAssignedPlayerIds,
  isDescriptionComplete,
  isNightActionComplete,
  isTieBreakDescriptionComplete,
  isVotingComplete,
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

/** 只剩一卧一民两人时，描述结束即卧底胜，不再进投票。 */
const isTwoPlayerUndercoverEndgame = (round: GameRound): boolean => {
  const aliveStates = Object.values(round.assignments).filter((state) => state.alive);
  return (
    aliveStates.length === 2 &&
    aliveStates.filter((state) => state.role === "undercover").length === 1 &&
    aliveStates.filter((state) => state.role === "civilian").length === 1
  );
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
  if (!isVotingComplete(ctx, room, false)) {
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
    if (!isTieBreakDescriptionComplete(ctx, room)) {
      throw new AppError("PHASE_INCOMPLETE", "平票玩家尚未完成补充描述");
    }

    clearPhaseTimer(ctx, room);
    round.tieBreak.stage = "vote";
    round.speechMode = undefined;
    round.tieBreak.votes = [];
    return;
  }

  if (!isVotingComplete(ctx, room, true)) {
    throw new AppError("PHASE_INCOMPLETE", "平票投票尚未完成");
  }

  clearPhaseTimer(ctx, room);
  await resolveVoting(ctx, room, true);
};

const advanceFromNight = async (ctx: WhoIsFakerContext, room: WhoIsFakerRoomRecord) => {
  if (!isNightActionComplete(ctx, room)) {
    throw new AppError("PHASE_INCOMPLETE", "仍有玩家尚未提交夜晚操作");
  }
  clearPhaseTimer(ctx, room);
  await resolveNight(ctx, room);
};

/** 倒计时到点后按阶段强制推进：阶段 → 处理函数；未登记的阶段（如 feedback）不动作。 */
const phaseTimeoutHandlers: Partial<
  Record<
    WhoIsFakerPhase,
    (ctx: WhoIsFakerContext, room: WhoIsFakerRoomRecord, round: GameRound) => Promise<void>
  >
> = {
  description: (ctx, room, round) => timeoutDescriptionPhase(ctx, room, round),
  voting: (ctx, room, round) => timeoutVotingPhase(ctx, room, round),
  tieBreak: (ctx, room, round) => timeoutTieBreakPhase(ctx, room, round),
  night: (ctx, room, round) => timeoutNightPhase(ctx, room, round),
  blankGuess: (ctx, room, round) => timeoutBlankGuessPhase(ctx, room, round),
};

export const handlePhaseTimeout = async (
  ctx: WhoIsFakerContext,
  roomId: string,
  expectedPhase: WhoIsFakerPhase,
  expectedSpeechMode?: SpeechMode,
  expectedTieBreakStage?: TieBreakStage
) => {
  const room = ctx.rooms.get(roomId);
  if (!room) return;

  const currentPhase = room.round?.phase ?? "waiting";
  if (currentPhase !== expectedPhase) return;
  if (room.round?.speechMode !== expectedSpeechMode) return;
  if (room.round?.tieBreak?.stage !== expectedTieBreakStage) return;

  clearPhaseTimer(ctx, room);
  ctx.appendSystemMessage(room, "本阶段倒计时结束，系统已强制推进");

  const round = room.round;
  if (!round) return;

  await phaseTimeoutHandlers[currentPhase]?.(ctx, room, round);
};

/**
 * 描述阶段超时：补充发言只补补充位，否则补完整轮描述后收口。
 * 只剩一卧一民时不再进投票，直接按卧底胜结算（见 `isTwoPlayerUndercoverEndgame`）。
 */
const timeoutDescriptionPhase = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound
): Promise<void> => {
  const supplement = round.supplement;
  if (supplement && round.speechMode === "supplement") {
    fillSupplementTimeouts(ctx, room, round, supplement);
  } else {
    fillDescriptionTimeouts(ctx, room, round);
    if (await settleTwoPlayerUndercoverEndgame(ctx, room, round)) return;
    round.phase = "voting";
    round.speechMode = undefined;
    round.votes = [];
  }
  ctx.touch(room);
  requeuePendingDisconnects(ctx, room);
  publishRoom(ctx, room);
  await runBots(ctx, room);
};

/** 2 人残局只剩一卧一民：按卧底胜结算并返回 true，调用方不再推进阶段。 */
const settleTwoPlayerUndercoverEndgame = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound
): Promise<boolean> => {
  if (!isTwoPlayerUndercoverEndgame(round)) return false;
  await finishRound(ctx, room, "undercover", "2人残局卧底胜");
  return true;
};

/** 描述超时的玩家按发言顺序补一条「（超时未发言）」，不让他们卡住整轮。 */
const fillDescriptionTimeouts = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound
): void => {
  for (const playerId of round.descriptionOrder) {
    if (!round.descriptionSubmittedBy.includes(playerId)) {
      const player = room.players[playerId] ?? { id: playerId, name: "超时玩家" };
      round.descriptionSubmittedBy.push(playerId);
      const order = round.descriptionOrder.indexOf(playerId) + 1;
      round.descriptions.push(
        createDescription(ctx, player, "（超时未发言）", "description", round.descriptionCycle, {
          order: order > 0 ? order : undefined,
        })
      );
    }
  }
};

/** 补充发言超时同样补位；补完即判这一轮补充是否已经齐了。 */
const fillSupplementTimeouts = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound,
  supplement: NonNullable<GameRound["supplement"]>
): void => {
  for (const playerId of supplement.requestedPlayerIds) {
    if (!supplement.donePlayers.includes(playerId)) {
      const player = room.players[playerId] ?? { id: playerId, name: "超时玩家" };
      supplement.donePlayers.push(playerId);
      const order = supplement.requestedPlayerIds.indexOf(playerId) + 1;
      round.descriptions.push(
        createDescription(ctx, player, "（超时未发言）", "supplement", round.descriptionCycle, {
          supplementIndex: supplement.index,
          order: order > 0 ? order : undefined,
        })
      );
    }
  }
  completeSupplementIfReady(ctx, room);
};

/** 投票超时：活着的普通玩家（出题人除外）一律记一次弃权，交给正常计票收口。 */
const timeoutVotingPhase = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound
): Promise<void> => {
  const aliveIds = getAliveAssignedPlayerIds(ctx, room).filter(
    (id) => id !== round.questionerPlayerId
  );
  for (const voterId of aliveIds) {
    if (!round.votes.some((v) => v.voterId === voterId)) {
      round.votes.push({ voterId, targetId: ABSTAIN_TARGET_ID });
    }
  }
  await resolveVoting(ctx, room, false);
  ctx.touch(room);
  publishRoom(ctx, room);
  await runBots(ctx, room);
};

/** 平票 PK 超时：发言段补位后转投票段；投票段同样记弃权后按 PK 计票收口。 */
const timeoutTieBreakPhase = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound
): Promise<void> => {
  const tieBreak = round.tieBreak;
  if (!tieBreak) return;

  if (tieBreak.stage === "description") {
    fillTieBreakTimeouts(ctx, room, round, tieBreak);
    tieBreak.stage = "vote";
    round.speechMode = undefined;
    tieBreak.votes = [];
    ctx.touch(room);
    requeuePendingDisconnects(ctx, room);
    publishRoom(ctx, room);
    await runBots(ctx, room);
    return;
  }

  if (tieBreak.stage === "vote") {
    const aliveIds = getAliveAssignedPlayerIds(ctx, room).filter(
      (id) => id !== round.questionerPlayerId
    );
    for (const voterId of aliveIds) {
      if (!tieBreak.votes.some((v) => v.voterId === voterId)) {
        tieBreak.votes.push({ voterId, targetId: ABSTAIN_TARGET_ID });
      }
    }
    await resolveVoting(ctx, room, true);
    ctx.touch(room);
    publishRoom(ctx, room);
    await runBots(ctx, room);
  }
};

/** PK 发言超时补位：只给没发言的候选人记一条「（超时未发言）」。 */
const fillTieBreakTimeouts = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound,
  tieBreak: NonNullable<GameRound["tieBreak"]>
): void => {
  for (const candidateId of tieBreak.candidateIds) {
    if (!tieBreak.descriptionsDone.includes(candidateId)) {
      const player = room.players[candidateId] ?? { id: candidateId, name: "超时玩家" };
      tieBreak.descriptionsDone.push(candidateId);
      const order = tieBreak.candidateIds.indexOf(candidateId) + 1;
      round.descriptions.push(
        createDescription(ctx, player, "（超时未发言）", "tieBreak", round.descriptionCycle, {
          tieBreakIndex: round.tieBreakCount,
          order: order > 0 ? order : undefined,
        })
      );
    }
  }
};

/** 入夜超时：活着的平民与卧底一律记一次「未指定目标」的行动，再按正常夜晚收口。 */
const timeoutNightPhase = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound
): Promise<void> => {
  for (const [playerId, state] of Object.entries(round.assignments)) {
    if (state.alive && (state.role === "civilian" || state.role === "undercover")) {
      if (!round.nightActions.some((a) => a.actorId === playerId)) {
        round.nightActions.push({
          actorId: playerId,
          actorRole: state.role,
          targetId: undefined,
        });
      }
    }
  }
  await resolveNight(ctx, room);
  ctx.touch(room);
  publishRoom(ctx, room);
  await runBots(ctx, room);
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
