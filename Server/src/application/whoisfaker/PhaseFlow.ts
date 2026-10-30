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
  ROOM_ID_TEST_MODE,
  type ConnectionRecord,
  type GameRound,
  type PhaseTimerState,
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
import { runBots } from "./BotActors";
import { requeuePendingDisconnects } from "./OfflineSettlement";
import { publishLobby, publishRoom } from "./RoomViews";
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
import type { WhoIsFakerServiceInternals } from "./ServiceInternals";

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

export const advancePhase = async (
  service: WhoIsFakerServiceInternals,
  connection: ConnectionRecord
) => {
  // waiting 由房主开局；gameOver 先退回等待房间，避免跳过下一局准备环节。
  const { room, player } = service.requireRoomPlayer(connection);
  const phase = room.round?.phase ?? "waiting";

  if (phase === "gameOver") {
    service.ensureHost(room, player.id);
    const advanceAllowedAt = service.gameOverAdvanceAllowedAtByRoomId.get(room.id) ?? 0;
    if (service.now() < advanceAllowedAt) {
      throw new AppError("PHASE_RESULT_PENDING", "阶段结果展示中，请稍候");
    }
    returnRoomToWaiting(service, room);
    return { phase: "waiting" as WhoIsFakerPhase };
  }

  if (phase === "waiting") {
    service.ensureHost(room, player.id);
    ensureAllReady(room);
    ensureMinimumPlayers(room);
    await startRound(service, room);
    return { phase: room.round?.phase ?? "waiting" };
  }

  const round = service.requireRound(room);
  // 测试房跳转后可能没有出题人，反馈继续与计时一样放开给房内任何人，免得卡在反馈里。
  if (!(phase === "feedback" && room.id === ROOM_ID_TEST_MODE)) {
    service.ensureQuestioner(round, player.id);
  }
  ensurePhaseNotBlocked(round);

  // 白板从补充发言中途猜词失败时，反馈期间补充上下文仍保留，不能挡住继续。
  if (round.supplement && phase !== "feedback") {
    throw new AppError("PHASE_INCOMPLETE", "出题人发起的补充发言尚未完成");
  }

  switch (phase) {
    case "description":
      await advanceFromDescription(service, room, round);
      break;
    case "voting":
      await advanceFromVoting(service, room);
      break;
    case "tieBreak":
      await advanceFromTieBreak(service, room, round);
      break;
    case "night":
      await advanceFromNight(service, room);
      break;
    case "feedback":
      await applyFeedbackContinuation(service, room);
      break;
    default:
      throw new AppError("INVALID_PHASE", "当前阶段不能手动推进");
  }

  service.touch(room);
  // 新阶段可能开始等待某个此前被放过的掉线玩家，这里补上暂停。
  requeuePendingDisconnects(service, room);
  await service.log({
    type: "game.phase_changed",
    createdAt: service.now(),
    roomId: room.id,
    playerId: player.id,
    payload: {
      phase: room.round?.phase ?? "waiting",
    },
  });

  publishRoom(service, room);
  await runBots(service, room);

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
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord,
  round: GameRound
) => {
  if (!isDescriptionComplete(round)) {
    throw new AppError("PHASE_INCOMPLETE", "仍有玩家尚未描述");
  }
  clearPhaseTimer(service, room);
  if (isTwoPlayerUndercoverEndgame(round)) {
    await finishRound(service, room, "undercover", "2人残局卧底胜");
    return;
  }
  round.phase = "voting";
  round.speechMode = undefined;
  round.votes = [];
};

const advanceFromVoting = async (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord
) => {
  if (!isVotingComplete(service, room, false)) {
    throw new AppError("PHASE_INCOMPLETE", "仍有玩家尚未投票");
  }
  clearPhaseTimer(service, room);
  await resolveVoting(service, room, false);
};

/** 平票：候选不足直接进夜晚，否则按补充描述、PK 投票两个子状态推进。 */
const advanceFromTieBreak = async (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord,
  round: GameRound
) => {
  if (!round.tieBreak || round.tieBreak.candidateIds.length <= 1) {
    clearPhaseTimer(service, room);
    await applyEliminationAndMove(service, room, [], "平票候选不足，直接进入夜晚", "night");
    return;
  }

  if (round.tieBreak.stage === "description") {
    if (!isTieBreakDescriptionComplete(service, room)) {
      throw new AppError("PHASE_INCOMPLETE", "平票玩家尚未完成补充描述");
    }

    clearPhaseTimer(service, room);
    round.tieBreak.stage = "vote";
    round.speechMode = undefined;
    round.tieBreak.votes = [];
    return;
  }

  if (!isVotingComplete(service, room, true)) {
    throw new AppError("PHASE_INCOMPLETE", "平票投票尚未完成");
  }

  clearPhaseTimer(service, room);
  await resolveVoting(service, room, true);
};

