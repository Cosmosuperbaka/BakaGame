import { AppError } from "../domain/errors";
import {
  GAME_PHASES,
  PLAYER_ROLES,
  type DisconnectResolution,
  type GamePhase,
  type PlayerRole,
  type RoleConfig,
  type RoomVisibility,
} from "../domain/model";

// ==================== WebSocket 协议封包 ====================

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
  | ClientEnvelope<"game.submitWords", { words: [string, string]; blankHint?: string }>
  | ClientEnvelope<"game.advancePhase", Record<string, never>>
  | ClientEnvelope<"game.submitDescription", { text: string }>
  | ClientEnvelope<"game.submitVote", { targetId: string }>
  | ClientEnvelope<"game.submitNightAction", { targetId?: string | null }>
  | ClientEnvelope<"game.submitBlankGuess", { words: [string, string] }>
  | ClientEnvelope<
      "game.resolveDisconnect",
      { playerId: string; resolution: DisconnectResolution }
    >
  | ClientEnvelope<"chat.send", { text: string }>
  | ClientEnvelope<"room.transferHost", { playerId: string }>
  | ClientEnvelope<"test.jumpToPhase", { phase: GamePhase }>
  | ClientEnvelope<"test.setMyRole", { role: PlayerRole }>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

// 统一做字段级校验，保证业务层拿到的都是稳定结构。
const readString = (
  value: unknown,
  field: string,
  options?: {
    optional?: boolean;
    allowEmpty?: boolean;
  },
): string | undefined => {
  if (value == null) {
    if (options?.optional) {
      return undefined;
    }

    throw new AppError("INVALID_MESSAGE", `${field} 必须为字符串`);
  }

  if (typeof value !== "string") {
    throw new AppError("INVALID_MESSAGE", `${field} 必须为字符串`);
  }

  if (!options?.allowEmpty && value.trim().length === 0) {
    throw new AppError("INVALID_MESSAGE", `${field} 不能为空`);
  }

  return value;
};

const readBoolean = (value: unknown, field: string): boolean => {
  if (typeof value !== "boolean") {
    throw new AppError("INVALID_MESSAGE", `${field} 必须为布尔值`);
  }

  return value;
};

const readVisibility = (value: unknown): RoomVisibility => {
  if (value !== "public" && value !== "private") {
    throw new AppError("INVALID_MESSAGE", "visibility 必须为 public 或 private");
  }

  return value;
};

// 阵营配置的解析比普通字段更严格，因为它会直接影响状态机合法性。
const readRoleConfig = (value: unknown): RoleConfig => {
  if (!isObject(value)) {
    throw new AppError("INVALID_MESSAGE", "roleConfig 必须为对象");
  }

  const undercoverCount = value.undercoverCount;
  const hasAngel = value.hasAngel;
  const hasBlank = value.hasBlank;

  if (
    typeof undercoverCount !== "number" ||
    !Number.isInteger(undercoverCount) ||
    undercoverCount < 0
  ) {
    throw new AppError("INVALID_MESSAGE", "undercoverCount 必须为非负整数");
  }

  return {
    undercoverCount,
    hasAngel: readBoolean(hasAngel, "hasAngel"),
    hasBlank: readBoolean(hasBlank, "hasBlank"),
  };
};

const readWordPair = (value: unknown): [string, string] => {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    typeof value[1] !== "string"
  ) {
    throw new AppError("INVALID_MESSAGE", "words 必须为长度为 2 的字符串数组");
  }

  return [value[0], value[1]];
};

