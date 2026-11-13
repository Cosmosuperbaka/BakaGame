import { AppError } from "../../domain/Errors";
import {
  computeVoteOutcome,
  getWinnerAfterBlankFailure,
  recordEliminations,
  resolveNightEliminations,
} from "../../domain/Rules";
import { NOOP_GAME_RECORDER, type GameRecordEvent } from "../../domain/GameRecord";
import {
  ABSTAIN_TARGET_ID,
  type GameRound,
  type RoundSummary,
  type RoundWinner,
  type SpeechMode,
  type TieBreakStage,
  type WhoIsFakerPhase,
  type WhoIsFakerRoomRecord,
} from "../../shared/Index";
import { PHASE_RESULT_DISPLAY_MS } from "../../config/Constants";
import {
  applyEliminationAndMove,
  applyTieBreakContinuation,
  continueAfterBlankFailure,
  enterFeedback,
  tryTransitionToFinaleBlankGuess,
  timeoutBlankGuessPhase,
} from "./BlankGuess";
import { runBots } from "./dev/BotActors";
import { requeuePendingDisconnects } from "./PendingDisconnects";
import { clearPhaseTimer, completeSupplementIfReady } from "./PhaseTimers";
import { publishLobby, publishRoom } from "./RoomPublish";
import {
  createDescription,
  createDescriptionOrder,
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

/** 结算给分：白板阵营猜中得 2 分，好人与卧底阵营各自获胜得 1 分。 */
const roundScoreDelta = (
  winner: RoundWinner,
  side: GameRound["assignments"][string]["side"]
): number => {
  if (winner === "blank") return side === "blank" ? 2 : 0;
  if (winner === "good") return side === "good" ? 1 : 0;
  return side === "undercover" ? 1 : 0;
};

/** 当局词对进摘要；未发词的局（如中途放弃）留空。 */
const summarizeRoundWords = (words: GameRound["words"]): RoundSummary["words"] =>
  words
    ? {
        pair: [...words.pair] as [string, string],
        civilianWord: words.civilianWord,
        undercoverWord: words.undercoverWord,
        blankHint: words.blankHint,
      }
    : undefined;

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

const resolveVoting = async (
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

  let eliminatedIds: string[] = [];
  let tieBreakCandidateIds: string[] | undefined;

  if (!tieBreak) {
    if (leaders.length > 0 && (leaders.length > 1 || outcome.abstainCount >= outcome.maxVotes)) {
      // 平票或弃票数达到最高票：若非全员平票（有非候选玩家可在第二轮投票），则进入平票PK；
      // 全员平票则无人出局，直接入夜。
      if (leaders.length < aliveIds.length) {
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

const resolveNight = async (ctx: WhoIsFakerContext, room: WhoIsFakerRoomRecord) => {
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
const applyFeedbackContinuation = async (ctx: WhoIsFakerContext, room: WhoIsFakerRoomRecord) => {
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

export const finishRound = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  winner: RoundWinner,
  reason: string
) => {
  clearPhaseTimer(ctx, room);
  // 结算时既要给分，也要冻结当局摘要，供房间页在局后复盘。
  const round = requireRound(room);
  const awardedScores = awardRoundScores(ctx, room, round, winner);

  round.phase = "gameOver";
  ctx.gameOverAdvanceAllowedAtByRoomId.set(room.id, ctx.now() + PHASE_RESULT_DISPLAY_MS);
  round.speechMode = undefined;
  round.pendingDisconnectPlayerIds = [];
  round.questionerReconnectDeadlineAt = undefined;
  round.blankGuessContext = undefined;
  round.feedback = undefined;
  round.feedbackContinuation = undefined;
  round.summary = {
    winner,
    reason,
    awardedScores,
    revealedRoles: Object.entries(round.assignments).map(([playerId, state]) => ({
      playerId,
      role: state.role,
    })),
    descriptions: [...round.descriptions],
    blankGuesses: [...round.blankGuessRecords],
    words: summarizeRoundWords(round.words),
    voteHistory: round.voteHistory.map((entry) => ({
      day: entry.day,
      tieBreak: entry.tieBreak,
      votes: entry.votes.map((vote) => ({ ...vote })),
    })),
    history: structuredClone(round.history),
  };
  recordRound(ctx, room, round, round.summary);

  for (const player of Object.values(room.players)) {
    // 结算后统一重置为“未准备”，房主返回等待阶段后由全员重新确认。
    player.isReady = false;
  }

  ctx.touch(room);

  await ctx.log({
    type: "game.finished",
    createdAt: ctx.now(),
    roomId: room.id,
    payload: {
      winner,
      reason,
    },
  });

  // 结算必然改变阶段与摘要，这里统一发布快照；对局小结只走状态通道，
  // 调用方无需也不得再补发 game.roundSummary 事件。
  publishRoom(ctx, room);
};

/** 只给获胜阵营的玩家加分；加到分的玩家进当局摘要，其余不进。 */
const awardRoundScores = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound,
  winner: RoundWinner
): RoundSummary["awardedScores"] => {
  const awardedScores: RoundSummary["awardedScores"] = [];
  if (winner === "aborted") return awardedScores;

  for (const [playerId, state] of Object.entries(round.assignments)) {
    const player = room.players[playerId];
    if (!player) continue;

    const delta = roundScoreDelta(winner, state.side);
    if (delta > 0) {
      player.score += delta;
      awardedScores.push({ playerId, delta });
    }
  }

  return awardedScores;
};

/** 结算快照转成对局记录：摘要放胜负与词对，时间线按时间合并发言与全局历史。 */
const recordRound = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound,
  summary: RoundSummary
) => {
  const startedAt = ctx.roundStartedAtById.get(round.id) ?? ctx.now();
  ctx.roundStartedAtById.delete(round.id);
  const deltas = new Map(summary.awardedScores.map((item) => [item.playerId, item.delta]));
  const nameOf = (playerId: string) => room.players[playerId]?.name ?? playerId;
  const timeline: GameRecordEvent[] = [
    ...summary.descriptions.map((item) => ({
      at: item.createdAt,
      type: "description",
      playerId: item.playerId,
      name: item.playerName,
      kind: item.kind,
      text: item.text,
    })),
    ...(summary.history ?? []).map((entry): GameRecordEvent => {
      switch (entry.kind) {
        case "vote":
          return {
            at: entry.createdAt,
            type: "vote",
            day: entry.day,
            tieBreak: entry.tieBreak ?? false,
            votes: entry.votes.map((vote) => ({ ...vote })),
            eliminated: entry.eliminatedPlayerIds.map(nameOf),
          };
        case "night":
          return {
            at: entry.createdAt,
            type: "night",
            day: entry.day,
            actions: entry.actions.map((action) => ({ ...action })),
            eliminated: entry.eliminatedPlayerIds.map(nameOf),
          };
        case "blankGuess":
          return {
            at: entry.createdAt,
            type: "blankGuess",
            day: entry.day,
            name: nameOf(entry.playerId),
            guessedWords: [...entry.guessedWords],
            success: entry.success,
          };
        case "removal":
          return {
            at: entry.createdAt,
            type: "removal",
            day: entry.day,
            name: nameOf(entry.playerId),
            reason: entry.reason,
          };
      }
    }),
  ].sort((left, right) => left.at - right.at);
  (ctx.options.gameRecorder ?? NOOP_GAME_RECORDER).record({
    game: "faker",
    roomId: room.id,
    roomCreatedAt: room.createdAt,
    roundNumber: room.roundCount ?? 1,
    startedAt,
    endedAt: ctx.now(),
    players: Object.keys(round.assignments).flatMap((playerId) => {
      const player = room.players[playerId];
      return player
        ? [
            {
              playerId,
              userId: player.account?.userId ?? null,
              name: player.name,
              score: deltas.get(playerId) ?? 0,
            },
          ]
        : [];
    }),
    summary: {
      winner: summary.winner,
      reason: summary.reason,
      words: summary.words ?? null,
      questioner: round.questionerPlayerId ? nameOf(round.questionerPlayerId) : null,
      roles: summary.revealedRoles.map((item) => ({
        name: nameOf(item.playerId),
        role: item.role,
      })),
      days: round.day,
    },
    timeline,
  });
};
