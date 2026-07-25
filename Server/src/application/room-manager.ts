import type {
  ChatMessage,
  ConnectionRecord,
  PrivateState,
  PublicPlayerView,
  RoleConfig,
  RoomRecord,
  RoomSnapshot,
  RoomSummary,
} from "../domain/model";
import { ROOM_ID_TEST_MODE } from "../domain/model";
import { createDefaultRoleConfig, getRoomRoleLimits } from "../domain/rules";
import { AppError } from "../domain/errors";
import { CHAT_LIMIT } from "../config/constants";
import { createEvent } from "../transport/protocol";
import type { ConnectionRegistry } from "./connection-registry";

export class RoomManager {
  private readonly rooms = new Map<string, RoomRecord>();

  constructor(
    private readonly connectionRegistry: ConnectionRegistry,
    private readonly now: () => number,
  ) {}

  hasRoom(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  getRoom(roomId: string): RoomRecord {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new AppError("ROOM_NOT_FOUND", "房间不存在");
    }
    return room;
  }

  findRoom(roomId: string): RoomRecord | undefined {
    return this.rooms.get(roomId);
  }

  setRoom(roomId: string, room: RoomRecord): void {
    this.rooms.set(roomId, room);
  }

  deleteRoom(roomId: string): boolean {
    return this.rooms.delete(roomId);
  }

  getAllRooms(): RoomRecord[] {
    return Array.from(this.rooms.values());
  }

  get size(): number {
    return this.rooms.size;
  }

  touchRoom(room: RoomRecord): void {
    const currentTime = this.now();
    room.updatedAt = currentTime;
    room.lastActivityAt = currentTime;
  }

  getOnlineCount(room: RoomRecord): number {
    return Object.values(room.players).filter((player) => player.online).length;
  }

  getSpectatorCount(room: RoomRecord): number {
    return Object.values(room.players).filter(
      (player) => player.membership === "spectator",
    ).length;
  }

  getConfigurableParticipantCount(room: RoomRecord): number {
    return Object.values(room.players).filter(
      (player) => player.membership === "active" && !player.isBot,
    ).length;
  }

  clampRoleConfig(config: RoleConfig, playerCount: number): RoleConfig {
    const limits = getRoomRoleLimits(playerCount);

    return {
      undercoverCount:
        limits.maxUndercoverCount > 0
          ? Math.min(
              Math.max(config.undercoverCount, 1),
              limits.maxUndercoverCount,
            )
          : 0,
      hasAngel: limits.canEnableAngel ? config.hasAngel : false,
      hasBlank: limits.canEnableBlank ? config.hasBlank : false,
    };
  }

  buildRoomSummary(room: RoomRecord): RoomSummary {
    const activeCount = Object.values(room.players).filter(
      (player) => player.membership === "active",
    ).length;

    return {
      roomId: room.id,
      name: room.settings.name,
      visibility: room.settings.visibility,
      allowSpectators: room.settings.allowSpectators,
      hasPassword: Boolean(room.settings.password),
      playerCount: activeCount,
      onlineCount: this.getOnlineCount(room),
      phase: room.round?.phase ?? "waiting",
      testMode: room.id === ROOM_ID_TEST_MODE,
    };
  }

  getRoomSummaries(): RoomSummary[] {
    return Array.from(this.rooms.values())
      .filter((room) => room.id !== ROOM_ID_TEST_MODE)
      .map((room) => this.buildRoomSummary(room))
      .sort((left, right) => left.roomId.localeCompare(right.roomId));
  }

  buildPublicPlayerViews(room: RoomRecord): PublicPlayerView[] {
    const round = room.round;

    return Object.values(room.players)
      .map((player) => {
        const roundState = round?.assignments[player.id];
        let roundStatus: PublicPlayerView["roundStatus"] = "waiting";

        if (player.membership === "spectator") {
          roundStatus = "spectator";
        } else if (player.membership === "kicked") {
          roundStatus = "kicked";
        } else if (round) {
          if (player.id === round.questionerPlayerId) {
            roundStatus = "questioner";
          } else if (roundState?.alive) {
            roundStatus = "alive";
          } else {
            roundStatus = "dead";
          }
        }

        const revealedRole = round?.summary?.revealedRoles.find(
          (item) => item.playerId === player.id,
        )?.role;

        return {
          id: player.id,
          name: player.name,
          score: player.score,
          membership: player.membership,
          online: player.online,
          isReady: player.isReady,
          isBot: player.isBot,
          isHost: player.id === room.hostPlayerId,
          roundStatus,
          revealedRole,
        };
      })
      .sort((left, right) => playerOrderKey(left, room).localeCompare(playerOrderKey(right, room)));
  }

