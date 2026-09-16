import { Type as t, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { AppError } from "../domain/Errors";
import {
  CCB_GAME_MODES,
  CCB_SUBJECT_TYPES,
  type CCBClientMessage,
} from "../shared/Index";

// 本文件只挂载**当前已实现**的指令。对局类指令（`ccb.character.search` 与 `ccb.game.*`）的
// wire 格式已在 `shared/CCB.ts` 的 `CCBClientMessage` 里固化，P1 接入 `CCBRules.ts` 时在此
// 补齐对应 Schema 即可——先挂没有实现的 Schema 只会让客户端以为能调通。

export const CCBVisibilitySchema = t.Union([t.Literal("public"), t.Literal("private")]);
export const CCBGameModeSchema = t.Union(
  CCB_GAME_MODES.map((mode) => t.Literal(mode)),
);
export const CCBSubjectTypeSchema = t.Union(
  CCB_SUBJECT_TYPES.map((type) => t.Literal(type)),
);

/** 设置补丁：创建与修改共用一份，客户端只需提交要改的字段。 */
export const CCBSettingsPatchSchema = t.Object(
  {
    mode: t.Optional(CCBGameModeSchema),
    topNSubjects: t.Optional(t.Integer({ minimum: 0, maximum: 5_000 })),
    startYear: t.Optional(t.Integer({ minimum: 1900, maximum: 2200 })),
    endYear: t.Optional(t.Integer({ minimum: 1900, maximum: 2200 })),
    subjectTypes: t.Optional(t.Array(CCBSubjectTypeSchema, { minItems: 1, maxItems: 4 })),
    guessLimit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
    timeLimitMs: t.Optional(t.Integer({ minimum: 0, maximum: 3_600_000 })),
    textHint: t.Optional(t.Boolean()),
    blurHint: t.Optional(t.Boolean()),
    tagBan: t.Optional(t.Boolean()),
    globalPick: t.Optional(t.Boolean()),
  },
  { additionalProperties: false },
);

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

export const CCBMessageSchemas = {
  "ccb.lobby.subscribeRooms": createMessageSchema("ccb.lobby.subscribeRooms", EmptyPayloadSchema),
  "ccb.room.create": createMessageSchema(
    "ccb.room.create",
    t.Object(
      {
        roomId: t.String({ minLength: 1, maxLength: 32 }),
        name: t.String({ minLength: 1, maxLength: 40 }),
        visibility: CCBVisibilitySchema,
        password: t.Optional(t.String({ maxLength: 64 })),
        allowSpectators: t.Boolean(),
        userName: t.String({ minLength: 1, maxLength: 32 }),
        settings: t.Optional(CCBSettingsPatchSchema),
      },
      { additionalProperties: false },
    ),
  ),
  "ccb.room.join": createMessageSchema(
    "ccb.room.join",
    t.Object(
      {
        userName: t.String({ minLength: 1, maxLength: 32 }),
        password: t.Optional(t.String({ maxLength: 64 })),
      },
      { additionalProperties: false },
    ),
  ),
  "ccb.room.reconnect": createMessageSchema(
    "ccb.room.reconnect",
    t.Object(
      {
        roomId: t.String({ minLength: 1, maxLength: 32 }),
        sessionToken: t.String({ minLength: 1, maxLength: 128 }),
      },
      { additionalProperties: false },
    ),
  ),
  "ccb.room.leave": createMessageSchema("ccb.room.leave", EmptyPayloadSchema),
  "ccb.room.requestSync": createMessageSchema("ccb.room.requestSync", EmptyPayloadSchema),
  "ccb.room.updateSettings": createMessageSchema(
    "ccb.room.updateSettings",
    t.Object(
      {
        name: t.Optional(t.String({ minLength: 1, maxLength: 40 })),
        visibility: t.Optional(CCBVisibilitySchema),
        password: t.Optional(t.String({ maxLength: 64 })),
        allowSpectators: t.Optional(t.Boolean()),
        mode: t.Optional(CCBGameModeSchema),
        topNSubjects: t.Optional(t.Integer({ minimum: 0, maximum: 5_000 })),
        startYear: t.Optional(t.Integer({ minimum: 1900, maximum: 2200 })),
        endYear: t.Optional(t.Integer({ minimum: 1900, maximum: 2200 })),
        subjectTypes: t.Optional(t.Array(CCBSubjectTypeSchema, { minItems: 1, maxItems: 4 })),
        guessLimit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
        timeLimitMs: t.Optional(t.Integer({ minimum: 0, maximum: 3_600_000 })),
        textHint: t.Optional(t.Boolean()),
        blurHint: t.Optional(t.Boolean()),
        tagBan: t.Optional(t.Boolean()),
        globalPick: t.Optional(t.Boolean()),
      },
      { additionalProperties: false },
    ),
  ),
  "ccb.room.kick": createMessageSchema(
    "ccb.room.kick",
    t.Object(
      {
        playerId: t.String({ minLength: 1, maxLength: 64 }),
      },
      { additionalProperties: false },
    ),
  ),
  "ccb.room.transferHost": createMessageSchema(
    "ccb.room.transferHost",
    t.Object(
      {
        playerId: t.String({ minLength: 1, maxLength: 64 }),
      },
      { additionalProperties: false },
    ),
  ),
  "ccb.player.setReady": createMessageSchema(
    "ccb.player.setReady",
    t.Object(
      {
        ready: t.Boolean(),
      },
      { additionalProperties: false },
    ),
  ),
  "ccb.player.setSpectator": createMessageSchema(
    "ccb.player.setSpectator",
    t.Object(
      {
        spectator: t.Boolean(),
      },
      { additionalProperties: false },
    ),
  ),
  "ccb.player.setMessage": createMessageSchema(
    "ccb.player.setMessage",
    t.Object(
      {
        // 这里是**载荷体积**上限（防 OOM）；展示用的 32 字上限由服务端归一化时截断，
        // 与 `ccb.chat.send` 的 500/200 两层约束同一范式。
        message: t.String({ maxLength: 200 }),
      },
      { additionalProperties: false },
    ),
  ),
  "ccb.chat.send": createMessageSchema(
    "ccb.chat.send",
    t.Object(
      {
        text: t.String({ minLength: 1, maxLength: 500 }),
      },
      { additionalProperties: false },
    ),
  ),
  "ccb.test.addBot": createMessageSchema(
    "ccb.test.addBot",
    t.Object(
      {
        count: t.Optional(t.Integer({ minimum: 1 })),
      },
      { additionalProperties: false },
    ),
  ),
  "ccb.test.removeBot": createMessageSchema(
    "ccb.test.removeBot",
    t.Object(
      {
        count: t.Optional(t.Integer({ minimum: 1 })),
      },
      { additionalProperties: false },
    ),
  ),
};

export const CCBClientMessageSchema = t.Union(Object.values(CCBMessageSchemas));

/**
 * 严格类型校验与解析 CCB 客户端消息。
 * 遵循 TypeBox 单一真相源，所有 Schema 均开启 additionalProperties: false，拒绝非法 payload: null 与脏字段。
 */
export const parseCCBMessage = (raw: unknown): CCBClientMessage => {
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

  const schema = (CCBMessageSchemas as Record<string, TSchema>)[type];
  if (!schema) {
    throw new AppError("UNKNOWN_MESSAGE_TYPE", `未知消息类型: ${type}`);
  }

  if (msgObj.payload === null || typeof msgObj.payload !== "object" || Array.isArray(msgObj.payload)) {
    throw new AppError("INVALID_MESSAGE", "消息载荷 payload 必须为对象");
  }

  const errors = [...Value.Errors(schema, parsed)];
  if (errors.length > 0) {
    const first = errors[0];
    const path = first.path ? ` (${first.path})` : "";
    throw new AppError("INVALID_MESSAGE", `消息校验失败${path}: ${first.message}`);
  }

  return parsed as CCBClientMessage;
};
