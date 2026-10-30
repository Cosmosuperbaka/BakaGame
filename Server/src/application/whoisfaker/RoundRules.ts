/** 回合规则判定：人数统计、就绪/人数/阶段校验、完成度判定、投票与描述记录构造。 */

import { AppError } from "../../domain/Errors";
import {
  getBlankPlayerId,
  getRoomRoleLimits,
  isRoleConfigSatisfied,
  shuffle,
} from "../../domain/Rules";
import {
  ABSTAIN_TARGET_ID,
  type DescriptionRecord,
  type GameRound,
  type NightActionRecord,
  type RoleConfig,
  type VoteRecord,
  type WhoIsFakerPlayerRecord,
  type WhoIsFakerRoomRecord,
} from "../../shared/Index";
import type { WhoIsFakerServiceInternals } from "./ServiceInternals";

/** 房间内在线玩家数。 */
export const getOnlineCount = (room: WhoIsFakerRoomRecord): number =>
  Object.values(room.players).filter((player) => player.online).length;

/** 正式席位（membership 为 active）的玩家 id，不含旁观者。 */
export const getActivePlayerIds = (room: WhoIsFakerRoomRecord): string[] =>
  Object.values(room.players)
    .filter((player) => player.membership === "active")
    .map((player) => player.id);

/** 阵营配置可参照的参战人数：出题人不占正式席位时，有没有在线旁观者决定了要不要留名额。 */
export const getConfigurableParticipantCount = (room: WhoIsFakerRoomRecord): number => {
  const activeIds = getActivePlayerIds(room);
  const hasOnlineSpectator = Object.values(room.players).some(
    (player) => player.membership === "spectator" && player.online
  );

  if (hasOnlineSpectator) {
    return activeIds.length;
  }

  return Math.max(activeIds.length - (activeIds.length > 0 ? 1 : 0), 0);
};

/** 指定出题人后的参战人数：旁观者出题时正式玩家全员参战，正式玩家出题时扣掉自身名额。 */
export const getParticipantCount = (room: WhoIsFakerRoomRecord, questionerId?: string): number => {
  const activeIds = getActivePlayerIds(room);

  if (!questionerId) {
    return getConfigurableParticipantCount(room);
  }

  const questioner = room.players[questionerId];

  if (questioner?.membership === "spectator") {
    return activeIds.length;
  }

  return Math.max(activeIds.filter((playerId) => playerId !== questionerId).length, 0);
};

/** 可被指定为出题人的在线成员：正式玩家与旁观者都有资格。 */
const getAssignableQuestionerCandidates = (room: WhoIsFakerRoomRecord): WhoIsFakerPlayerRecord[] =>
  Object.values(room.players).filter(
    (player) =>
      player.online && (player.membership === "active" || player.membership === "spectator")
  );

/** 当前阵营配置下是否还存在合法的出题人人选。 */
export const hasValidQuestionerCandidate = (room: WhoIsFakerRoomRecord): boolean =>
  getAssignableQuestionerCandidates(room).some((candidate) =>
    isRoleConfigSatisfied(room.settings.roleConfig, getParticipantCount(room, candidate.id))
  );

/** 按参战人数上限夹住阵营配置：天使与白板只在人数允许时保留。 */
export const clampRoleConfig = (config: RoleConfig, participantCount: number): RoleConfig => {
  const limits = getRoomRoleLimits(Math.max(participantCount, 0));

  return {
    undercoverCount: Math.max(1, Math.min(config.undercoverCount || 1, limits.maxUndercoverCount)),
    hasAngel: limits.canEnableAngel && config.hasAngel,
    hasBlank: limits.canEnableBlank && config.hasBlank,
  };
};

/** 按当前房间人数重算已保存的阵营配置。 */
export const normalizeRoomRoleConfig = (room: WhoIsFakerRoomRecord): void => {
  room.settings.roleConfig = clampRoleConfig(
    room.settings.roleConfig,
    getConfigurableParticipantCount(room)
  );
};

