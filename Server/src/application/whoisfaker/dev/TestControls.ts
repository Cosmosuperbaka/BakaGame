import { AppError } from "../../../domain/Errors";
import { assignRoles, getBlankPlayerId } from "../../../domain/Rules";
import {
  type GameRound,
  type RoleConfig,
  type WhoIsFakerPhase,
  type WhoIsFakerPlayerRecord,
  type WhoIsFakerRole,
  type WhoIsFakerRoomRecord,
} from "../../../shared/Index";
import { TEST_MODE_DEFAULT_WORD, TEST_MODE_MAX_PLAYERS } from "../../../config/Constants";
import { pickBotName, runBots } from "./BotActors";
import { forceRemovePlayer } from "../OfflineSettlement";
import { broadcastPhaseAndPublish } from "../PendingDisconnects";
import { returnRoomToWaiting, startRound } from "../PhaseFlow";
import { finishRound } from "../RoundSettlement";
import { clearPhaseTimer } from "../PhaseTimers";
import { publishRoom } from "../RoomPublish";
import {
  clampRoleConfig,
  createDescriptionOrder,
  getActivePlayerIds,
  normalizeRoomRoleConfig,
} from "../RoundRules";
import { requireRound, isRoundActive, type WhoIsFakerSeatAt } from "../RoomAccess";
import type { WhoIsFakerContext } from "../Context";

/**
 * 测试跳转回「指定出题人」时逐字段重置 round 的默认值表。
 * 用工厂函数而不是常量表：表里若直接放 [] / {}，两次跳转会共享同一个容器实例。
 */
const testJumpRoundDefaults = (): Partial<GameRound> => ({
  questionerPlayerId: undefined,
  assignments: {},
  words: undefined,
  descriptionCycle: 0,
  descriptionOrder: [],
  descriptions: [],
  descriptionSubmittedBy: [],
  votes: [],
  voteHistory: [],
  history: [],
  tieBreak: undefined,
  nightActions: [],
  blankGuessUsed: false,
  blankGuessRecords: [],
  blankGuessContext: undefined,
  feedback: undefined,
  feedbackContinuation: undefined,
  pendingDisconnectPlayerIds: [],
  questionerReconnectDeadlineAt: undefined,
  summary: undefined,
});

/** 按默认值表重置 round 并切到目标阶段；原实现是逐字段赋值，收敛成一张表 + 重置函数。 */
const resetRoundForTestJump = (round: GameRound, phase: WhoIsFakerPhase): void => {
  Object.assign(round, testJumpRoundDefaults(), { phase });
};

/** 测试跳转的参战名单：跳到出题阶段时由调用者担任出题人，其余情况沿用本局已确定的人。 */
const planTestJumpRoster = (
  room: WhoIsFakerRoomRecord,
  player: WhoIsFakerPlayerRecord,
  target: WhoIsFakerPhase
) => {
  const activeIds = Object.values(room.players)
    .filter((p) => p.membership === "active")
    .map((p) => p.id);
  const useCallerAsQuestioner = target === "wordSubmission";

  // 出题人：跳到出题阶段时由调用者担任，其余情况保持本局已确定的人，
  // 没有则维持未指定——跳转不负责替玩家选出题人。
  const plannedQuestionerId = useCallerAsQuestioner ? player.id : room.round?.questionerPlayerId;
  const plannedParticipants = plannedQuestionerId
    ? activeIds.filter((id) => id !== plannedQuestionerId)
    : activeIds;

  // 人数校验必须在建 round 之前：否则单人也能跳「指定主持人」，
  // startRound 已经把游戏开起来，只是后面的分支才拒绝。
  // 出题人不参战，所以除了 4 名参战，还要留出他的位置——除非出题人是旁观者。
  const questionerIsSpectator = plannedQuestionerId
    ? room.players[plannedQuestionerId]?.membership === "spectator"
    : false;
  const enoughActive = questionerIsSpectator ? activeIds.length >= 4 : activeIds.length >= 5;

  if (!enoughActive || plannedParticipants.length < 4) {
    throw new AppError("INSUFFICIENT_PLAYERS", "对局需要 4 名参战玩家，请先添加机器人");
  }

  return { plannedQuestionerId, plannedParticipants };
};

