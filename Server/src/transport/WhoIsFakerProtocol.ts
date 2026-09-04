import { t } from "elysia";
import { Value } from "@sinclair/typebox/value";
import { AppError } from "../domain/Errors";
import {
  GAME_PHASES,
  PLAYER_ROLES,
  type ClientEnvelope,
  type ClientMessage,
  type WhoIsFakerClientMessage,
  type DisconnectResolution,
  type GamePhase,
  type PlayerRole,
  type RoleConfig,
  type RoomVisibility,
} from "../shared/Index";

export type { ClientEnvelope, ClientMessage, WhoIsFakerClientMessage };

export const VisibilitySchema = t.Union([t.Literal("public"), t.Literal("private")]);
export const BooleanSchema = t.Boolean();
export const PositiveIntSchema = t.Integer({ minimum: 1 });
export const RoleConfigSchema = t.Object(
  {
    undercoverCount: t.Integer({ minimum: 0 }),
    hasAngel: t.Boolean(),
    hasBlank: t.Boolean(),
  },
  { additionalProperties: false },
);
export const WordPairSchema = t.Tuple([
  t.String({ maxLength: 50 }),
  t.String({ maxLength: 50 }),
]);
export const GamePhaseSchema = t.Union(GAME_PHASES.map((p) => t.Literal(p)));
export const PlayerRoleSchema = t.Union(PLAYER_ROLES.map((r) => t.Literal(r)));
export const DisconnectResolutionSchema = t.Union([
  t.Literal("wait"),
  t.Literal("eliminate"),
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const MAX_DEFAULT_STRING_LENGTH = 500;

// 统一做字段级校验，保证业务层拿到的都是稳定结构。
const readString = (
  value: unknown,
  field: string,
  options?: {
    optional?: boolean;
    allowEmpty?: boolean;
    maxLength?: number;
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

  const maxLength = options?.maxLength ?? MAX_DEFAULT_STRING_LENGTH;
  if (value.length > maxLength) {
    throw new AppError("INVALID_MESSAGE", `${field} 长度不能超过 ${maxLength} 个字符`);
  }

  if (!options?.allowEmpty && value.trim().length === 0) {
    throw new AppError("INVALID_MESSAGE", `${field} 不能为空`);
  }

  return value;
};

const readBoolean = (value: unknown, field: string): boolean => {
  if (!Value.Check(BooleanSchema, value)) {
    throw new AppError("INVALID_MESSAGE", `${field} 必须为布尔值`);
  }

  return value;
};

const readPositiveInt = (
  value: unknown,
  field: string,
  options?: { optional?: boolean },
): number | undefined => {
  if (value == null) {
    if (options?.optional) {
      return undefined;
    }

    throw new AppError("INVALID_MESSAGE", `${field} 必须为正整数`);
  }

  if (!Value.Check(PositiveIntSchema, value)) {
    throw new AppError("INVALID_MESSAGE", `${field} 必须为正整数`);
  }

  return value;
};

const readVisibility = (value: unknown): RoomVisibility => {
  if (!Value.Check(VisibilitySchema, value)) {
    throw new AppError("INVALID_MESSAGE", "visibility 必须为 public 或 private");
  }

  return value as RoomVisibility;
};

// 阵营配置的解析比普通字段更严格，因为它会直接影响状态机合法性。
const readRoleConfig = (value: unknown): RoleConfig => {
  if (!isObject(value)) {
    throw new AppError("INVALID_MESSAGE", "roleConfig 必须为对象");
  }

  const undercoverCount = value.undercoverCount;
  const hasAngel = value.hasAngel;
  const hasBlank = value.hasBlank;

  if (!Value.Check(RoleConfigSchema, value)) {
    if (
      typeof undercoverCount !== "number" ||
      !Number.isInteger(undercoverCount) ||
      undercoverCount < 0
    ) {
      throw new AppError("INVALID_MESSAGE", "undercoverCount 必须为非负整数");
    }
    throw new AppError("INVALID_MESSAGE", "roleConfig 字段格式不正确");
  }

  return {
    undercoverCount: undercoverCount as number,
    hasAngel: readBoolean(hasAngel, "hasAngel"),
    hasBlank: readBoolean(hasBlank, "hasBlank"),
  };
};

const readWordPair = (value: unknown): [string, string] => {
  if (!Value.Check(WordPairSchema, value)) {
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== "string" ||
      typeof value[1] !== "string"
    ) {
      throw new AppError("INVALID_MESSAGE", "words 必须为长度为 2 的字符串数组");
    }

    throw new AppError("INVALID_MESSAGE", "每个词语长度不能超过 50 个字符");
  }

  return [value[0], value[1]];
};

/**
 * 猜词草稿。与 readWordPair 的区别是允许空串：
 * 白板边想边改，任一格暂时为空都是正常的输入过程。
 */
const readDraftPair = (value: unknown): [string, string] => {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    typeof value[1] !== "string"
  ) {
    throw new AppError("INVALID_MESSAGE", "words 必须为长度为 2 的字符串数组");
  }

  if (value[0].length > 50 || value[1].length > 50) {
    throw new AppError("INVALID_MESSAGE", "每个词语长度不能超过 50 个字符");
  }

  return [value[0], value[1]];
};

const readStringArray = (value: unknown, field: string, maxItems = 100, maxItemLength = 100): string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new AppError("INVALID_MESSAGE", `${field} 必须为字符串数组`);
  }

  if (value.length > maxItems) {
    throw new AppError("INVALID_MESSAGE", `${field} 数组长度不能超过 ${maxItems}`);
  }

  for (const item of value) {
    if (item.length > maxItemLength) {
      throw new AppError("INVALID_MESSAGE", `${field} 中的项目长度不能超过 ${maxItemLength} 个字符`);
    }
  }

  return value;
};