const advanceFromNight = async (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord
) => {
  if (!isNightActionComplete(service, room)) {
    throw new AppError("PHASE_INCOMPLETE", "仍有玩家尚未提交夜晚操作");
  }
  clearPhaseTimer(service, room);
  await resolveNight(service, room);
};

export const startPhaseTimer = (
  service: WhoIsFakerServiceInternals,
  connection: ConnectionRecord,
  durationSeconds: number
) => {
  if (durationSeconds !== 60 && durationSeconds !== 120 && durationSeconds !== 180) {
    throw new AppError("INVALID_ARGUMENT", "倒计时时长只能在1、2、3分钟之间选择");
  }

  const { room, player } = service.requireRoomPlayer(connection);
  const round = service.requireRound(room);
  const phase = round.phase;

  if (
    phase === "assigningQuestioner" ||
    phase === "wordSubmission" ||
    phase === "feedback" ||
    phase === "gameOver"
  ) {
    throw new AppError("INVALID_PHASE", "当前阶段不支持设置倒计时");
  }

  if (room.id !== ROOM_ID_TEST_MODE) {
    service.ensureQuestioner(round, player.id);
  }
  ensurePhaseNotBlocked(round);

  clearPhaseTimer(service, room);

  const now = service.now();
  const endsAt = now + durationSeconds * 1000;
  const timerState: PhaseTimerState = {
    durationSeconds,
    endsAt,
    phase,
    speechMode: round.speechMode,
    tieBreakStage: round.tieBreak?.stage,
  };

  round.phaseTimer = timerState;

  const timeoutMs = Math.max(0, endsAt - service.now());
  const timer = setTimeout(() => {
    void handlePhaseTimeout(
      service,
      room.id,
      phase,
      timerState.speechMode,
      timerState.tieBreakStage
    );
  }, timeoutMs);
  service.phaseTimerTimeoutByRoomId.set(room.id, timer);

  service.touch(room);
  service.appendSystemMessage(room, `主持人开启了本阶段倒计时（${durationSeconds / 60}分钟）`);
  publishRoom(service, room);

  return { phaseTimer: timerState };
};

export const stopPhaseTimer = (
  service: WhoIsFakerServiceInternals,
  connection: ConnectionRecord
) => {
  const { room, player } = service.requireRoomPlayer(connection);
  const round = service.requireRound(room);

  if (room.id !== ROOM_ID_TEST_MODE) {
    service.ensureQuestioner(round, player.id);
  }

  const hadTimer = Boolean(round.phaseTimer);
  clearPhaseTimer(service, room);

  if (hadTimer) {
    service.touch(room);
    service.appendSystemMessage(room, "主持人取消了本阶段倒计时");
    publishRoom(service, room);
  }

  return { stopped: true };
};

export const clearPhaseTimer = (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord
): void => {
  const existing = service.phaseTimerTimeoutByRoomId.get(room.id);
  if (existing) {
    clearTimeout(existing);
    service.phaseTimerTimeoutByRoomId.delete(room.id);
  }
  if (room.round?.phaseTimer) {
    room.round.phaseTimer = undefined;
  }
};

export const restoreInterruptedTimer = (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord,
  remainingMs: number
): void => {
  const round = room.round;
  if (!round) return;
  clearPhaseTimer(service, room);
  const endsAt = service.now() + remainingMs;
  const durationSeconds = Math.max(1, Math.round(remainingMs / 1000));
  const timerState: PhaseTimerState = {
    durationSeconds,
    endsAt,
    phase: round.phase,
    speechMode: round.speechMode,
    tieBreakStage: round.tieBreak?.stage,
  };
  round.phaseTimer = timerState;
  const timer = setTimeout(() => {
    void handlePhaseTimeout(
      service,
      room.id,
      // 比对基准取调度时刻捕获的阶段：读 round.phase 等于拿当前值和它自己比，
      // 阶段在中途被推进时这道守卫恒成立，迟到的定时器照样强制推进。
      timerState.phase,
      timerState.speechMode,
      timerState.tieBreakStage
    );
  }, remainingMs);
  service.phaseTimerTimeoutByRoomId.set(room.id, timer);
};

