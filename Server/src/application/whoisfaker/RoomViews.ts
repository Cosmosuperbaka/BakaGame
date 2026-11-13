import { canSeeRoundSecrets } from "../../domain/Visibility";
import { getRoomRoleLimits } from "../../domain/Rules";
import {
  type DescriptionRecord,
  type GameRound,
  type PublicPlayerView,
  type RoundFeedback,
  type WhoIsFakerPlayerRecord,
  type WhoIsFakerPrivateState,
  type WhoIsFakerRoomRecord,
  type WhoIsFakerRoomSnapshot,
  type WhoIsFakerRoomSummary,
} from "../../shared/Index";
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
  const activeCount = Object.values(room.players).filter(
    (player) => player.membership === "active" && player.online
  ).length;
  const spectatorCount = Object.values(room.players).filter(
    (player) => player.membership === "spectator" && player.online
  ).length;
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

export const buildRoomSnapshot = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord
): WhoIsFakerRoomSnapshot => {
  // 快照是前端渲染主数据源，尽量保证“一包就够渲染当前房间”。
  const speechState = room.round ? getCurrentSpeechState(room.round) : undefined;

  const activeBlankGuess =
    room.round?.phase === "blankGuess" ? room.round.blankGuessContext : undefined;
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
    status: {
      phase: room.round?.phase ?? "waiting",
      roundId: room.round?.id,
      speechMode: room.round?.speechMode,
      speechResumePhase: room.round?.supplement?.resumePhase,
      supplementIndex: room.round?.supplement?.index,
      started: Boolean(room.round),
      day: room.round?.day ?? 0,
      descriptionOrder: room.round?.descriptionOrder,
      speechOrder: speechState ? [...speechState.order] : undefined,
      submittedSpeechPlayerIds: speechState ? [...speechState.submittedPlayerIds] : undefined,
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
    },
    players: buildPublicPlayers(ctx, room),
    descriptions: buildPublicDescriptions(room.round),
    chat: room.chat,
    summary: room.round?.summary,
  };
};

const buildPublicPlayers = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord
): PublicPlayerView[] => {
  return Object.values(room.players)
    .sort((left, right) => left.joinedAt - right.joinedAt)
    .map((player) => {
      const roundState = room.round?.assignments[player.id];
      const isQuestioner = room.round?.questionerPlayerId === player.id;

      let roundStatus: PublicPlayerView["roundStatus"] = "waiting";

      if (player.membership === "kicked") {
        roundStatus = "kicked";
      } else if (isQuestioner) {
        // 出题人身份凌驾于 active / spectator：旁观者也可以被指定出题。
        roundStatus = "questioner";
      } else if (player.membership === "spectator") {
        roundStatus = "spectator";
      } else if (roundState) {
        roundStatus = roundState.alive ? "alive" : "dead";
      }

      return {
        id: player.id,
        name: player.name,
        score: player.score,
        membership: player.membership,
        online: player.online,
        // 房主没有准备态，视图里恒为已准备，与另外两个游戏同口径；存储字段不动，转让后自然回到真实状态。
        isReady:
          player.isReady || (room.hostPlayerId === player.id && player.membership === "active"),
        isBot: player.isBot,
        ...(player.isAgent ? { isAgent: true } : {}),
        ...(ctx.connectionRegistry.isAgentDriven(player.connectionId)
          ? { mcpControlled: true }
          : {}),
        isHost: room.hostPlayerId === player.id,
        account: player.account,
        roundStatus,
        eliminatedAt: roundState && !roundState.alive ? roundState.eliminatedAt : undefined,
        revealedRole:
          roundState &&
          ((!roundState.alive && (room.settings.revealRoleOnDeath ?? true)) ||
            room.round?.phase === "gameOver")
            ? roundState.role
            : undefined,
      };
    });
};

export const buildPrivateState = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  player: WhoIsFakerPlayerRecord
): WhoIsFakerPrivateState => {
  // 房间公共快照永远不包含秘密信息，私有视图单独按连接发放。
  const round = room.round;
  const state = round?.assignments[player.id];
  const isQuestioner = Boolean(round && round.questionerPlayerId === player.id);
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
  const hasPrivilegedIdentityView = Boolean(round && (isQuestioner || spectatorSeesAnswers));

  if (!round) {
    return {
      playerId: player.id,
      sessionToken: player.sessionToken,
      canActAtNight: false,
      isQuestioner: false,
      canSubmitBlankGuess: false,
      blankGuessUsed: false,
      nightActionSubmitted: false,
    };
  }

  if (hasPrivilegedIdentityView) {
    return {
      playerId: player.id,
      sessionToken: player.sessionToken,
      canActAtNight: false,
      isQuestioner: round.questionerPlayerId === player.id,
      canSubmitBlankGuess: false,
      blankGuessUsed: round.blankGuessUsed,
      nightActionSubmitted: false,
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
    };
  }

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
