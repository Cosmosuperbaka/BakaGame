import { AppError } from "../../domain/Errors";
import {
  assignRoles,
  listPlayablePlayerIds,
  normalizeWord,
  validateRoleConfig,
} from "../../domain/Rules";
import { describeError } from "../../infrastructure/EventLogger";
import { assertTextAllowed } from "../../infrastructure/SensitiveText";
import type {
  GameRound,
  WhoIsFakerPlayerRecord,
  WhoIsFakerRole,
  WhoIsFakerRoomRecord,
} from "../../shared/Index";
import { fakerDescriptionOverflow } from "../../shared/TextUnits";
import type { WhoIsFakerContext } from "./Context";
import { runBots } from "./dev/BotActors";
import { requeuePendingDisconnects } from "./PendingDisconnects";
import { clearPhaseTimer, completeSupplementIfReady } from "./PhaseTimers";
import { requireRound, type WhoIsFakerSeatAt } from "./RoomAccess";
import { publishRoom } from "./RoomPublish";
import {
  clampRoleConfig,
  createDescription,
  createDescriptionOrder,
  ensureCanVote,
  getParticipantCount,
  isDescriptionComplete,
  replaceNightAction,
  replaceVote,
} from "./RoundRules";

export const assignQuestioner = async (
  ctx: WhoIsFakerContext,
  at: WhoIsFakerSeatAt,
  targetPlayerId: string
) => {
  // 出题人可以是正式玩家，也可以是旁观者；旁观者出题时所有正式玩家直接参赛。
  // 房主、回合存在与阶段由命令表守卫确认，这里取出回合只为收窄类型。
  const { room } = at;
  const round = requireRound(room);

  const target = room.players[targetPlayerId];

  if (
    !target ||
    (target.membership !== "active" && target.membership !== "spectator") ||
    !target.online
  ) {
    throw new AppError("PLAYER_NOT_FOUND", "目标玩家不存在、离线或已离开");
  }

  // 旁观者出题 → 正式玩家全员参战；正式玩家出题 → 扣掉自身名额。
  const participantCount = getParticipantCount(room, target.id);

  // 正式玩家担任出题人时若人数不够，自动把卧底数夹到上限（而不是直接拒绝）。
  if (target.membership === "active") {
    room.settings.roleConfig = clampRoleConfig(room.settings.roleConfig, participantCount);
  }

  validateRoleConfig(room.settings.roleConfig, participantCount);

  clearPhaseTimer(ctx, room);
  round.questionerPlayerId = target.id;
  round.phase = "wordSubmission";
  round.speechMode = undefined;
  ctx.touch(room);

  await ctx.log({
    type: "game.questioner_assigned",
    createdAt: ctx.now(),
    roomId: room.id,
    playerId: target.id,
  });

  publishRoom(ctx, room);
  await runBots(ctx, room);

  return { questionerPlayerId: target.id };
};