/** 倒计时到点后按阶段强制推进：阶段 → 处理函数；未登记的阶段（如 feedback）不动作。 */
const phaseTimeoutHandlers: Partial<
  Record<
    WhoIsFakerPhase,
    (
      service: WhoIsFakerServiceInternals,
      room: WhoIsFakerRoomRecord,
      round: GameRound
    ) => Promise<void>
  >
> = {
  description: (service, room, round) => timeoutDescriptionPhase(service, room, round),
  voting: (service, room, round) => timeoutVotingPhase(service, room, round),
  tieBreak: (service, room, round) => timeoutTieBreakPhase(service, room, round),
  night: (service, room, round) => timeoutNightPhase(service, room, round),
  blankGuess: (service, room, round) => timeoutBlankGuessPhase(service, room, round),
};

export const handlePhaseTimeout = async (
  service: WhoIsFakerServiceInternals,
  roomId: string,
  expectedPhase: WhoIsFakerPhase,
  expectedSpeechMode?: SpeechMode,
  expectedTieBreakStage?: TieBreakStage
) => {
  const room = service.rooms.get(roomId);
  if (!room) return;

  const currentPhase = room.round?.phase ?? "waiting";
  if (currentPhase !== expectedPhase) return;
  if (room.round?.speechMode !== expectedSpeechMode) return;
  if (room.round?.tieBreak?.stage !== expectedTieBreakStage) return;

  clearPhaseTimer(service, room);
  service.appendSystemMessage(room, "本阶段倒计时结束，系统已强制推进");

  const round = room.round;
  if (!round) return;

  await phaseTimeoutHandlers[currentPhase]?.(service, room, round);
};

/**
 * 描述阶段超时：补充发言只补补充位，否则补完整轮描述后收口。
 * 只剩一卧一民时不再进投票，直接按卧底胜结算（见 `isTwoPlayerUndercoverEndgame`）。
 */
const timeoutDescriptionPhase = async (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord,
  round: GameRound
): Promise<void> => {
  const supplement = round.supplement;
  if (supplement && round.speechMode === "supplement") {
    fillSupplementTimeouts(service, room, round, supplement);
  } else {
    fillDescriptionTimeouts(service, room, round);
    if (await settleTwoPlayerUndercoverEndgame(service, room, round)) return;
    round.phase = "voting";
    round.speechMode = undefined;
    round.votes = [];
  }
  service.touch(room);
  requeuePendingDisconnects(service, room);
  publishRoom(service, room);
  await runBots(service, room);
};

/** 2 人残局只剩一卧一民：按卧底胜结算并返回 true，调用方不再推进阶段。 */
const settleTwoPlayerUndercoverEndgame = async (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord,
  round: GameRound
): Promise<boolean> => {
  if (!isTwoPlayerUndercoverEndgame(round)) return false;
  await finishRound(service, room, "undercover", "2人残局卧底胜");
  return true;
};

/** 描述超时的玩家按发言顺序补一条「（超时未发言）」，不让他们卡住整轮。 */
const fillDescriptionTimeouts = (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord,
  round: GameRound
): void => {
  for (const playerId of round.descriptionOrder) {
    if (!round.descriptionSubmittedBy.includes(playerId)) {
      const player = room.players[playerId] ?? { id: playerId, name: "超时玩家" };
      round.descriptionSubmittedBy.push(playerId);
      const order = round.descriptionOrder.indexOf(playerId) + 1;
      round.descriptions.push(
        createDescription(
          service,
          player,
          "（超时未发言）",
          "description",
          round.descriptionCycle,
          {
            order: order > 0 ? order : undefined,
          }
        )
      );
    }
  }
};

/** 补充发言超时同样补位；补完即判这一轮补充是否已经齐了。 */
const fillSupplementTimeouts = (
  service: WhoIsFakerServiceInternals,
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
        createDescription(service, player, "（超时未发言）", "supplement", round.descriptionCycle, {
          supplementIndex: supplement.index,
          order: order > 0 ? order : undefined,
        })
      );
    }
  }
  service.completeSupplementIfReady(room);
};

/** 投票超时：活着的普通玩家（出题人除外）一律记一次弃权，交给正常计票收口。 */
const timeoutVotingPhase = async (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord,
  round: GameRound
): Promise<void> => {
  const aliveIds = getAliveAssignedPlayerIds(service, room).filter(
    (id) => id !== round.questionerPlayerId
  );
  for (const voterId of aliveIds) {
    if (!round.votes.some((v) => v.voterId === voterId)) {
      round.votes.push({ voterId, targetId: ABSTAIN_TARGET_ID });
    }
  }
  await resolveVoting(service, room, false);
  service.touch(room);
  publishRoom(service, room);
  await runBots(service, room);
};