/** 房主没有准备态：开局只看其他参与者，房主不必先发准备指令。 */
export const ensureAllReady = (room: WhoIsFakerRoomRecord): void => {
  const everyoneReady = Object.values(room.players)
    .filter((player) => player.membership === "active" && player.id !== room.hostPlayerId)
    .every((player) => player.isReady);

  if (!everyoneReady) {
    throw new AppError("NOT_ALL_READY", "还有玩家未准备");
  }
};

/** 开局人数门槛：凑不齐参战人数，或指定不出合法出题人，都拒绝开局。 */
export const ensureMinimumPlayers = (room: WhoIsFakerRoomRecord): void => {
  const activeCount = Object.values(room.players).filter(
    (player) => player.membership === "active"
  ).length;

  // 对局需要 4 名参战玩家，出题人不参战：
  // 有在线旁观者时旁观出题，4 名正式玩家即可；否则需正式玩家中出一人，至少 5 名。
  const hasOnlineSpectator = Object.values(room.players).some(
    (player) => player.membership === "spectator" && player.online
  );
  const requiredActive = hasOnlineSpectator ? 4 : 5;

  if (activeCount < requiredActive) {
    throw new AppError(
      "INSUFFICIENT_PLAYERS",
      hasOnlineSpectator ? "游戏至少需要 4 名玩家" : "游戏至少需要 4 名玩家和 1 名出题人"
    );
  }

  if (!hasValidQuestionerCandidate(room)) {
    throw new AppError("INSUFFICIENT_PLAYERS", "当前人数与阵营配置下无法指定合法出题人");
  }
};

/** 有掉线玩家待处理或出题人重连倒计时未走完时，阶段不许推进。 */
export const ensurePhaseNotBlocked = (round: GameRound): void => {
  if (round.pendingDisconnectPlayerIds.length > 0) {
    throw new AppError("PLAYER_PENDING", "仍有掉线玩家等待出题人处理");
  }

  if (round.questionerReconnectDeadlineAt) {
    throw new AppError("QUESTIONER_PENDING", "出题人重连倒计时尚未结束");
  }
};

/** 投票资格校验：存活、不投自己，平票第二轮只能由非候选人生存者投给候选人或弃票。 */
export const ensureCanVote = (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord,
  voterId: string,
  targetId: string,
  tieBreak: boolean
): void => {
  const round = service.requireRound(room);
  const voter = round.assignments[voterId];
  const target = round.assignments[targetId];
  const isAbstain = targetId === ABSTAIN_TARGET_ID;

  // 不能投自己，测试房间同样适用：测试房要复现真实规则。
  if (!voter?.alive || (!isAbstain && !target?.alive) || (!isAbstain && voterId === targetId)) {
    throw new AppError("INVALID_VOTE", "投票对象无效");
  }

  if (tieBreak) {
    const candidates = round.tieBreak?.candidateIds ?? [];

    if (candidates.includes(voterId)) {
      throw new AppError("INVALID_VOTE", "平票玩家不能参与第二轮投票");
    }

    if (!isAbstain && !candidates.includes(targetId)) {
      throw new AppError("INVALID_VOTE", "第二轮只能投给平票玩家");
    }
  }
};

/** 常规描述阶段是否完成：每个存活玩家都已提交。 */
export const isDescriptionComplete = (round: GameRound): boolean => {
  const aliveIds = Object.entries(round.assignments)
    .filter(([, state]) => state.alive)
    .map(([playerId]) => playerId);

  return aliveIds.every((playerId) => round.descriptionSubmittedBy.includes(playerId));
};

/** 平票 PK 的描述段是否完成：候选人里还活着的都要补过一句。 */
export const isTieBreakDescriptionComplete = (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord
): boolean => {
  const round = service.requireRound(room);
  const candidates = round.tieBreak?.candidateIds ?? [];

  return candidates.every(
    (playerId) =>
      !round.assignments[playerId]?.alive || round.tieBreak?.descriptionsDone.includes(playerId)
  );
};