/** 词与身份只在缺失或参战名单变动时重分配，跳转本身不换已定好的词。 */
const ensureTestJumpWords = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound,
  participantIds: string[],
  target: WhoIsFakerPhase
) => {
  if (
    target !== "wordSubmission" &&
    (!round.words ||
      Object.keys(round.assignments).length === 0 ||
      participantIds.some((id) => !round.assignments[id]))
  ) {
    const config = clampRoleConfig(room.settings.roleConfig, participantIds.length);
    // clampRoleConfig 已按真实人数上限夹过天使/白板，这里不再额外放宽。
    const effectiveConfig: RoleConfig = config;
    const assigned = assignRoles(
      participantIds,
      effectiveConfig,
      TEST_MODE_DEFAULT_WORD,
      effectiveConfig.hasBlank ? "测试提示" : undefined,
      ctx.random
    );
    round.words = {
      pair: assigned.pair,
      civilianWord: assigned.civilianWord,
      undercoverWord: assigned.undercoverWord,
      blankHint: effectiveConfig.hasBlank ? "测试提示" : undefined,
    };
    round.assignments = assigned.assignments;
  }
};

export const testJumpToPhase = async (
  ctx: WhoIsFakerContext,
  at: WhoIsFakerSeatAt,
  target: WhoIsFakerPhase
) => {
  // 仅测试房间可用：预填必要的 round 状态后直接切到目标阶段，方便逐个阶段验收 UI。
  // 测试房与房主判定由命令表守卫完成。
  const { room, seat: player } = at;

  // 反馈阶段只由结算产生，没有可凭空构造的结果。
  if (target === "feedback") {
    throw new AppError("INVALID_PHASE", "阶段反馈由结算产生，不能直接跳转");
  }

  clearPhaseTimer(ctx, room);

  if (target === "waiting") {
    returnRoomToWaiting(ctx, room);
    return { phase: "waiting" as WhoIsFakerPhase };
  }

  const { plannedQuestionerId, plannedParticipants } = planTestJumpRoster(room, player, target);

  // 确保 round 存在。
  if (!room.round) {
    await startRound(ctx, room);
  }

  const round = requireRound(room);
  const participantIds = plannedParticipants;

  if (target === "assigningQuestioner") {
    resetRoundForTestJump(round, "assigningQuestioner");
    broadcastPhaseAndPublish(ctx, room);
    return { phase: round.phase };
  }

  // 出题人一旦确定就保持到本局结束：跳转不是换人，不能把已有出题人清成
  // undefined，否则出完题跳下一阶段，出题人就退化成普通玩家。
  round.questionerPlayerId = plannedQuestionerId;
  round.pendingDisconnectPlayerIds = [];
  round.questionerReconnectDeadlineAt = undefined;

  ensureTestJumpWords(ctx, room, round, participantIds, target);

  round.feedback = undefined;
  round.feedbackContinuation = undefined;

  switch (target) {
    case "wordSubmission":
      round.phase = "wordSubmission";
      round.words = undefined;
      round.assignments = {};
      round.descriptionCycle = 0;
      round.descriptionOrder = [];
      round.descriptions = [];
      round.descriptionSubmittedBy = [];
      round.votes = [];
      round.voteHistory = [];
      round.history = [];
      round.tieBreak = undefined;
      round.nightActions = [];
      round.blankGuessUsed = false;
      round.blankGuessRecords = [];
      round.blankGuessContext = undefined;
      round.summary = undefined;
      break;
    case "description":
      round.phase = "description";
      round.speechMode = "normal";
      round.descriptionCycle = Math.max(1, round.descriptionCycle);
      round.descriptionOrder = createDescriptionOrder(ctx, room);
      round.descriptionSubmittedBy = [];
      round.votes = [];
      round.tieBreak = undefined;
      round.nightActions = [];
      round.blankGuessUsed = false;
      round.blankGuessContext = undefined;
      round.summary = undefined;
      break;
    case "voting":
      round.phase = "voting";
      round.speechMode = undefined;
      round.votes = [];
      round.tieBreak = undefined;
      round.nightActions = [];
      round.blankGuessUsed = false;
      round.blankGuessContext = undefined;
      round.summary = undefined;
      break;
    case "tieBreak": {
      const alive = Object.entries(round.assignments)
        .filter(([, s]) => s.alive)
        .map(([pid]) => pid)
        .slice(0, 2);
      round.phase = "tieBreak";
      round.speechMode = "tieBreak";
      round.tieBreak = {
        candidateIds: alive,
        stage: "description",
        descriptionsDone: [],
        votes: [],
      };
      round.blankGuessUsed = false;
      round.blankGuessContext = undefined;
      round.summary = undefined;
      break;
    }
    case "night":
      round.phase = "night";
      round.speechMode = undefined;
      round.nightActions = [];
      round.blankGuessUsed = false;
      round.blankGuessContext = undefined;
      round.summary = undefined;
      break;
    case "blankGuess": {
      // 只认本局真实的白板。没有白板时直接拒绝，不把任何人临时改成白板。
      const blankId = getBlankPlayerId(round.assignments);

      if (!blankId) {
        throw new AppError("INVALID_PHASE", "本局没有白板，请先在房间设置里开启白板并重新开局");
      }

      if (round.words && !round.words.blankHint) {
        round.words.blankHint = "测试提示";
      }

      round.phase = "blankGuess";
      round.speechMode = undefined;
      round.blankGuessUsed = false;
      round.blankGuessContext = {
        playerId: blankId,
        reason: "active",
        resumePhase: "description",
      };
      round.summary = undefined;
      break;
    }
    case "gameOver":
      await finishRound(ctx, room, "good", "手动结束本局");
      return { phase: "gameOver" as WhoIsFakerPhase };
  }

  ctx.touch(room);
  broadcastPhaseAndPublish(ctx, room);
  // 跳转后让机器人补齐新阶段的提交，否则出题人永远推不动。
  await runBots(ctx, room);
  return { phase: round.phase };
};