export const submitWords = async (
  ctx: WhoIsFakerContext,
  at: WhoIsFakerSeatAt,
  words: [string, string],
  blankHint?: string,
  manualRoles?: Record<string, WhoIsFakerRole>
) => {
  // 提交词语后，真正的身份分配与词语映射都在服务端一次性完成。
  // 出题人与阶段由命令表守卫确认，这里取出回合只为收窄类型。
  const { room, seat: player } = at;
  const round = requireRound(room);
  assertTextAllowed(words[0], words[1], blankHint);

  let participantIds = listPlayablePlayerIds(room).filter(
    (item) => item !== round.questionerPlayerId
  );

  if (participantIds.length === 0 && ctx.testRooms.isTestRoom(room.id)) {
    // 单人测试房间允许房主先以出题人视角输入词语，再切回参赛者视角验收后续 UI。
    participantIds = [player.id];
    round.questionerPlayerId = undefined;
  }

  if (participantIds.length === 0) {
    throw new AppError("INSUFFICIENT_PLAYERS", "缺少可参与游戏的玩家");
  }

  validateRoleConfig(room.settings.roleConfig, participantIds.length);

  if (room.settings.roleConfig.hasBlank && !normalizeWord(blankHint ?? "")) {
    throw new AppError("BLANK_HINT_REQUIRED", "开启白板时必须填写提示");
  }

  const assigned = assignRoles(
    participantIds,
    room.settings.roleConfig,
    words,
    blankHint ? normalizeWord(blankHint) : undefined,
    ctx.random,
    manualRoles
  );

  clearPhaseTimer(ctx, room);
  round.words = {
    pair: assigned.pair,
    civilianWord: assigned.civilianWord,
    undercoverWord: assigned.undercoverWord,
    blankHint: blankHint ? normalizeWord(blankHint) : undefined,
  };
  round.assignments = assigned.assignments;
  round.phase = "description";
  round.speechMode = "normal";
  round.descriptionCycle = 1;
  round.descriptionOrder = createDescriptionOrder(ctx, room);
  round.descriptionSubmittedBy = [];
  round.votes = [];
  round.voteHistory = [];
  round.history = [];
  round.tieBreak = undefined;
  round.nightActions = [];
  round.blankGuessContext = undefined;
  ctx.touch(room);

  // 异步后台保存词库，避免阻塞 WebSocket 主流程
  void ctx.options.wordBankRepository?.savePair(words).catch((error: unknown) => {
    ctx.options.eventLogger.error("词库异步保存失败", {
      ...describeError(error),
      roomId: room.id,
      playerId: player.id,
    });
  });

  await ctx.log({
    type: "game.words_submitted",
    createdAt: ctx.now(),
    roomId: room.id,
    playerId: player.id,
  });

  publishRoom(ctx, room);
  await runBots(ctx, room);

  return { phase: round.phase };
};

export const submitDescription = async (
  ctx: WhoIsFakerContext,
  at: WhoIsFakerSeatAt,
  text: string
) => {
  // 描述和 PK 补充描述都复用同一份存储结构，只靠 kind 区分。
  const { room, seat: player } = at;
  const round = requireRound(room);
  const normalized = normalizeWord(text);

  if (!normalized) {
    throw new AppError("INVALID_DESCRIPTION", "描述不能为空");
  }
  // 协议只限 500 个字符，字宽上限必须在这里强制：改过的客户端不受输入框约束。
  const overflow = fakerDescriptionOverflow(normalized);
  if (overflow) throw new AppError("INVALID_DESCRIPTION", overflow);
  assertTextAllowed(normalized);

  const pendingSupplement =
    round.supplement?.requestedPlayerIds.includes(player.id) &&
    !round.supplement.donePlayers.includes(player.id);

  // 补充发言优先：统一切换到 description/supplement 子状态后提交。
  if (round.supplement && round.speechMode === "supplement" && pendingSupplement) {
    submitSupplementDescription(ctx, room, round, round.supplement, player, normalized);
  } else if (round.phase === "description" && round.speechMode !== "supplement") {
    submitNormalDescription(ctx, round, player, normalized);
  } else if (round.phase === "tieBreak" && round.tieBreak?.stage === "description") {
    submitTieBreakDescription(ctx, round, round.tieBreak, player, normalized);
  } else {
    throw new AppError("INVALID_PHASE", "当前阶段不能提交描述");
  }

  ctx.touch(room);
  // 补充发言完成会直接切回原阶段，同样要重新检查掉线玩家。
  requeuePendingDisconnects(ctx, room);
  await ctx.log({
    type: "game.description_submitted",
    createdAt: ctx.now(),
    roomId: room.id,
    playerId: player.id,
  });
  publishRoom(ctx, room);
  await runBots(ctx, room);

  return { submitted: true };
};

const submitSupplementDescription = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound,
  supplement: NonNullable<GameRound["supplement"]>,
  player: WhoIsFakerPlayerRecord,
  text: string
) => {
  if (!round.assignments[player.id]?.alive || round.phase !== "description") {
    throw new AppError("ACTION_FORBIDDEN", "当前玩家不能补充发言");
  }
  supplement.donePlayers.push(player.id);
  const order = (supplement.requestedPlayerIds ?? []).indexOf(player.id) + 1;
  round.descriptions.push(
    createDescription(ctx, player, text, "supplement", round.descriptionCycle, {
      supplementIndex: supplement.index,
      order: order > 0 ? order : undefined,
    })
  );
  completeSupplementIfReady(ctx, room);
};

