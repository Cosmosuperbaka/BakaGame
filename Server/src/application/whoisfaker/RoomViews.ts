import { createEvent } from "../../transport/Packets";
import { getRoomRoleLimits } from "../../domain/Rules";
import { controllerPrivateState, redactPrivateState } from "../McpSeatRegistry";
import {
  ROOM_ID_TEST_MODE,
  type ConnectionRecord,
  type DescriptionRecord,
  type GameRound,
  type PublicPlayerView,
  type WhoIsFakerPlayerRecord,
  type WhoIsFakerPrivateState,
  type WhoIsFakerRoomRecord,
  type WhoIsFakerRoomSnapshot,
  type WhoIsFakerRoomSummary,
} from "../../shared/Index";
import { handlePlayerOffline } from "./OfflineSettlement";
import { getConfigurableParticipantCount } from "./RoundRules";
import type { WhoIsFakerServiceInternals } from "./ServiceInternals";

export const buildRoomSummary = (room: WhoIsFakerRoomRecord): WhoIsFakerRoomSummary => {
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
    testMode: room.id === ROOM_ID_TEST_MODE,
    allowAgents: room.settings.allowAgents === true,
  };
};

/**
 * 统一描述、补充发言与平票 PK 的当前发言状态。
 * 提交状态可以公开，但内容只会按顺序公开连续完成的前缀。
 */
export const getCurrentSpeechState = (round: GameRound) => {
  if (round.phase === "description" && round.speechMode === "supplement" && round.supplement) {
    return {
      order: round.supplement.requestedPlayerIds,
      submittedPlayerIds: round.supplement.donePlayers,
      matches: (description: DescriptionRecord) =>
        description.kind === "supplement" &&
        description.supplementIndex === round.supplement?.index,
    };
  }

  if (round.phase === "tieBreak" && round.tieBreak?.stage === "description") {
    return {
      order: round.tieBreak.candidateIds,
      submittedPlayerIds: round.tieBreak.descriptionsDone,
      matches: (description: DescriptionRecord) =>
        description.kind === "tieBreak" && description.tieBreakIndex === round.tieBreakCount,
    };
  }

  if (round.phase === "description") {
    return {
      order: round.descriptionOrder,
      submittedPlayerIds: round.descriptionSubmittedBy,
      matches: (description: DescriptionRecord) =>
        description.kind === "description" && description.cycle === round.descriptionCycle,
    };
  }

  return undefined;
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

export const buildRoomSnapshot = (
  service: WhoIsFakerServiceInternals,
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
    testMode: room.id === ROOM_ID_TEST_MODE,
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
      feedback: room.round?.feedback,
    },
    players: buildPublicPlayers(service, room),
    descriptions: buildPublicDescriptions(room.round),
    chat: room.chat,
    summary: room.round?.summary,
  };
};