export const parseClientMessage = (raw: unknown): ClientMessage => {
  // 兼容字符串消息和运行时已解析对象。
  const parsed =
    typeof raw === "string" ? (JSON.parse(raw) as unknown) : (raw as unknown);

  if (!isObject(parsed)) {
    throw new AppError("INVALID_MESSAGE", "消息必须为 JSON 对象");
  }

  const id = readString(parsed.id, "id")!;
  const type = readString(parsed.type, "type")!;
  const roomId = readString(parsed.roomId, "roomId", { optional: true });
  const sessionToken = readString(parsed.sessionToken, "sessionToken", {
    optional: true,
  });
  const payload = isObject(parsed.payload) ? parsed.payload : {};

  // 这里显式枚举每一类命令，既做运行时校验，也为后续重构留住边界。
  switch (type) {
    case "lobby.subscribeRooms":
      return { id, type, roomId, sessionToken, payload: {} };
    case "room.create":
      return {
        id,
        type,
        payload: {
          roomId: readString(payload.roomId, "payload.roomId")!,
          name: readString(payload.name, "payload.name")!,
          visibility: readVisibility(payload.visibility),
          password: readString(payload.password, "payload.password", {
            optional: true,
          }),
          allowSpectators: readBoolean(
            payload.allowSpectators,
            "payload.allowSpectators",
          ),
          userName: readString(payload.userName, "payload.userName")!,
          roleConfig: payload.roleConfig
            ? readRoleConfig(payload.roleConfig)
            : undefined,
        },
      };
    case "room.join":
      return {
        id,
        type,
        roomId,
        sessionToken,
        payload: {
          userName: readString(payload.userName, "payload.userName")!,
          password: readString(payload.password, "payload.password", {
            optional: true,
          }),
        },
      };
    case "room.reconnect":
      return {
        id,
        type,
        payload: {
          roomId: readString(payload.roomId, "payload.roomId")!,
          sessionToken: readString(payload.sessionToken, "payload.sessionToken")!,
        },
      };
    case "room.leave":
      return { id, type, roomId, sessionToken, payload: {} };
    case "player.rename":
      return { id, type, roomId, sessionToken, payload: { name: readString(payload.name, "payload.name")! } };
    case "player.setSpectator":
      return {
        id,
        type,
        roomId,
        sessionToken,
        payload: {
          spectator: readBoolean(payload.spectator, "payload.spectator"),
        },
      };
    case "player.setReady":
      return {
        id,
        type,
        roomId,
        sessionToken,
        payload: { ready: readBoolean(payload.ready, "payload.ready") },
      };
    case "room.updateSettings":
      return {
        id,
        type,
        roomId,
        sessionToken,
        payload: {
          name: readString(payload.name, "payload.name", { optional: true }),
          visibility:
            payload.visibility == null ? undefined : readVisibility(payload.visibility),
          password: readString(payload.password, "payload.password", {
            optional: true,
            allowEmpty: true,
          }),
          allowSpectators:
            payload.allowSpectators == null
              ? undefined
              : readBoolean(payload.allowSpectators, "payload.allowSpectators"),
          roleConfig: payload.roleConfig
            ? readRoleConfig(payload.roleConfig)
            : undefined,
        },
      };
    case "room.kick":
      return {
        id,
        type,
        roomId,
        sessionToken,
        payload: { playerId: readString(payload.playerId, "payload.playerId")! },
      };
    case "game.assignQuestioner":
      return {
        id,
        type,
        roomId,
        sessionToken,
        payload: { playerId: readString(payload.playerId, "payload.playerId")! },
      };
    case "game.submitWords":
      return {
        id,
        type,
        roomId,
        sessionToken,
        payload: {
          words: readWordPair(payload.words),
          blankHint: readString(payload.blankHint, "payload.blankHint", {
            optional: true,
            allowEmpty: true,
          }),
        },
      };
    case "game.advancePhase":
      return { id, type, roomId, sessionToken, payload: {} };
    case "game.submitDescription":
      return {
        id,
        type,
        roomId,
        sessionToken,
        payload: { text: readString(payload.text, "payload.text")! },
      };
    case "game.submitVote":
      return {
        id,
        type,
        roomId,
        sessionToken,
        payload: { targetId: readString(payload.targetId, "payload.targetId")! },
      };
    case "game.submitNightAction":
      return {
        id,
        type,
        roomId,
        sessionToken,
        payload: {
          targetId:
            payload.targetId == null
              ? undefined
              : readString(payload.targetId, "payload.targetId"),
        },
      };
    case "game.submitBlankGuess":
      return {
        id,
        type,
        roomId,
        sessionToken,
        payload: { words: readWordPair(payload.words) },
      };
    case "game.resolveDisconnect": {
      const resolution = readString(payload.resolution, "payload.resolution")!;

      if (resolution !== "wait" && resolution !== "eliminate") {
        throw new AppError(
          "INVALID_MESSAGE",
          "payload.resolution 必须为 wait 或 eliminate",
        );
      }

      return {
        id,
        type,
        roomId,
        sessionToken,
        payload: {
          playerId: readString(payload.playerId, "payload.playerId")!,
          resolution,
        },
      };
    }
    case "chat.send":
      return {
        id,
        type,
        roomId,
        sessionToken,
        payload: { text: readString(payload.text, "payload.text")! },
      };
    case "room.transferHost":
      return {
        id,
        type,
        roomId,
        sessionToken,
        payload: { playerId: readString(payload.playerId, "payload.playerId")! },
      };
    case "test.jumpToPhase": {
      const phase = readString(payload.phase, "payload.phase")!;

      if (!GAME_PHASES.includes(phase as GamePhase)) {
        throw new AppError("INVALID_MESSAGE", "phase 无效");
      }

      return {
        id,
        type,
        roomId,
        sessionToken,
        payload: { phase: phase as GamePhase },
      };
    }
    case "test.setMyRole": {
      const role = readString(payload.role, "payload.role")!;

      if (!PLAYER_ROLES.includes(role as PlayerRole)) {
        throw new AppError("INVALID_MESSAGE", "role 无效");
      }

      return {
        id,
        type,
        roomId,
        sessionToken,
        payload: { role: role as PlayerRole },
      };
    }
    default:
      throw new AppError("UNKNOWN_MESSAGE_TYPE", `未知消息类型: ${type}`);
  }
};

export const createAck = (
  message: Pick<ClientMessage, "id" | "type">,
  payload?: unknown,
): AckPacket => ({
  type: "ack",
  id: message.id,
  requestType: message.type,
  payload,
});

export const createErrorPacket = (
  id: string,
  code: string,
  message: string,
  details?: unknown,
): ErrorPacket => ({
  type: "error",
  id,
  error: {
    code,
    message,
    details,
  },
});

export const createEvent = (event: string, payload: unknown): EventPacket => ({
  type: "event",
  event,
  payload,
});