// manualRoles 每个值都必须是合法的 PlayerRole，仅做类型断言无法保证。
const parseManualRoles = (obj: Record<string, unknown>): Record<string, PlayerRole> => {
  const result: Record<string, PlayerRole> = {};
  for (const [playerId, role] of Object.entries(obj)) {
    if (!Value.Check(PlayerRoleSchema, role)) {
      throw new AppError("INVALID_MESSAGE", `manualRoles 中存在无效角色值: ${String(role)}`);
    }
    result[playerId] = role as PlayerRole;
  }
  return result;
};

export const parseWhoIsFakerMessage = (raw: unknown): ClientMessage => {
  // WebSocket 帧是字符串，测试直接传入已解析对象。
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new AppError("INVALID_MESSAGE", "消息必须为合法 JSON");
    }
  }

  if (!isObject(parsed)) {
    throw new AppError("INVALID_MESSAGE", "消息必须为 JSON 对象");
  }

  const id = readString(parsed.id, "id")!;
  const traceId = readString(parsed.traceId, "traceId", { optional: true });
  const type = readString(parsed.type, "type")!;
  const roomId = readString(parsed.roomId, "roomId", { optional: true });
  const sessionToken = readString(parsed.sessionToken, "sessionToken", {
    optional: true,
  });
  const payload = isObject(parsed.payload) ? parsed.payload : {};

  // 这里显式枚举每一类命令，既做运行时校验，也为后续重构留住边界。
  const message: ClientMessage = ((): ClientMessage => {
    switch (type) {
    case "lobby.subscribeRooms":
      return { id, type, roomId, sessionToken, payload: {} };
    case "room.create":
      return {
        id,
        type,
        payload: {
          roomId: readString(payload.roomId, "payload.roomId")!,
          name: readString(payload.name, "payload.name", { maxLength: 40 })!,
          visibility: readVisibility(payload.visibility),
          password: readString(payload.password, "payload.password", {
            optional: true,
            maxLength: 64,
          }),
          allowSpectators: readBoolean(
            payload.allowSpectators,
            "payload.allowSpectators",
          ),
          userName: readString(payload.userName, "payload.userName", { maxLength: 32 })!,
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
          userName: readString(payload.userName, "payload.userName", { maxLength: 32 })!,
          password: readString(payload.password, "payload.password", {
            optional: true,
            maxLength: 64,
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
    case "room.requestSync":
      return { id, type, roomId, sessionToken, payload: {} };
    case "player.rename":
      return {
        id,
        type,
        roomId,
        sessionToken,
        payload: { name: readString(payload.name, "payload.name", { maxLength: 32 })! },
      };
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
          name: readString(payload.name, "payload.name", { optional: true, maxLength: 40 }),
          visibility:
            payload.visibility == null ? undefined : readVisibility(payload.visibility),
          password: readString(payload.password, "payload.password", {
            optional: true,
            allowEmpty: true,
            maxLength: 64,
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
            maxLength: 50,
          }),
          manualRoles: isObject(payload.manualRoles)
            ? parseManualRoles(payload.manualRoles)
            : undefined,
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
        payload: { text: readString(payload.text, "payload.text", { maxLength: 300 })! },
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
    case "game.enterBlankGuess":
      return { id, type, roomId, sessionToken, payload: {} };
    case "game.updateBlankGuessDraft":
      // 草稿允许留空：白板一边想一边删，不该被当成非法输入。
      return {
        id,
        type,
        roomId,
        sessionToken,
        payload: { words: readDraftPair(payload.words) },
      };
    case "game.reviewBlankGuess":
      return {
        id,
        type,
        roomId,
        sessionToken,
        payload: { approve: readBoolean(payload.approve, "payload.approve") },
      };
    case "game.cancelVote":
      return { id, type, roomId, sessionToken, payload: {} };
    case "game.cancelNightAction":
      return { id, type, roomId, sessionToken, payload: {} };
    case "game.requestSupplement":
      return {
        id,
        type,
        roomId,
        sessionToken,
        payload: { playerIds: readStringArray(payload.playerIds, "payload.playerIds") },
      };
    case "game.startPhaseTimer":
      return {
        id,
        type,
        roomId,
        sessionToken,
        payload: {
          durationSeconds: readPositiveInt(payload.durationSeconds, "payload.durationSeconds")!,
        },
      };
    case "game.stopPhaseTimer":
      return { id, type, roomId, sessionToken, payload: {} };
    case "game.resolveDisconnect": {
      const resolution = readString(payload.resolution, "payload.resolution")!;

      if (!Value.Check(DisconnectResolutionSchema, resolution)) {
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
        payload: { text: readString(payload.text, "payload.text", { maxLength: 300 })! },
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

      if (!Value.Check(GamePhaseSchema, phase)) {
        throw new AppError("INVALID_MESSAGE", "phase 无效");
      }

      return {
        id,
        type,
        roomId,
        sessionToken,
        payload: { phase },
      };
    }
    case "test.setMyRole": {
      const role = readString(payload.role, "payload.role")!;

      if (!Value.Check(PlayerRoleSchema, role)) {
        throw new AppError("INVALID_MESSAGE", "role 无效");
      }

      return {
        id,
        type,
        roomId,
        sessionToken,
        payload: { role },
      };
    }
    case "test.addBot":
      return {
        id,
        type,
        roomId,
        sessionToken,
        payload: {
          count: readPositiveInt(payload.count, "payload.count", { optional: true }),
        },
      };
    case "test.removeBot":
      return {
        id,
        type,
        roomId,
        sessionToken,
        payload: {
          playerId: readString(payload.playerId, "payload.playerId", { optional: true }),
          count: readPositiveInt(payload.count, "payload.count", { optional: true }),
        },
      };
    default:
      throw new AppError("UNKNOWN_MESSAGE_TYPE", `未知消息类型: ${type}`);
    }
  })();

  if (traceId) {
    (message as { traceId?: string }).traceId = traceId;
  }
  return message;
};


export const parseClientMessage = parseWhoIsFakerMessage;
