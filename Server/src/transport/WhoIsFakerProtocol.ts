import { Type as t, type TSchema } from "@sinclair/typebox";
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
  t.String({ minLength: 1, maxLength: 50 }),
  t.String({ minLength: 1, maxLength: 50 }),
]);
export const DraftWordPairSchema = t.Tuple([
  t.String({ maxLength: 50 }),
  t.String({ maxLength: 50 }),
]);
export const GamePhaseSchema = t.Union(GAME_PHASES.map((p) => t.Literal(p)));
export const PlayerRoleSchema = t.Union(PLAYER_ROLES.map((r) => t.Literal(r)));
export const DisconnectResolutionSchema = t.Union([
  t.Literal("wait"),
  t.Literal("eliminate"),
]);

const EmptyPayloadSchema = t.Object({}, { additionalProperties: false });

const createMessageSchema = <TType extends string, TPayload extends TSchema>(
  type: TType,
  payload: TPayload,
) =>
  t.Object(
    {
      id: t.String({ minLength: 1, maxLength: 128 }),
      type: t.Literal(type),
      traceId: t.Optional(t.String({ maxLength: 128 })),
      roomId: t.Optional(t.String({ maxLength: 32 })),
      sessionToken: t.Optional(t.String({ maxLength: 128 })),
      payload,
    },
    { additionalProperties: false },
  );

export const WhoIsFakerMessageSchemas = {
  "lobby.subscribeRooms": createMessageSchema("lobby.subscribeRooms", EmptyPayloadSchema),
  "room.create": createMessageSchema(
    "room.create",
    t.Object(
      {
        roomId: t.String({ minLength: 1, maxLength: 32 }),
        name: t.String({ minLength: 1, maxLength: 40 }),
        visibility: VisibilitySchema,
        password: t.Optional(t.String({ maxLength: 64 })),
        allowSpectators: t.Boolean(),
        userName: t.String({ minLength: 1, maxLength: 32 }),
        roleConfig: t.Optional(RoleConfigSchema),
      },
      { additionalProperties: false },
    ),
  ),
  "room.join": createMessageSchema(
    "room.join",
    t.Object(
      {
        userName: t.String({ minLength: 1, maxLength: 32 }),
        password: t.Optional(t.String({ maxLength: 64 })),
      },
      { additionalProperties: false },
    ),
  ),
  "room.reconnect": createMessageSchema(
    "room.reconnect",
    t.Object(
      {
        roomId: t.String({ minLength: 1, maxLength: 32 }),
        sessionToken: t.String({ minLength: 1, maxLength: 128 }),
      },
      { additionalProperties: false },
    ),
  ),
  "room.leave": createMessageSchema("room.leave", EmptyPayloadSchema),
  "room.requestSync": createMessageSchema("room.requestSync", EmptyPayloadSchema),
  "player.rename": createMessageSchema(
    "player.rename",
    t.Object(
      {
        name: t.String({ minLength: 1, maxLength: 32 }),
      },
      { additionalProperties: false },
    ),
  ),
  "player.setSpectator": createMessageSchema(
    "player.setSpectator",
    t.Object(
      {
        spectator: t.Boolean(),
      },
      { additionalProperties: false },
    ),
  ),
  "player.setReady": createMessageSchema(
    "player.setReady",
    t.Object(
      {
        ready: t.Boolean(),
      },
      { additionalProperties: false },
    ),
  ),
  "room.updateSettings": createMessageSchema(
    "room.updateSettings",
    t.Object(
      {
        name: t.Optional(t.String({ minLength: 1, maxLength: 40 })),
        visibility: t.Optional(VisibilitySchema),
        password: t.Optional(t.String({ maxLength: 64 })),
        allowSpectators: t.Optional(t.Boolean()),
        roleConfig: t.Optional(RoleConfigSchema),
      },
      { additionalProperties: false },
    ),
  ),
  "room.kick": createMessageSchema(
    "room.kick",
    t.Object(
      {
        playerId: t.String({ minLength: 1, maxLength: 64 }),
      },
      { additionalProperties: false },
    ),
  ),
  "game.assignQuestioner": createMessageSchema(
    "game.assignQuestioner",
    t.Object(
      {
        playerId: t.String({ minLength: 1, maxLength: 64 }),
      },
      { additionalProperties: false },
    ),
  ),
  "game.submitWords": createMessageSchema(
    "game.submitWords",
    t.Object(
      {
        words: WordPairSchema,
        blankHint: t.Optional(t.String({ maxLength: 50 })),
        manualRoles: t.Optional(t.Record(t.String({ minLength: 1, maxLength: 64 }), PlayerRoleSchema)),
      },
      { additionalProperties: false },
    ),
  ),
  "game.advancePhase": createMessageSchema("game.advancePhase", EmptyPayloadSchema),
  "game.submitDescription": createMessageSchema(
    "game.submitDescription",
    t.Object(
      {
        text: t.String({ minLength: 1, maxLength: 500 }),
      },
      { additionalProperties: false },
    ),
  ),
  "game.submitVote": createMessageSchema(
    "game.submitVote",
    t.Object(
      {
        targetId: t.String({ minLength: 1, maxLength: 64 }),
      },
      { additionalProperties: false },
    ),
  ),
  "game.submitNightAction": createMessageSchema(
    "game.submitNightAction",
    t.Object(
      {
        targetId: t.Optional(t.Union([t.String({ minLength: 1, maxLength: 64 }), t.Null()])),
      },
      { additionalProperties: false },
    ),
  ),
  "game.submitBlankGuess": createMessageSchema(
    "game.submitBlankGuess",
    t.Object(
      {
        words: WordPairSchema,
      },
      { additionalProperties: false },
    ),
  ),
  "game.enterBlankGuess": createMessageSchema("game.enterBlankGuess", EmptyPayloadSchema),
  "game.updateBlankGuessDraft": createMessageSchema(
    "game.updateBlankGuessDraft",
    t.Object(
      {
        words: DraftWordPairSchema,
      },
      { additionalProperties: false },
    ),
  ),
  "game.reviewBlankGuess": createMessageSchema(
    "game.reviewBlankGuess",
    t.Object(
      {
        approve: t.Boolean(),
      },
      { additionalProperties: false },
    ),
  ),
  "game.resolveDisconnect": createMessageSchema(
    "game.resolveDisconnect",
    t.Object(
      {
        playerId: t.String({ minLength: 1, maxLength: 64 }),
        resolution: DisconnectResolutionSchema,
      },
      { additionalProperties: false },
    ),
  ),
  "chat.send": createMessageSchema(
    "chat.send",
    t.Object(
      {
        text: t.String({ minLength: 1, maxLength: 500 }),
      },
      { additionalProperties: false },
    ),
  ),
  "room.transferHost": createMessageSchema(
    "room.transferHost",
    t.Object(
      {
        playerId: t.String({ minLength: 1, maxLength: 64 }),
      },
      { additionalProperties: false },
    ),
  ),
  "test.jumpToPhase": createMessageSchema(
    "test.jumpToPhase",
    t.Object(
      {
        phase: GamePhaseSchema,
      },
      { additionalProperties: false },
    ),
  ),
  "test.setMyRole": createMessageSchema(
    "test.setMyRole",
    t.Object(
      {
        role: PlayerRoleSchema,
      },
      { additionalProperties: false },
    ),
  ),
  "test.addBot": createMessageSchema(
    "test.addBot",
    t.Object(
      {
        count: t.Optional(PositiveIntSchema),
      },
      { additionalProperties: false },
    ),
  ),
  "test.removeBot": createMessageSchema(
    "test.removeBot",
    t.Object(
      {
        playerId: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
        count: t.Optional(PositiveIntSchema),
      },
      { additionalProperties: false },
    ),
  ),
  "game.cancelVote": createMessageSchema("game.cancelVote", EmptyPayloadSchema),
  "game.cancelNightAction": createMessageSchema("game.cancelNightAction", EmptyPayloadSchema),
  "game.requestSupplement": createMessageSchema(
    "game.requestSupplement",
    t.Object(
      {
        playerIds: t.Array(t.String({ minLength: 1, maxLength: 64 }), { minItems: 1 }),
      },
      { additionalProperties: false },
    ),
  ),
  "game.startPhaseTimer": createMessageSchema(
    "game.startPhaseTimer",
    t.Object(
      {
        durationSeconds: PositiveIntSchema,
      },
      { additionalProperties: false },
    ),
  ),
  "game.stopPhaseTimer": createMessageSchema("game.stopPhaseTimer", EmptyPayloadSchema),
};