/** 投票阶段是否完成：该投的人都投了；平票第二轮里候选人自己不投。 */
export const isVotingComplete = (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord,
  tieBreak: boolean
): boolean => {
  const round = service.requireRound(room);
  const aliveIds = getAliveAssignedPlayerIds(service, room);

  if (tieBreak) {
    const candidates = round.tieBreak?.candidateIds ?? [];
    const voterIds = aliveIds.filter((playerId) => !candidates.includes(playerId));
    const votes = round.tieBreak?.votes ?? [];
    return voterIds.every((playerId) => votes.some((vote) => vote.voterId === playerId));
  }

  return aliveIds.every((playerId) => round.votes.some((vote) => vote.voterId === playerId));
};

/** 夜晚阶段是否完成：只有平民与卧底需要行动，其余角色不参与也不被等待。 */
export const isNightActionComplete = (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord
): boolean => {
  const round = service.requireRound(room);
  const actorIds = Object.entries(round.assignments)
    .filter(
      ([, state]) => state.alive && (state.role === "civilian" || state.role === "undercover")
    )
    .map(([playerId]) => playerId);

  return actorIds.every((playerId) =>
    round.nightActions.some((action) => action.actorId === playerId)
  );
};

/** 本局已分配身份且仍存活的玩家 id。 */
export const getAliveAssignedPlayerIds = (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord
): string[] =>
  Object.entries(service.requireRound(room).assignments)
    .filter(([, state]) => state.alive)
    .map(([playerId]) => playerId);

/** 本轮发言顺序：存活者洗牌；首日白板若落在前半段，随机换到后半段。 */
export const createDescriptionOrder = (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord
): string[] => {
  const round = service.requireRound(room);
  const order = shuffle(getAliveAssignedPlayerIds(service, room), service.random);

  if (round.day === 1) {
    const blankPlayerId = getBlankPlayerId(round.assignments);
    const blankIndex = blankPlayerId ? order.indexOf(blankPlayerId) : -1;
    const secondHalfStart = Math.floor(order.length / 2);

    if (blankIndex >= 0 && blankIndex < secondHalfStart) {
      const swapIndex = secondHalfStart + service.random.nextInt(order.length - secondHalfStart);
      [order[blankIndex], order[swapIndex]] = [order[swapIndex], order[blankIndex]];
    }
  }

  return order;
};

/** 改写某人的投票：同一投票人只保留最后一票。 */
export const replaceVote = (
  votes: VoteRecord[],
  voterId: string,
  targetId: string
): VoteRecord[] => {
  const nextVotes = votes.filter((vote) => vote.voterId !== voterId);
  nextVotes.push({ voterId, targetId });
  return nextVotes;
};

/** 改写某人的夜晚操作：同一行动者只保留最后一次提交。 */
export const replaceNightAction = (
  actions: NightActionRecord[],
  actorId: string,
  nextAction: NightActionRecord
): NightActionRecord[] => {
  const nextActions = actions.filter((action) => action.actorId !== actorId);
  nextActions.push(nextAction);
  return nextActions;
};

/** 构造一条描述记录：常规描述、补充描述与平票描述共用同一份结构，只靠 kind 区分。 */
export const createDescription = (
  service: WhoIsFakerServiceInternals,
  player: Pick<WhoIsFakerPlayerRecord, "id" | "name">,
  text: string,
  kind: DescriptionRecord["kind"],
  cycle: number,
  extra?: { tieBreakIndex?: number; supplementIndex?: number; order?: number }
): DescriptionRecord => {
  return {
    id: service.createId("description"),
    playerId: player.id,
    playerName: player.name,
    text,
    kind,
    cycle,
    tieBreakIndex: extra?.tieBreakIndex,
    supplementIndex: extra?.supplementIndex,
    order: extra?.order,
    createdAt: service.now(),
  };
};