const submitNormalDescription = (
  ctx: WhoIsFakerContext,
  round: GameRound,
  player: WhoIsFakerPlayerRecord,
  text: string
) => {
  if (!round.assignments[player.id]?.alive) {
    throw new AppError("ACTION_FORBIDDEN", "当前玩家不能描述");
  }
  if (round.descriptionSubmittedBy.includes(player.id)) {
    throw new AppError("ALREADY_SUBMITTED", "你已经提交过描述");
  }
  round.descriptionSubmittedBy.push(player.id);
  const order = (round.descriptionOrder ?? []).indexOf(player.id) + 1;
  round.descriptions.push(
    createDescription(ctx, player, text, "description", round.descriptionCycle, {
      order: order > 0 ? order : undefined,
    })
  );
};

const submitTieBreakDescription = (
  ctx: WhoIsFakerContext,
  round: GameRound,
  tieBreak: NonNullable<GameRound["tieBreak"]>,
  player: WhoIsFakerPlayerRecord,
  text: string
) => {
  round.speechMode = "tieBreak";
  if (!tieBreak.candidateIds.includes(player.id)) {
    throw new AppError("ACTION_FORBIDDEN", "只有平票玩家可以补充描述");
  }

  if (tieBreak.descriptionsDone.includes(player.id)) {
    throw new AppError("ALREADY_SUBMITTED", "你已经提交过补充描述");
  }

  tieBreak.descriptionsDone.push(player.id);
  const order = (tieBreak.candidateIds ?? []).indexOf(player.id) + 1;
  round.descriptions.push(
    createDescription(ctx, player, text, "tieBreak", round.descriptionCycle, {
      tieBreakIndex: round.tieBreakCount,
      order: order > 0 ? order : undefined,
    })
  );
};

export const cancelVote = async (ctx: WhoIsFakerContext, at: WhoIsFakerSeatAt) => {
  // 撤销设计为幂等操作：客户端重试或快速连点时仍会收到最新私有状态。
  const { room, seat: player } = at;
  const round = requireRound(room);
  let cancelled: boolean;

  if (round.phase === "voting") {
    cancelled = round.votes.some((v) => v.voterId === player.id);
    round.votes = round.votes.filter((v) => v.voterId !== player.id);
  } else if (round.phase === "tieBreak" && round.tieBreak?.stage === "vote") {
    cancelled = round.tieBreak.votes.some((v) => v.voterId === player.id);
    round.tieBreak.votes = round.tieBreak.votes.filter((v) => v.voterId !== player.id);
  } else {
    throw new AppError("INVALID_PHASE", "当前阶段不能撤销投票");
  }

  ctx.touch(room);
  publishRoom(ctx, room);
  return { cancelled };
};

export const cancelNightAction = async (ctx: WhoIsFakerContext, at: WhoIsFakerSeatAt) => {
  // 允许已提交夜晚操作的玩家在主持人推进前撤销。回合存在与夜晚阶段由命令表守卫确认。
  const { room, seat: player } = at;
  const round = requireRound(room);

  const cancelled = round.nightActions.some((a) => a.actorId === player.id);
  round.nightActions = round.nightActions.filter((a) => a.actorId !== player.id);
  ctx.touch(room);
  publishRoom(ctx, room);
  return { cancelled };
};

