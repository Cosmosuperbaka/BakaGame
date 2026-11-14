import { canSeeRoundSecrets } from "../../domain/Visibility";
import { getRoomRoleLimits } from "../../domain/Rules";
import {
  type DescriptionRecord,
  type GameRound,
  type PublicPlayerView,
  type RoundFeedback,
  type WhoIsFakerPlayerRecord,
  type WhoIsFakerPrivateState,
  type WhoIsFakerRole,
  type WhoIsFakerRoomRecord,
  type WhoIsFakerRoomSnapshot,
  type WhoIsFakerRoomSummary,
} from "../../shared/Index";
import { countOnlineByMembership } from "../room/RoomSummaries";
import { isGhostChatActive, isRoundActive, spectatorReadsGhostChat } from "./RoomAccess";
import { getConfigurableParticipantCount, getCurrentSpeechState } from "./RoundRules";
import type { WhoIsFakerContext } from "./Context";

/** 大厅列表：测试房间不出现，避免污染正式用户视线。 */
export const listRoomSummaries = (ctx: WhoIsFakerContext): WhoIsFakerRoomSummary[] =>
  [...ctx.rooms.values()]
    .filter((room) => !ctx.testRooms.isTestRoom(room.id))
    .map((room) => buildRoomSummary(ctx, room))
    .sort((left, right) => left.roomId.localeCompare(right.roomId));

export const buildRoomSummary = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord
): WhoIsFakerRoomSummary => {
  const { active: activeCount, spectator: spectatorCount } = countOnlineByMembership(
    Object.values(room.players)
  );
  return {
    roomId: room.id,
    name: room.settings.name,
    visibility: room.settings.visibility,
    allowSpectators: room.settings.allowSpectators,
    hasPassword: Boolean(room.passwordHash),
    playerCount: activeCount,
    spectatorCount,
    onlineCount: activeCount + spectatorCount,
    phase: room.round?.phase ?? "waiting",
    testMode: ctx.testRooms.isTestRoom(room.id),
    allowAgents: room.settings.allowAgents === true,
  };
};

const buildPublicDescriptions = (round: GameRound | undefined): DescriptionRecord[] => {
  if (!round) {
    return [];
  }

  const speechState = getCurrentSpeechState(round);

  if (!speechState) {
    return round.descriptions;
  }

  const submitted = new Set(speechState.submittedPlayerIds);
  const revealed = new Set<string>();

  for (const playerId of speechState.order) {
    if (!submitted.has(playerId)) {
      break;
    }
    revealed.add(playerId);
  }

  const historical = round.descriptions.filter((description) => !speechState.matches(description));
  const currentByPlayer = new Map(
    round.descriptions
      .filter((description) => speechState.matches(description))
      .map((description) => [description.playerId, description])
  );

  return [
    ...historical,
    ...speechState.order.flatMap((playerId) => {
      if (!revealed.has(playerId)) {
        return [];
      }
      const description = currentByPlayer.get(playerId);
      return description ? [description] : [];
    }),
  ];
};

/** 关闭死亡身份揭露时抹掉去向预告：它由真实身份算出，会反推出局者是谁。 */
const publicFeedback = (room: WhoIsFakerRoomRecord): RoundFeedback | undefined => {
  const feedback = room.round?.feedback;
  if (!feedback || (room.settings.revealRoleOnDeath ?? true)) return feedback;
  return { ...feedback, next: "continue" };
};

