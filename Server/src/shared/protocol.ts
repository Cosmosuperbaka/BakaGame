import type {
  DisconnectResolution,
  GamePhase,
  PlayerRole,
  RoleConfig,
  RoomVisibility,
} from "./model";

// ==================== WebSocket 协议封包类型 ====================

export interface ClientEnvelope<TType extends string, TPayload> {
  id: string;
  type: TType;
  roomId?: string;
  sessionToken?: string;
  payload: TPayload;
}

export interface AckPacket {
  type: "ack";
  id: string;
  requestType: string;
  payload?: unknown;
}

export interface ErrorPacket {
  type: "error";
  id: string;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface EventPacket {
  type: "event";
  event: string;
  payload: unknown;
}

export type StatePathSegment = string | number;

export type StatePatchOperation =
  | { op: "set"; path: StatePathSegment[]; value: unknown }
  | { op: "delete"; path: StatePathSegment[] };

export type StateSyncPayload<T> =
  | {
      mode: "full";
      revision: number;
      state: T;
    }
  | {
      mode: "patch";
      baseRevision: number;
      revision: number;
      operations: StatePatchOperation[];
    };

export type ServerMessage = AckPacket | ErrorPacket | EventPacket;

// 所有客户端命令的联合类型。
export type ClientMessage =
  | ClientEnvelope<"lobby.subscribeRooms", Record<string, never>>
  | ClientEnvelope<
      "room.create",
      {
        roomId: string;
        name: string;
        visibility: RoomVisibility;
        password?: string;
        allowSpectators: boolean;
        userName: string;
        roleConfig?: RoleConfig;
      }
    >
  | ClientEnvelope<
      "room.join",
      {
        userName: string;
        password?: string;
      }
    >
  | ClientEnvelope<
      "room.reconnect",
      {
        roomId: string;
        sessionToken: string;
      }
    >
  | ClientEnvelope<"room.leave", Record<string, never>>
  | ClientEnvelope<"room.requestSync", Record<string, never>>
  | ClientEnvelope<"player.rename", { name: string }>
  | ClientEnvelope<"player.setSpectator", { spectator: boolean }>
  | ClientEnvelope<"player.setReady", { ready: boolean }>
  | ClientEnvelope<
      "room.updateSettings",
      {
        name?: string;
        visibility?: RoomVisibility;
        password?: string;
        allowSpectators?: boolean;
        roleConfig?: RoleConfig;
      }
    >
  | ClientEnvelope<"room.kick", { playerId: string }>
  | ClientEnvelope<"game.assignQuestioner", { playerId: string }>
  | ClientEnvelope<
      "game.submitWords",
      {
        words: [string, string];
        blankHint?: string;
        manualRoles?: Record<string, PlayerRole>;
      }
    >
  | ClientEnvelope<"game.advancePhase", Record<string, never>>
  | ClientEnvelope<"game.submitDescription", { text: string }>
  | ClientEnvelope<"game.submitVote", { targetId: string }>
  | ClientEnvelope<"game.submitNightAction", { targetId?: string | null }>
  | ClientEnvelope<"game.submitBlankGuess", { words: [string, string] }>
  | ClientEnvelope<"game.enterBlankGuess", Record<string, never>>
  | ClientEnvelope<"game.updateBlankGuessDraft", { words: [string, string] }>
  | ClientEnvelope<"game.reviewBlankGuess", { approve: boolean }>
  | ClientEnvelope<
      "game.resolveDisconnect",
      { playerId: string; resolution: DisconnectResolution }
    >
  | ClientEnvelope<"chat.send", { text: string }>
  | ClientEnvelope<"room.transferHost", { playerId: string }>
  | ClientEnvelope<"test.jumpToPhase", { phase: GamePhase }>
  | ClientEnvelope<"test.setMyRole", { role: PlayerRole }>
  | ClientEnvelope<"test.addBot", { count?: number }>
  | ClientEnvelope<"test.removeBot", { playerId?: string; count?: number }>
  | ClientEnvelope<"game.cancelVote", Record<string, never>>
  | ClientEnvelope<"game.cancelNightAction", Record<string, never>>
  | ClientEnvelope<"game.requestSupplement", { playerIds: string[] }>;