/** 平票 PK 超时：发言段补位后转投票段；投票段同样记弃权后按 PK 计票收口。 */
const timeoutTieBreakPhase = async (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord,
  round: GameRound
): Promise<void> => {
  const tieBreak = round.tieBreak;
  if (!tieBreak) return;

  if (tieBreak.stage === "description") {
    fillTieBreakTimeouts(service, room, round, tieBreak);
    tieBreak.stage = "vote";
    round.speechMode = undefined;
    tieBreak.votes = [];
    service.touch(room);
    requeuePendingDisconnects(service, room);
    publishRoom(service, room);
    await runBots(service, room);
    return;
  }

  if (tieBreak.stage === "vote") {
    const aliveIds = getAliveAssignedPlayerIds(service, room).filter(
      (id) => id !== round.questionerPlayerId
    );
    for (const voterId of aliveIds) {
      if (!tieBreak.votes.some((v) => v.voterId === voterId)) {
        tieBreak.votes.push({ voterId, targetId: ABSTAIN_TARGET_ID });
      }
    }
    await resolveVoting(service, room, true);
    service.touch(room);
    publishRoom(service, room);
    await runBots(service, room);
  }
};

/** PK 发言超时补位：只给没发言的候选人记一条「（超时未发言）」。 */
const fillTieBreakTimeouts = (
  service: WhoIsFakerServiceInternals,
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
        createDescription(service, player, "（超时未发言）", "tieBreak", round.descriptionCycle, {
          tieBreakIndex: round.tieBreakCount,
          order: order > 0 ? order : undefined,
        })
      );
    }
  }
};

/** 入夜超时：活着的平民与卧底一律记一次「未指定目标」的行动，再按正常夜晚收口。 */
const timeoutNightPhase = async (
  service: WhoIsFakerServiceInternals,
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
  await resolveNight(service, room);
  service.touch(room);
  publishRoom(service, room);
  await runBots(service, room);
};

export const broadcastPhaseAndPublish = (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord
) => {
  // 阶段变了就要重新判断掉线玩家是否已成为当前阶段的阻塞点。
  requeuePendingDisconnects(service, room);
  publishRoom(service, room);
};

