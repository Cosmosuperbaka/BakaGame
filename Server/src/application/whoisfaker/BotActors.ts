import {
  ABSTAIN_TARGET_ID,
  type GameRound,
  type WhoIsFakerPlayerRecord,
  type WhoIsFakerRoomRecord,
} from "../../shared/Index";
import { BOT_DESCRIPTION_TEMPLATES, BOT_NAME_SUFFIXES } from "../../config/Constants";
import { requeuePendingDisconnects } from "./OfflineSettlement";
import { publishRoomState } from "./RoomViews";
import {
  createDescription,
  getAliveAssignedPlayerIds,
  replaceNightAction,
  replaceVote,
} from "./RoundRules";
import type { WhoIsFakerServiceInternals } from "./ServiceInternals";

/** 发言位次：按给定的发言顺序表取 1 起的序号，不在表里的玩家不标序。 */
const speechOrderOf = (
  order: readonly string[] | undefined,
  playerId: string
): number | undefined => {
  const index = (order ?? []).indexOf(playerId) + 1;
  return index > 0 ? index : undefined;
};

/**
 * 机器人补齐当前阶段所有必需的提交。
 *
 * 机器人不走 execute 分支（它们没有连接），而是直接改 round 状态，
 * 但改的都是与真人命令完全相同的字段，因此
 * isDescriptionComplete / isVotingComplete / isNightActionComplete
 * 这些既有判定对机器人和真人是同一套逻辑。
 *
 * 只补「阻塞推进」的提交，不代替出题人推进阶段：
 * 测试房间要能停在每个阶段观察 UI。
 */
export const runBots = async (service: WhoIsFakerServiceInternals, room: WhoIsFakerRoomRecord) => {
  const round = room.round;

  if (!round || round.phase === "gameOver") {
    return;
  }

  const bots = Object.values(room.players).filter(
    (player) => player.isBot && round.assignments[player.id]?.alive
  );

  if (bots.length === 0) {
    return;
  }

  let changed = false;

  for (const bot of bots) {
    if (actAsBot(service, room, round, bot)) {
      changed = true;
    }
  }

  if (!changed) {
    return;
  }

  service.completeSupplementIfReady(room);

  service.touchRoom(room);
  requeuePendingDisconnects(service, room);
  publishRoomState(service, room);
};

/**
 * 让一个机器人在当前阶段补一次提交，返回它是否改动了房间状态。
 *
 * 短路顺序就是各阶段的判定顺序：投票目标与夜晚目标都要消耗随机数，多评或少评
 * 一个分支都会让抽出来的目标变化，因此照搬原 `runBots` 的分支次序。
 */
const actAsBot = (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord,
  round: GameRound,
  bot: WhoIsFakerPlayerRecord
): boolean => {
  return (
    fillBotSupplement(service, round, bot) ||
    fillBotDescription(service, round, bot) ||
    fillBotTieBreakDescription(service, round, bot) ||
    castBotVote(service, room, round, bot) ||
    actBotNight(service, room, round, bot)
  );
};

/** 补充发言：被点名且尚未补过的机器人补一句。优先级最高，与 handleSubmitDescription 的判定顺序一致。 */
const fillBotSupplement = (
  service: WhoIsFakerServiceInternals,
  round: GameRound,
  bot: WhoIsFakerPlayerRecord
): boolean => {
  const supplement = round.supplement;
  if (!supplement || round.speechMode !== "supplement") return false;
  if (!supplement.requestedPlayerIds.includes(bot.id) || supplement.donePlayers.includes(bot.id)) {
    return false;
  }

  supplement.donePlayers.push(bot.id);
  round.descriptions.push(
    createDescription(
      service,
      bot,
      pickBotDescription(round, bot.id),
      "supplement",
      round.descriptionCycle,
      {
        supplementIndex: supplement.index,
        order: speechOrderOf(supplement.requestedPlayerIds, bot.id),
      }
    )
  );
  return true;
};

/** 常规描述阶段：还没发过言的机器人补一句。 */
const fillBotDescription = (
  service: WhoIsFakerServiceInternals,
  round: GameRound,
  bot: WhoIsFakerPlayerRecord
): boolean => {
  if (round.phase !== "description" || round.speechMode === "supplement") return false;
  if (round.descriptionSubmittedBy.includes(bot.id)) return false;

  round.descriptionSubmittedBy.push(bot.id);
  round.descriptions.push(
    createDescription(
      service,
      bot,
      pickBotDescription(round, bot.id),
      "description",
      round.descriptionCycle,
      {
        order: speechOrderOf(round.descriptionOrder, bot.id),
      }
    )
  );
  return true;
};