const buildStatusView = (room: WhoIsFakerRoomRecord): WhoIsFakerRoomSnapshot["status"] => {
  const speechState = room.round ? getCurrentSpeechState(room.round) : undefined;
  const phase = room.round?.phase ?? "waiting";
  const activeBlankGuess =
    room.round?.phase === "blankGuess" ? room.round.blankGuessContext : undefined;
  return {
    phase,
    roundId: room.round?.id,
    // 发言模式与两份名单在任何阶段都下发，取值与客户端原先「按阶段回退」的结果一致，
    // 客户端因此不必再自己判断当前算哪种发言。
    speechMode: room.round?.speechMode ?? (phase === "tieBreak" ? "tieBreak" : "normal"),
    speechResumePhase: room.round?.supplement?.resumePhase,
    supplementIndex: room.round?.supplement?.index,
    started: Boolean(room.round),
    day: room.round?.day ?? 0,
    descriptionOrder: room.round?.descriptionOrder,
    speechOrder: speechState ? [...speechState.order] : [],
    submittedSpeechPlayerIds: speechState ? [...speechState.submittedPlayerIds] : [],
    questionerPlayerId: room.round?.questionerPlayerId,
    tieBreakStage: room.round?.tieBreak?.stage,
    tieBreakIndex: room.round?.tieBreak ? room.round.tieBreakCount : undefined,
    tieBreakCandidateIds: room.round?.tieBreak?.candidateIds,
    pendingDisconnectPlayerId: room.round?.pendingDisconnectPlayerIds[0],
    questionerReconnectDeadlineAt: room.round?.questionerReconnectDeadlineAt,
    // 反馈阶段仍保留猜词上下文供续接使用，但对外只在猜词阶段公开。
    blankGuessPlayerId: activeBlankGuess?.playerId,
    blankGuessReason: activeBlankGuess?.reason,
    blankGuessDraft: activeBlankGuess?.pendingReview?.words ?? activeBlankGuess?.draft,
    blankGuessPendingReview: activeBlankGuess?.pendingReview ? true : undefined,
    pendingSupplementPlayerIds: room.round?.supplement
      ? room.round.supplement.requestedPlayerIds.filter(
          (id) => !room.round!.supplement!.donePlayers.includes(id)
        )
      : undefined,
    phaseTimer: room.round?.phaseTimer,
    feedback: publicFeedback(room),
  };
};

export const buildRoomSnapshot = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord
): WhoIsFakerRoomSnapshot => {
  // 快照是前端渲染主数据源，尽量保证“一包就够渲染当前房间”。
  return {
    roomId: room.id,
    name: room.settings.name,
    visibility: room.settings.visibility,
    allowSpectators: room.settings.allowSpectators,
    hasPassword: Boolean(room.passwordHash),
    hostPlayerId: room.hostPlayerId,
    testMode: ctx.testRooms.isTestRoom(room.id),
    roleLimits: getRoomRoleLimits(getConfigurableParticipantCount(room)),
    settings: {
      roleConfig: room.settings.roleConfig,
      revealRoleOnDeath: room.settings.revealRoleOnDeath ?? true,
      spectatorsSeeAnswers: room.settings.spectatorsSeeAnswers ?? false,
      allowAgents: room.settings.allowAgents === true,
    },
    status: buildStatusView(room),
    players: buildPublicPlayers(ctx, room),
    descriptions: buildPublicDescriptions(room.round),
    chat: room.chat,
    summary: room.round?.summary,
  };
};

const roundStatusOf = (
  room: WhoIsFakerRoomRecord,
  player: WhoIsFakerPlayerRecord
): PublicPlayerView["roundStatus"] => {
  if (player.membership === "kicked") return "kicked";
  // 出题人身份凌驾于 active / spectator：旁观者也可以被指定出题。
  if (room.round?.questionerPlayerId === player.id) return "questioner";
  if (player.membership === "spectator") return "spectator";
  const roundState = room.round?.assignments[player.id];
  if (roundState) return roundState.alive ? "alive" : "dead";
  return "waiting";
};

const buildPublicPlayer = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  player: WhoIsFakerPlayerRecord
): PublicPlayerView => {
  const roundState = room.round?.assignments[player.id];
  return {
    id: player.id,
    name: player.name,
    score: player.score,
    membership: player.membership,
    online: player.online,
    // 房主没有准备态，视图里恒为已准备，与另外两个游戏同口径；存储字段不动，转让后自然回到真实状态。
    isReady: player.isReady || (room.hostPlayerId === player.id && player.membership === "active"),
    isBot: player.isBot,
    ...(player.isAgent ? { isAgent: true } : {}),
    ...(ctx.connectionRegistry.isAgentDriven(player.connectionId) ? { mcpControlled: true } : {}),
    isHost: room.hostPlayerId === player.id,
    account: player.account,
    roundStatus: roundStatusOf(room, player),
    eliminatedAt: roundState && !roundState.alive ? roundState.eliminatedAt : undefined,
    revealedRole:
      roundState &&
      ((!roundState.alive && (room.settings.revealRoleOnDeath ?? true)) ||
        room.round?.phase === "gameOver")
        ? roundState.role
        : undefined,
  };
};

const buildPublicPlayers = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord
): PublicPlayerView[] =>
  Object.values(room.players)
    .sort((left, right) => left.joinedAt - right.joinedAt)
    .map((player) => buildPublicPlayer(ctx, room, player));