export const WhoIsFakerClientMessageSchema = t.Union(
  Object.values(WhoIsFakerMessageSchemas),
);

/**
 * 严格类型校验与解析客户端消息。
 * 遵循 TypeBox 单一真相源，所有 Schema 均开启 additionalProperties: false，拒绝非法 payload: null 与脏字段。
 */
export const parseWhoIsFakerMessage = (raw: unknown): WhoIsFakerClientMessage => {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AppError("INVALID_MESSAGE", "消息必须为合法 JSON 字符串");
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AppError("INVALID_MESSAGE", "消息必须为 JSON 对象");
  }

  const msgObj = parsed as Record<string, unknown>;
  const type = msgObj.type;
  if (typeof type !== "string") {
    throw new AppError("INVALID_MESSAGE", "消息类型 type 必须为字符串");
  }

  const schema = (WhoIsFakerMessageSchemas as Record<string, TSchema>)[type];
  if (!schema) {
    throw new AppError("UNKNOWN_MESSAGE_TYPE", `未知消息类型: ${type}`);
  }

  // 校验 payload 是否为有效对象（杜绝 payload: null 宽松转为 {}）
  if (msgObj.payload === null || typeof msgObj.payload !== "object" || Array.isArray(msgObj.payload)) {
    throw new AppError("INVALID_MESSAGE", "消息载荷 payload 必须为对象");
  }

  const errors = [...Value.Errors(schema, parsed)];
  if (errors.length > 0) {
    const first = errors[0];
    const path = first.path ? ` (${first.path})` : "";
    throw new AppError("INVALID_MESSAGE", `消息校验失败${path}: ${first.message}`);
  }

  return parsed as WhoIsFakerClientMessage;
};