export const startRound = async (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord
) => {
  clearPhaseTimer(service, room);
  room.roundCount = (room.roundCount ?? 0) + 1;
  // 每次开局都创建全新的 round 对象，避免上一局残留状态污染新局。
  room.round = {
    id: service.createId("round"),
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
  service.roundStartedAtById.set(room.round.id, service.now());

  service.touch(room);

  await service.log({
    type: "game.started",
    createdAt: service.now(),
    roomId: room.id,
    payload: {
      playerCount: Object.values(room.players).filter((item) => item.membership === "active")
        .length,
    },
  });

  publishRoom(service, room);
};

export const returnRoomToWaiting = (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord
) => {
  clearPhaseTimer(service, room);
  service.gameOverAdvanceAllowedAtByRoomId.delete(room.id);
  // 正常结算时记录侧已取走开局时间；测试房直接跳回等待会跳过结算，这里兜底，否则每跳一次漏一条。
  if (room.round) service.roundStartedAtById.delete(room.round.id);
  room.round = undefined;
  for (const player of Object.values(room.players)) {
    // 机器人无法自行点击准备；旁观者则始终不参与准备计数。
    player.isReady = player.membership === "active" && player.isBot;
  }

  service.touch(room);
  publishRoom(service, room);
  publishLobby(service);
};

const resolveVoting = async (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord,
  tieBreak: boolean
) => {
  // 投票结算：出局立即落地并进入反馈，胜负与下一阶段留到出题人继续时统一判定。
  const round = service.requireRound(room);
  const votes = (tieBreak ? (round.tieBreak?.votes ?? []) : round.votes).map((vote) => ({
    ...vote,
  }));
  round.voteHistory.push({
    day: round.day,
    tieBreak,
    votes: votes.map((vote) => ({ ...vote })),
  });
  const aliveIds = getAliveAssignedPlayerIds(service, room);
  const outcome = computeVoteOutcome(votes);
  const leaders = outcome.leaders;

  await service.log({
    type: "game.vote_resolved",
    createdAt: service.now(),
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
      service.now()
    );
  }

  round.history.push({
    kind: "vote",
    day: round.day,
    createdAt: service.now(),
    tieBreak: tieBreak || undefined,
    votes: votes.map((vote) => ({ ...vote })),
    eliminatedPlayerIds: [...eliminatedIds],
    tieBreakCandidateIds: tieBreakCandidateIds ? [...tieBreakCandidateIds] : undefined,
  });

  round.votes = [];
  round.tieBreak = undefined;
  enterFeedback(
    service,
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

const resolveNight = async (service: WhoIsFakerServiceInternals, room: WhoIsFakerRoomRecord) => {
  // 夜晚结算：出局立即落地并进入天亮反馈（只公开死者，不公开凶手），
  // 白板残局猜词与胜负留到出题人继续时判定。
  const round = service.requireRound(room);
  const actions = round.nightActions.map((action) => ({
    actorId: action.actorId,
    actorRole: action.actorRole,
    targetId: action.targetId,
  }));

  const eliminatedIds = resolveNightEliminations(round, round.nightActions);

  if (eliminatedIds.length > 0) {
    recordEliminations(round.assignments, eliminatedIds, "夜晚结算", service.now());
  }

  round.history.push({
    kind: "night",
    day: round.day,
    createdAt: service.now(),
    actions,
    eliminatedPlayerIds: [...eliminatedIds],
  });

  await service.log({
    type: "game.night_resolved",
    createdAt: service.now(),
    roomId: room.id,
    payload: {
      eliminatedIds,
    },
  });

  round.nightActions = [];
  enterFeedback(
    service,
    room,
    { kind: "night", day: round.day, eliminatedPlayerIds: eliminatedIds },
    { type: "advance", to: "daybreak", winnerReason: "夜晚结算后已满足胜利条件" }
  );
};

/** 出题人在反馈阶段点继续：执行结算时存下的续接动作。 */
const applyFeedbackContinuation = async (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord
) => {
  const round = service.requireRound(room);
  const continuation = round.feedbackContinuation;

  if (!continuation) {
    throw new AppError("INVALID_PHASE", "当前反馈没有可继续的结果");
  }

  round.feedback = undefined;
  round.feedbackContinuation = undefined;

  if (continuation.type === "finish") {
    await finishRound(service, room, continuation.winner, continuation.reason);
    return;
  }

  if (continuation.type === "blankFailed") {
    await continueAfterBlankFailure(service, room, round, continuation);
    return;
  }

  if (tryTransitionToFinaleBlankGuess(service, room)) {
    return;
  }

  const winner = getWinnerAfterBlankFailure(round.assignments);

  if (winner) {
    await finishRound(
      service,
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
  round.descriptionOrder = createDescriptionOrder(service, room);
  round.descriptionSubmittedBy = [];
  round.supplement = undefined;
};

export const finishRound = async (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord,
  winner: RoundWinner,
  reason: string
) => {
  clearPhaseTimer(service, room);
  // 结算时既要给分，也要冻结当局摘要，供房间页在局后复盘。
  const round = service.requireRound(room);
  const awardedScores = awardRoundScores(service, room, round, winner);

  round.phase = "gameOver";
  service.gameOverAdvanceAllowedAtByRoomId.set(room.id, service.now() + PHASE_RESULT_DISPLAY_MS);
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
  recordRound(service, room, round, round.summary);

  for (const player of Object.values(room.players)) {
    // 结算后统一重置为“未准备”，房主返回等待阶段后由全员重新确认。
    player.isReady = false;
  }

  service.touch(room);

  await service.log({
    type: "game.finished",
    createdAt: service.now(),
    roomId: room.id,
    payload: {
      winner,
      reason,
    },
  });

  // 结算必然改变阶段与摘要，这里统一发布快照；对局小结只走状态通道，
  // 调用方无需也不得再补发 game.roundSummary 事件。
  publishRoom(service, room);
};

/** 只给获胜阵营的玩家加分；加到分的玩家进当局摘要，其余不进。 */
const awardRoundScores = (
  service: WhoIsFakerServiceInternals,
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
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord,
  round: GameRound,
  summary: RoundSummary
) => {
  const startedAt = service.roundStartedAtById.get(round.id) ?? service.now();
  service.roundStartedAtById.delete(round.id);
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
  (service.options.gameRecorder ?? NOOP_GAME_RECORDER).record({
    game: "faker",
    roomId: room.id,
    roomCreatedAt: room.createdAt,
    roundNumber: room.roundCount ?? 1,
    startedAt,
    endedAt: service.now(),
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