const buildPublicPlayers = (
  service: WhoIsFakerServiceInternals,
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
        ...(service.mcpSeats.isControlled(room.id, player.id) ? { mcpControlled: true } : {}),
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
  service: WhoIsFakerServiceInternals,
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
    ((room.settings.spectatorsSeeAnswers ?? false) || !service.isRoundActive(room));
  const hasPrivilegedIdentityView = Boolean(round && (isQuestioner || spectatorSeesAnswers));

  if (!round) {
    return {
      playerId: player.id,
      sessionToken: player.sessionToken,
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
    ...(service.mcpSeats.isControlled(room.id, player.id) ? { mcpControlled: true } : {}),
    role: state?.role,
    side: state?.side,
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
  if (
    !room.round ||
    !["description", "voting", "tieBreak", "night", "blankGuess", "feedback"].includes(
      room.round.phase
    )
  ) {
    return true;
  }
  if (!player) return false;
  if (player.membership === "spectator" && room.round.questionerPlayerId !== player.id) {
    return true;
  }
  const assignment = room.round.assignments[player.id];
  if (assignment && !assignment.alive) {
    return true;
  }
  return false;
};

const createRoomSnapshotViewSelector = (
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

export const publishRoomState = (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord,
  targetConnection?: ConnectionRecord
) => {
  // 每次状态变化都同时推送公共快照与当前连接的私有视图。
  const snapshot = buildRoomSnapshot(service, room);

  if (!targetConnection) {
    const phaseKey = service.getPhaseNoticeKey(snapshot);
    const previousPhaseKey = service.publishedPhaseKeyByRoomId.get(room.id);
    if (previousPhaseKey !== undefined && previousPhaseKey !== phaseKey) {
      service.appendSystemMessage(room, service.describePhaseChange(snapshot, room));
      snapshot.chat = room.chat;
    }
    service.publishedPhaseKeyByRoomId.set(room.id, phaseKey);
  }

  const selectSnapshot = createRoomSnapshotViewSelector(room, snapshot);
  const connections = targetConnection
    ? [targetConnection]
    : service.connectionRegistry.getRoomConnections(room.id);
  for (const connection of connections) {
    const player = connection.playerId ? room.players[connection.playerId] : undefined;
    const connectionSnapshot = selectSnapshot(player);

    connection.send(createEvent("room.snapshot", connectionSnapshot));

    if (connection.playerId && player) {
      connection.send(
        createEvent(
          "game.privateState",
          privateStateForConnection(service, room, player, connection)
        )
      );
    }
  }
};

/** 被 MCP 接管时，只有控制器连接能收到完整私有状态；人类页面只拿到脱敏视图。 */
export const privateStateForConnection = (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord,
  player: WhoIsFakerPlayerRecord,
  connection: ConnectionRecord
): WhoIsFakerPrivateState => {
  const state = buildPrivateState(service, room, player);
  const controller = service.mcpSeats.controllerFor(room.id, player.id);
  if (!controller) return state;
  if (controller.connectionId === connection.id) return controllerPrivateState(state);
  return redactPrivateState(
    "faker",
    state as unknown as Record<string, unknown>
  ) as unknown as WhoIsFakerPrivateState;
};

export const publishRoomStateCalibration = (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord
) => {
  const snapshot = buildRoomSnapshot(service, room);
  const selectSnapshot = createRoomSnapshotViewSelector(room, snapshot);
  for (const connection of service.connectionRegistry.getRoomConnections(room.id)) {
    const player = connection.playerId ? room.players[connection.playerId] : undefined;
    const connectionSnapshot = selectSnapshot(player);
    connection.sendStateSyncCalibration?.(createEvent("room.snapshot", connectionSnapshot));

    if (!connection.playerId || !player) continue;
    connection.sendStateSyncCalibration?.(
      createEvent("game.privateState", privateStateForConnection(service, room, player, connection))
    );
  }
};

export const publishLobby = (service: WhoIsFakerServiceInternals) => {
  service.lobbyFanout.request();
};

export const broadcastRoomEvent = (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord,
  event: string,
  payload: unknown
) => {
  service.connectionRegistry.broadcastToRoom(room.id, createEvent(event, payload));
};

export const attachConnection = (
  service: WhoIsFakerServiceInternals,
  room: WhoIsFakerRoomRecord,
  player: WhoIsFakerPlayerRecord,
  connection: ConnectionRecord
) => {
  // 目标先校验；旧席位断线状态和新绑定在首次 await 前完成，防止并发建房/同名加入穿透。
  // handlePlayerOffline 的 disconnect 分支在首个 await 前完成所有领域状态变更。
  const previousRoom = connection.roomId ? service.rooms.get(connection.roomId) : undefined;
  const previousRoomUpdate =
    previousRoom &&
    connection.playerId &&
    (previousRoom.id !== room.id || connection.playerId !== player.id)
      ? handlePlayerOffline(service, previousRoom, connection.playerId, "disconnect")
      : Promise.resolve();
  // 同一 sessionToken 只允许挂一个在线连接，新连接会顶掉旧连接。
  const previousConnection = service.getConnectionByPlayer(player.id);

  if (previousConnection && previousConnection.id !== connection.id) {
    // 旧连接多半已经死了（客户端断网才会重连），通知与关闭都不许抛：
    // 让顶号失败把新连接一起挡在门外，等于把一次掉线放大成进不去房。口径同 broadcastToRoom。
    try {
      previousConnection.send(
        createEvent("session.replaced", {
          roomId: room.id,
        })
      );
    } catch {
      /* 发不出去就不发，接管照常 */
    }
    previousConnection.playerId = undefined;
    previousConnection.roomId = undefined;
    try {
      previousConnection.close(4001, "session_replaced");
    } catch {
      /* 已经关掉的连接不需要再关一次 */
    }
  }

  player.online = true;
  room.emptySinceAt = undefined;
  player.connectionId = connection.id;
  player.account = connection.account;
  player.lastSeenAt = service.now();
  connection.resetStateSync?.();
  service.connectionRegistry.attach(connection, room.id, player.id);
  return previousRoomUpdate;
};