const buildWaitingPrivateState = (player: WhoIsFakerPlayerRecord): WhoIsFakerPrivateState => ({
  playerId: player.id,
  sessionToken: player.sessionToken,
  canActAtNight: false,
  isQuestioner: false,
  canSubmitBlankGuess: false,
  blankGuessUsed: false,
  nightActionSubmitted: false,
});

/** 出词阶段出题人要凑齐的各身份人数：正式玩家去掉出题人自己，再按房间配置摊到四个身份。 */
const requiredRoleCountsFor = (
  room: WhoIsFakerRoomRecord,
  round: GameRound,
  player: WhoIsFakerPlayerRecord
): Record<WhoIsFakerRole, number> | undefined => {
  if (round.phase !== "wordSubmission" || round.questionerPlayerId !== player.id) return undefined;
  const { roleConfig } = room.settings;
  const participantCount = Object.values(room.players).filter(
    (item) => item.membership === "active" && item.id !== round.questionerPlayerId
  ).length;
  return {
    civilian:
      participantCount -
      roleConfig.undercoverCount -
      (roleConfig.hasAngel ? 1 : 0) -
      (roleConfig.hasBlank ? 1 : 0),
    undercover: roleConfig.undercoverCount,
    angel: roleConfig.hasAngel ? 1 : 0,
    blank: roleConfig.hasBlank ? 1 : 0,
  };
};

const buildPrivilegedPrivateState = (
  room: WhoIsFakerRoomRecord,
  round: GameRound,
  player: WhoIsFakerPlayerRecord
): WhoIsFakerPrivateState => ({
  playerId: player.id,
  sessionToken: player.sessionToken,
  canActAtNight: false,
  isQuestioner: round.questionerPlayerId === player.id,
  canSubmitBlankGuess: false,
  blankGuessUsed: round.blankGuessUsed,
  nightActionSubmitted: false,
  requiredRoleCounts: requiredRoleCountsFor(room, round, player),
  globalWords: round.words
    ? {
        civilianWord: round.words.civilianWord,
        undercoverWord: round.words.undercoverWord,
        blankHint: round.words.blankHint,
      }
    : undefined,
  questionerView: Object.entries(round.assignments).map(([playerId, item]) => ({
    playerId,
    role: item.role,
    side: item.side,
    alive: item.alive,
  })),
  privilegedActionPreview: {
    votes: round.phase === "tieBreak" ? (round.tieBreak?.votes ?? []) : round.votes,
    nightActions: round.nightActions.map(({ actorId, targetId }) => ({
      actorId,
      targetId,
    })),
  },
});

const buildParticipantPrivateState = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound,
  player: WhoIsFakerPlayerRecord
): WhoIsFakerPrivateState => {
  const state = round.assignments[player.id];
  return {
    playerId: player.id,
    sessionToken: player.sessionToken,
    canActAtNight:
      Boolean(state?.alive) && (state?.role === "civilian" || state?.role === "undercover"),
    specialRole: state?.role === "angel" || state?.role === "blank" ? state.role : undefined,
    // 调试身份只在测试房下发，普通房间的私有帧里没有任何能区分平民与卧底的字段。
    debugRole: ctx.testRooms.isTestRoom(room.id) ? state?.role : undefined,
    word: state?.role === "angel" ? undefined : state?.word,
    angelWordOptions: state?.role === "angel" && round.words ? round.words.pair : undefined,
    blankHint: state?.role === "blank" ? round.words?.blankHint : undefined,
    isQuestioner: false,
    // 只表示「还有猜词机会」。是否已在阻塞阶段由公共快照的
    // blankGuessPlayerId 表达，客户端据此决定显示入口还是输入界面。
    canSubmitBlankGuess: state?.role === "blank" && Boolean(state.alive) && !round.blankGuessUsed,
    blankGuessUsed: round.blankGuessUsed,
    nightActionSubmitted: round.nightActions.some((action) => action.actorId === player.id),
    myCurrentVoteTargetId:
      round.phase === "tieBreak"
        ? round.tieBreak?.votes.find((v) => v.voterId === player.id)?.targetId
        : round.votes.find((v) => v.voterId === player.id)?.targetId,
    myCurrentNightTargetId: round.nightActions.find((action) => action.actorId === player.id)
      ?.targetId,
  };
};

/**
 * 「现在轮到我了」的玩法规则，逐阶段与客户端原先的推导同值：
 * 发言看名单与已提交，投票看是否已投且不是 PK 候选，夜晚看行动资格与是否已提交。
 * 读的就是本次要下发的公开快照与私有态，两者天然同源，不会各算一套。
 */