  createRoomSnapshot(room: RoomRecord): RoomSnapshot {
    const round = room.round;
    const participantCount = this.getConfigurableParticipantCount(room);
    const roleLimits = getRoomRoleLimits(participantCount);

    return {
      roomId: room.id,
      name: room.settings.name,
      visibility: room.settings.visibility,
      allowSpectators: room.settings.allowSpectators,
      hasPassword: Boolean(room.settings.password),
      hostPlayerId: room.hostPlayerId,
      testMode: room.id === ROOM_ID_TEST_MODE,
      roleLimits,
      settings: {
        roleConfig: room.settings.roleConfig,
      },
      status: {
        phase: round?.phase ?? "waiting",
        started: Boolean(round && round.phase !== "gameOver"),
        day: round?.day ?? 0,
        questionerPlayerId: round?.questionerPlayerId,
        tieBreakStage: round?.tieBreak?.stage,
        pendingDisconnectPlayerId: round?.pendingDisconnectPlayerIds[0],
        questionerReconnectDeadlineAt: round?.questionerReconnectDeadlineAt,
        blankGuessPlayerId: round?.blankGuessContext?.playerId,
      },
      players: this.buildPublicPlayerViews(room),
      descriptions: round?.descriptions ?? [],
      chat: room.chat,
      summary: round?.summary,
    };
  }

  createPrivateState(room: RoomRecord, playerId: string): PrivateState {
    const player = room.players[playerId];

    if (!player) {
      throw new AppError("PLAYER_NOT_FOUND", "玩家不存在");
    }

    const round = room.round;
    const isQuestioner = round?.questionerPlayerId === playerId;
    const assignment = round?.assignments[playerId];
    const isBlankPlayer = assignment?.role === "blank";
    const canSubmitBlankGuess =
      Boolean(isBlankPlayer) &&
      !round?.blankGuessUsed &&
      (round?.phase === "blankGuess"
        ? round.blankGuessContext?.playerId === playerId
        : Boolean(assignment?.alive));

    const nightActionSubmitted = Boolean(
      round?.nightActions.some((action) => action.actorId === playerId),
    );

    const angelWordOptions: [string, string] | undefined =
      assignment?.role === "angel" && round?.words
        ? [...round.words.pair].sort((left, right) => left.localeCompare(right)) as [
            string,
            string,
          ]
        : undefined;

    const questionerView =
      isQuestioner && round
        ? Object.entries(round.assignments).map(([targetId, state]) => ({
            playerId: targetId,
            role: state.role,
            side: state.side,
            alive: state.alive,
          }))
        : undefined;

    return {
      playerId,
      sessionToken: player.sessionToken,
      role: assignment?.role,
      side: assignment?.side,
      word: assignment?.word,
      angelWordOptions,
      blankHint: isBlankPlayer ? round?.words?.blankHint : undefined,
      isQuestioner,
      canSubmitBlankGuess,
      blankGuessUsed: Boolean(round?.blankGuessUsed),
      nightActionSubmitted,
      questionerView,
    };
  }

  publishLobby(): void {
    const payload = createEvent("lobby.roomsUpdated", {
      rooms: this.getRoomSummaries(),
    });
    this.connectionRegistry.broadcastToLobby(payload);
  }

  publishRoomState(room: RoomRecord): void {
    const snapshot = this.createRoomSnapshot(room);
    const roomConnections = this.connectionRegistry.getRoomConnections(room.id);

    for (const connection of roomConnections) {
      if (!connection.playerId) {
        continue;
      }

      try {
        const privateState = this.createPrivateState(room, connection.playerId);
        connection.send(
          createEvent("room.stateUpdated", {
            snapshot,
            privateState,
          }),
        );
      } catch {
        // 忽视推送异常
      }
    }
  }

  broadcastRoomEvent(room: RoomRecord, eventName: string, payload: unknown): void {
    const envelope = createEvent(eventName, payload);
    this.connectionRegistry.broadcastToRoom(room.id, envelope);
  }

  appendSystemMessage(room: RoomRecord, text: string): ChatMessage {
    const message: ChatMessage = {
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      playerId: "system",
      playerName: "系统",
      text,
      createdAt: this.now(),
      system: true,
    };

    room.chat.push(message);

    if (room.chat.length > CHAT_LIMIT) {
      room.chat = room.chat.slice(-CHAT_LIMIT);
    }

    return message;
  }
}

function playerOrderKey(player: PublicPlayerView, room: RoomRecord): string {
  const isHost = player.id === room.hostPlayerId ? "0" : "1";
  const isBot = player.isBot ? "1" : "0";
  return `${isHost}-${isBot}-${player.name}-${player.id}`;
}