export const requestSupplement = async (
  ctx: WhoIsFakerContext,
  at: WhoIsFakerSeatAt,
  playerIds: string[]
) => {
  // 出题人在本轮描述完成后、投票结算前，可点名若干玩家补充发言一次。
  // 出题人判定由命令表守卫完成，这里取出回合只为收窄类型。
  const { room } = at;
  const round = requireRound(room);

  if (
    (round.phase !== "description" || round.speechMode !== "normal") &&
    round.phase !== "voting"
  ) {
    throw new AppError("INVALID_PHASE", "只能在本轮描述完成后、正常投票结算前发起补充");
  }

  if (!isDescriptionComplete(round)) {
    throw new AppError("PHASE_INCOMPLETE", "所有玩家完成描述后才能发起补充");
  }

  if (round.supplement) {
    throw new AppError("ACTION_FORBIDDEN", "当前已有进行中的补充请求，请等待完成");
  }

  if (!playerIds.length) {
    throw new AppError("INVALID_MESSAGE", "至少需要指定一名玩家补充发言");
  }

  // 校验所有被点名玩家均为存活的非出题人玩家。
  for (const id of playerIds) {
    const state = round.assignments[id];
    if (!state?.alive) {
      throw new AppError("INVALID_MESSAGE", `玩家 ${id} 不在局内或已出局，不能被要求补充`);
    }
    if (id === round.questionerPlayerId) {
      throw new AppError("INVALID_MESSAGE", "出题人不能要求自己补充发言");
    }
  }

  // 计算本局第几次补充（在所有轮次描述中找最大 supplementIndex + 1）。
  const maxSuppIdx = round.descriptions.reduce(
    (max, d) =>
      d.supplementIndex !== undefined && d.supplementIndex > max ? d.supplementIndex : max,
    0
  );

  clearPhaseTimer(ctx, room);
  round.supplement = {
    index: maxSuppIdx + 1,
    requestedPlayerIds: [...new Set(playerIds)],
    donePlayers: [],
    resumePhase: round.phase,
  };
  round.phase = "description";
  round.speechMode = "supplement";

  ctx.touch(room);
  requeuePendingDisconnects(ctx, room);
  await runBots(ctx, room);
  publishRoom(ctx, room);
  return { requested: true };
};

export const submitVote = async (
  ctx: WhoIsFakerContext,
  at: WhoIsFakerSeatAt,
  targetId: string
) => {
  // 第一轮投票与平票第二轮投票复用同一个入口，但资格校验不同。
  const { room, seat: player } = at;
  const round = requireRound(room);

  if (round.phase === "voting") {
    ensureCanVote(ctx, room, player.id, targetId, false);
    round.votes = replaceVote(round.votes, player.id, targetId);
  } else if (round.phase === "tieBreak" && round.tieBreak?.stage === "vote") {
    ensureCanVote(ctx, room, player.id, targetId, true);
    round.tieBreak.votes = replaceVote(round.tieBreak.votes, player.id, targetId);
  } else {
    throw new AppError("INVALID_PHASE", "当前阶段不能提交投票");
  }

  ctx.touch(room);
  await ctx.log({
    type: "game.vote_submitted",
    createdAt: ctx.now(),
    roomId: room.id,
    playerId: player.id,
    payload: {
      targetId,
      tieBreak: round.phase === "tieBreak",
    },
  });
  publishRoom(ctx, room);
  await runBots(ctx, room);

  return { submitted: true };
};

export const submitNightAction = async (
  ctx: WhoIsFakerContext,
  at: WhoIsFakerSeatAt,
  targetId?: string | null
) => {
  // 空 targetId 表示“本夜不行动”，不是错误输入。回合存在与夜晚阶段由命令表守卫确认。
  const { room, seat: player } = at;
  const round = requireRound(room);

  const state = round.assignments[player.id];

  if (!state?.alive || (state.role !== "civilian" && state.role !== "undercover")) {
    throw new AppError("ACTION_FORBIDDEN", "当前玩家没有夜晚操作资格");
  }

  if (targetId) {
    const targetState = round.assignments[targetId];

    // 不能刀自己，测试房间同样适用。
    if (!targetState?.alive || targetId === player.id) {
      throw new AppError("INVALID_TARGET", "夜晚目标无效");
    }
  }

  round.nightActions = replaceNightAction(round.nightActions, player.id, {
    actorId: player.id,
    actorRole: state.role,
    targetId: targetId ?? undefined,
  });
  ctx.touch(room);

  await ctx.log({
    type: "game.night_action_submitted",
    createdAt: ctx.now(),
    roomId: room.id,
    playerId: player.id,
    payload: {
      hasTarget: Boolean(targetId),
    },
  });

  publishRoom(ctx, room);
  await runBots(ctx, room);

  return { submitted: true };
};