const canActNow = (snapshot: WhoIsFakerRoomSnapshot, state: WhoIsFakerPrivateState): boolean => {
  const { status } = snapshot;
  const me = snapshot.players.find((player) => player.id === state.playerId);
  const alive = me?.roundStatus === "alive" && !state.isQuestioner;
  const order = status.speechOrder ?? [];
  const submitted = new Set(status.submittedSpeechPlayerIds ?? []);
  const spoken = !submitted.has(state.playerId);
  const canVote = (inTieBreak: boolean) =>
    alive &&
    !state.myCurrentVoteTargetId &&
    (!inTieBreak || !(status.tieBreakCandidateIds ?? []).includes(state.playerId));

  switch (status.phase) {
    case "assigningQuestioner":
      return me?.isHost === true;
    case "wordSubmission":
      return state.isQuestioner;
    case "description":
      // 补充发言只等被点名的人，普通描述等所有还没交的存活参与者。
      return (
        alive && spoken && (status.speechMode !== "supplement" || order.includes(state.playerId))
      );
    case "tieBreak":
      return status.tieBreakStage === "vote"
        ? canVote(true)
        : alive && spoken && order.includes(state.playerId);
    case "voting":
      return canVote(false);
    case "night":
      return Boolean(alive && state.canActAtNight && !state.nightActionSubmitted);
    case "blankGuess":
      return state.canSubmitBlankGuess && status.blankGuessPendingReview !== true;
    case "feedback":
      return state.isQuestioner || snapshot.testMode;
    default:
      return false;
  }
};

const buildSeatPrivateState = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  player: WhoIsFakerPlayerRecord
): WhoIsFakerPrivateState => {
  // 房间公共快照永远不包含秘密信息，私有视图单独按连接发放。
  const round = room.round;
  if (!round) return buildWaitingPrivateState(player);
  // 旁观者的上帝视角与「允许旁观」是两件事：进场资格由 allowSpectators 决定，
  // 进场后能看到多少由 spectatorsSeeAnswers 决定。开关关闭时局中只按普通连接发放，
  // 结算后答案随公开快照（summary 与 revealedRole）全房可见，这里不再收紧。
  const spectatorSeesAnswers =
    player.membership === "spectator" &&
    canSeeRoundSecrets(
      { setsRound: false, spectator: true },
      isRoundActive(room),
      room.settings.spectatorsSeeAnswers ?? false
    );
  if (round.questionerPlayerId === player.id || spectatorSeesAnswers)
    return buildPrivilegedPrivateState(room, round, player);
  return buildParticipantPrivateState(ctx, room, round, player);
};

export const buildPrivateState = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  player: WhoIsFakerPlayerRecord,
  snapshot: WhoIsFakerRoomSnapshot
): WhoIsFakerPrivateState => {
  const state = buildSeatPrivateState(ctx, room, player);
  state.canAct = canActNow(snapshot, state);
  return state;
};

const canViewerAccessGhostChat = (
  room: WhoIsFakerRoomRecord,
  player?: WhoIsFakerPlayerRecord
): boolean => {
  if (!room.round || !isGhostChatActive(room)) return true;
  if (!player) return false;
  if (player.membership === "spectator" && room.round.questionerPlayerId !== player.id) {
    return spectatorReadsGhostChat(room);
  }
  const assignment = room.round.assignments[player.id];
  if (assignment && !assignment.alive) {
    return true;
  }
  return false;
};

/** 公共快照按「能否看幽灵频道」分两种只读投影，缓存只活在本次发布里。 */
export const createRoomSnapshotViewSelector = (
  room: WhoIsFakerRoomRecord,
  snapshot: WhoIsFakerRoomSnapshot
) => {
  // 缓存只活在本次同步发布中；同权限连接共用只读投影，不能跨房间/阶段复用。
  const fullSnapshot = Object.freeze(snapshot);
  let mainChatSnapshot: Readonly<WhoIsFakerRoomSnapshot> | undefined;
  return (player?: WhoIsFakerPlayerRecord): Readonly<WhoIsFakerRoomSnapshot> => {
    if (canViewerAccessGhostChat(room, player)) {
      return fullSnapshot;
    }
    mainChatSnapshot ??= Object.freeze({
      ...fullSnapshot,
      chat: fullSnapshot.chat.filter((message) => message.channel !== "ghost"),
    });
    return mainChatSnapshot;
  };
};