export const testSetMyRole = async (
  ctx: WhoIsFakerContext,
  at: WhoIsFakerSeatAt,
  role: WhoIsFakerRole
) => {
  // 仅测试房间：强制替换当前玩家在本局中的角色分配。
  const { room, seat: player } = at;

  const round = requireRound(room);

  if (round.questionerPlayerId === player.id) {
    throw new AppError("INVALID_TARGET", "出题人不能切换身份");
  }

  if (!round.assignments[player.id]) {
    // 若当前玩家还没有分配（例如是旁观），不支持切换。
    throw new AppError("ACTION_FORBIDDEN", "仅已参与本局的玩家可切换身份");
  }

  const civilianWord = round.words?.civilianWord ?? TEST_MODE_DEFAULT_WORD[0];
  const undercoverWord = round.words?.undercoverWord ?? TEST_MODE_DEFAULT_WORD[1];

  const side = role === "undercover" ? "undercover" : role === "blank" ? "blank" : "good";
  const word = role === "undercover" ? undercoverWord : role === "blank" ? undefined : civilianWord;

  round.assignments[player.id] = {
    ...round.assignments[player.id],
    role,
    side,
    word,
    alive: true,
  };

  if (role === "blank" && round.words && !round.words.blankHint) {
    round.words.blankHint = "测试提示";
  }

  ctx.touch(room);
  publishRoom(ctx, room);
  return { role };
};

/**
 * 测试房间：批量补入机器人玩家。
 * 机器人是真实的 WhoIsFakerPlayerRecord，走与真人完全相同的规则校验，
 * 只是没有连接、由 runBots 代为提交发言/投票/夜晚行动。
 */
export const testAddBot = async (ctx: WhoIsFakerContext, at: WhoIsFakerSeatAt, count: number) => {
  const { room } = at;

  const added: string[] = [];

  for (let index = 0; index < count; index += 1) {
    if (getActivePlayerIds(room).length >= TEST_MODE_MAX_PLAYERS) {
      break;
    }

    const bot = ctx.createPlayer(pickBotName(room), true);
    bot.isReady = true;
    // 与真人加入同规则：局内加入只能旁观，下一局才参战。
    bot.membership = isRoundActive(room) ? "spectator" : "active";
    room.players[bot.id] = bot;
    added.push(bot.id);
  }

  if (added.length === 0) {
    throw new AppError("ROOM_FULL", `测试房间最多 ${TEST_MODE_MAX_PLAYERS} 名玩家`);
  }

  // 人数变了，阵营配置的上限也跟着变，必须重新夹一次。
  normalizeRoomRoleConfig(room);
  ctx.touch(room);
  publishRoom(ctx, room);
  await runBots(ctx, room);

  return { added };
};

/** 测试房间：移除机器人。未指定 playerId 时从最后加入的开始移除。 */
export const testRemoveBot = async (
  ctx: WhoIsFakerContext,
  at: WhoIsFakerSeatAt,
  playerId: string | undefined,
  count: number
) => {
  const { room } = at;

  const bots = Object.values(room.players).filter((player) => player.isBot);
  const targets = playerId ? bots.filter((bot) => bot.id === playerId) : bots.slice(-count);

  if (targets.length === 0) {
    throw new AppError("PLAYER_NOT_FOUND", "没有可移除的机器人");
  }

  // 走与房主踢人完全相同的路径：局内淘汰、房主改选、阵营夹取、人数不足中止
  // 全都由 forceRemovePlayer 负责，机器人不再有独立的移除逻辑。
  for (const bot of targets) {
    await forceRemovePlayer(ctx, room, bot.id, "kicked");
  }

  // 机器人被踢后只是标记为 kicked，测试房间要真正腾出名额，因此彻底删除记录。
  for (const bot of targets) {
    delete room.players[bot.id];
  }

  normalizeRoomRoleConfig(room);
  ctx.touch(room);
  publishRoom(ctx, room);
  await runBots(ctx, room);

  return { removed: targets.map((bot) => bot.id) };
};