/** 平票 PK 的描述阶段：还没发言的 PK 候选人补一句。 */
const fillBotTieBreakDescription = (
  service: WhoIsFakerServiceInternals,
  round: GameRound,
  bot: WhoIsFakerPlayerRecord
): boolean => {
  const tieBreak = round.tieBreak;
  if (round.phase !== "tieBreak" || tieBreak?.stage !== "description") return false;
  if (!tieBreak.candidateIds.includes(bot.id) || tieBreak.descriptionsDone.includes(bot.id))
    return false;

  tieBreak.descriptionsDone.push(bot.id);
  round.descriptions.push(
    createDescription(
      service,
      bot,
      pickBotDescription(round, bot.id),
      "tieBreak",
      round.descriptionCycle,
      {
        tieBreakIndex: round.tieBreakCount,
        order: speechOrderOf(tieBreak.candidateIds, bot.id),
      }
    )
  );
  return true;
};

/** 投票阶段（含平票 PK）：机器人投一票。PK 候选人本人不参与投票。 */
const castBotVote = (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord,
  round: GameRound,
  bot: WhoIsFakerPlayerRecord
): boolean => {
  const isVotePhase =
    round.phase === "voting" || (round.phase === "tieBreak" && round.tieBreak?.stage === "vote");
  if (!isVotePhase) return false;

  const tieBreak = round.phase === "tieBreak";
  const votes = tieBreak ? round.tieBreak!.votes : round.votes;

  // 平票 PK 中候选人本人不参与投票，与 ensureCanVote 一致。
  if (tieBreak && round.tieBreak!.candidateIds.includes(bot.id)) return false;
  if (votes.some((vote) => vote.voterId === bot.id)) return false;

  const targetId = pickBotVoteTarget(service, room, round, bot.id, tieBreak);
  if (tieBreak) {
    round.tieBreak!.votes = replaceVote(votes, bot.id, targetId);
  } else {
    round.votes = replaceVote(votes, bot.id, targetId);
  }
  return true;
};

/** 夜晚阶段：卧底机器人刀一个非自己的存活目标，平民一律不行动。 */
const actBotNight = (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord,
  round: GameRound,
  bot: WhoIsFakerPlayerRecord
): boolean => {
  if (round.phase !== "night") return false;

  const state = round.assignments[bot.id];

  // 只有平民和卧底有夜晚行动，天使/白板不参与也不被等待。
  if (state.role !== "civilian" && state.role !== "undercover") return false;
  if (round.nightActions.some((action) => action.actorId === bot.id)) return false;

  // 平民刀人会刀死自己，所以机器人平民一律不行动；
  // 卧底才去刀一个非自己的存活目标。
  const targetId =
    state.role === "undercover" ? pickBotNightTarget(service, room, bot.id) : undefined;

  round.nightActions = replaceNightAction(round.nightActions, bot.id, {
    actorId: bot.id,
    actorRole: state.role,
    targetId,
  });
  return true;
};

/** 机器人发言文案：按玩家在本局的位置轮换模板，读起来不至于全场雷同。 */
const pickBotDescription = (round: GameRound, botId: string) => {
  const ids = Object.keys(round.assignments).sort();
  const index = Math.max(ids.indexOf(botId), 0) + round.descriptionCycle;
  return BOT_DESCRIPTION_TEMPLATES[index % BOT_DESCRIPTION_TEMPLATES.length];
};

/** 机器人投票：在合法目标里随机取一个，取不到就弃票。 */
const pickBotVoteTarget = (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord,
  round: GameRound,
  botId: string,
  tieBreak: boolean
): string => {
  const candidates = tieBreak
    ? (round.tieBreak?.candidateIds ?? []).filter((id) => round.assignments[id]?.alive)
    : getAliveAssignedPlayerIds(service, room).filter((id) => id !== botId);

  if (candidates.length === 0) {
    return ABSTAIN_TARGET_ID;
  }

  return candidates[service.random.nextInt(candidates.length)] ?? ABSTAIN_TARGET_ID;
};

/** 机器人卧底的夜晚目标：随机一个非自己的存活玩家。 */
const pickBotNightTarget = (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord,
  botId: string
) => {
  const candidates = getAliveAssignedPlayerIds(service, room).filter((id) => id !== botId);

  if (candidates.length === 0) {
    return undefined;
  }

  return candidates[service.random.nextInt(candidates.length)];
};

/** 机器人取「机器人A」这类不重名的名字，便于在玩家列里区分。 */
export const pickBotName = (room: WhoIsFakerRoomRecord) => {
  const used = new Set(Object.values(room.players).map((player) => player.name));

  for (const suffix of BOT_NAME_SUFFIXES) {
    const candidate = `机器人${suffix}`;

    if (!used.has(candidate)) {
      return candidate;
    }
  }

  let index = BOT_NAME_SUFFIXES.length + 1;

  while (used.has(`机器人${index}`)) {
    index += 1;
  }

  return `机器人${index}`;
};
