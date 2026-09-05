import { Type as t, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { AppError } from "../domain/Errors";
import {
  MAX_SONGUESSR_COOKIE_LENGTH,
  type RoomVisibility,
  type SongArtistFilter,
  type SonGuessrClientMessage,
  type SonGuessrSettings,
} from "../shared/Index";

export const SongVisibilitySchema = t.Union([t.Literal("public"), t.Literal("private")]);
export const QuestionTypeSchema = t.Union([t.Literal("song"), t.Literal("anime")]);
export const QuestionModeSchema = t.Union([t.Literal("manual"), t.Literal("automatic")]);
export const MinPopularitySchema = t.Union([
  t.Literal(0),
  t.Literal(1_000),
  t.Literal(10_000),
  t.Literal(100_000),
]);

export const SongPlaylistFilterSchema = t.Object(
  {
    id: t.String({ minLength: 1, maxLength: 64 }),
    name: t.Optional(t.String({ maxLength: 128 })),
    songCount: t.Optional(t.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const SongArtistFilterSchema = t.Object(
  {
    id: t.String({ minLength: 1, maxLength: 64 }),
    name: t.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);

export const SongAutoFiltersSchema = t.Object(
  {
    playlist: t.Optional(SongPlaylistFilterSchema),
    artists: t.Optional(t.Array(SongArtistFilterSchema)),
    minPopularity: t.Optional(MinPopularitySchema),
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

export const SonGuessrMessageSchemas = {
  "song.lobby.subscribeRooms": createMessageSchema("song.lobby.subscribeRooms", EmptyPayloadSchema),
  "song.room.create": createMessageSchema(
    "song.room.create",
    t.Object(
      {
        roomId: t.String({ minLength: 1, maxLength: 32 }),
        name: t.String({ minLength: 1, maxLength: 40 }),
        visibility: SongVisibilitySchema,
        password: t.Optional(t.String({ maxLength: 64 })),
        allowSpectators: t.Boolean(),
        userName: t.String({ minLength: 1, maxLength: 32 }),
      },
      { additionalProperties: false },
    ),
  ),
  "song.room.join": createMessageSchema(
    "song.room.join",
    t.Object(
      {
        userName: t.String({ minLength: 1, maxLength: 32 }),
        password: t.Optional(t.String({ maxLength: 64 })),
      },
      { additionalProperties: false },
    ),
  ),
  "song.room.reconnect": createMessageSchema(
    "song.room.reconnect",
    t.Object(
      {
        roomId: t.String({ minLength: 1, maxLength: 32 }),
        sessionToken: t.String({ minLength: 1, maxLength: 128 }),
      },
      { additionalProperties: false },
    ),
  ),
  "song.room.leave": createMessageSchema("song.room.leave", EmptyPayloadSchema),
  "song.room.requestSync": createMessageSchema("song.room.requestSync", EmptyPayloadSchema),
  "song.player.setReady": createMessageSchema(
    "song.player.setReady",
    t.Object(
      {
        ready: t.Boolean(),
      },
      { additionalProperties: false },
    ),
  ),
  "song.player.setSpectator": createMessageSchema(
    "song.player.setSpectator",
    t.Object(
      {
        spectator: t.Boolean(),
      },
      { additionalProperties: false },
    ),
  ),
  "song.room.updateSettings": createMessageSchema(
    "song.room.updateSettings",
    t.Object(
      {
        name: t.Optional(t.String({ minLength: 1, maxLength: 40 })),
        visibility: t.Optional(SongVisibilitySchema),
        password: t.Optional(t.String({ maxLength: 64 })),
        allowSpectators: t.Optional(t.Boolean()),
        questionType: t.Optional(QuestionTypeSchema),
        questionMode: t.Optional(QuestionModeSchema),
        autoRotateSubmitter: t.Optional(t.Boolean()),
        autoFilters: t.Optional(SongAutoFiltersSchema),
        lyricsLineCount: t.Optional(t.Integer({ minimum: 1, maximum: 20 })),
        showLyrics: t.Optional(t.Boolean()),
        maxGuessesPerRound: t.Optional(t.Integer({ minimum: 1 })),
        guessDurationSeconds: t.Optional(t.Integer({ minimum: 5 })),
        bloodMode: t.Optional(t.Boolean()),
        showGuessTimer: t.Optional(t.Boolean()),
      },
      { additionalProperties: false },
    ),
  ),
  "song.room.kick": createMessageSchema(
    "song.room.kick",
    t.Object(
      {
        playerId: t.String({ minLength: 1, maxLength: 64 }),
      },
      { additionalProperties: false },
    ),
  ),
  "song.room.transferHost": createMessageSchema(
    "song.room.transferHost",
    t.Object(
      {
        playerId: t.String({ minLength: 1, maxLength: 64 }),
      },
      { additionalProperties: false },
    ),
  ),
  "song.chat.send": createMessageSchema(
    "song.chat.send",
    t.Object(
      {
        text: t.String({ minLength: 1, maxLength: 500 }),
      },
      { additionalProperties: false },
    ),
  ),
  "song.auth.qr.create": createMessageSchema("song.auth.qr.create", EmptyPayloadSchema),
  "song.auth.qr.check": createMessageSchema(
    "song.auth.qr.check",
    t.Object(
      {
        key: t.String({ minLength: 1, maxLength: 256 }),
      },
      { additionalProperties: false },
    ),
  ),
  "song.auth.useCookie": createMessageSchema(
    "song.auth.useCookie",
    t.Object(
      {
        cookie: t.String({ minLength: 1, maxLength: MAX_SONGUESSR_COOKIE_LENGTH }),
      },
      { additionalProperties: false },
    ),
  ),
  "song.auth.clear": createMessageSchema("song.auth.clear", EmptyPayloadSchema),
  "song.music.search": createMessageSchema(
    "song.music.search",
    t.Object(
      {
        keyword: t.String({ minLength: 1, maxLength: 200 }),
      },
      { additionalProperties: false },
    ),
  ),
  "song.music.playlist.resolve": createMessageSchema(
    "song.music.playlist.resolve",
    t.Object(
      {
        value: t.String({ minLength: 1, maxLength: 500 }),
      },
      { additionalProperties: false },
    ),
  ),
  "song.music.artist.search": createMessageSchema(
    "song.music.artist.search",
    t.Object(
      {
        keyword: t.String({ minLength: 1, maxLength: 200 }),
      },
      { additionalProperties: false },
    ),
  ),
  "song.game.start": createMessageSchema("song.game.start", EmptyPayloadSchema),
  "song.game.chooseSubmitter": createMessageSchema(
    "song.game.chooseSubmitter",
    t.Object(
      {
        playerId: t.String({ minLength: 1, maxLength: 64 }),
      },
      { additionalProperties: false },
    ),
  ),
  "song.game.submitSong": createMessageSchema(
    "song.game.submitSong",
    t.Object(
      {
        songId: t.String({ minLength: 1, maxLength: 64 }),
      },
      { additionalProperties: false },
    ),
  ),
  "song.game.audioReady": createMessageSchema(
    "song.game.audioReady",
    t.Object(
      {
        roundNumber: t.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
  ),
  "song.game.guess": createMessageSchema(
    "song.game.guess",
    t.Object(
      {
        songId: t.String({ minLength: 1, maxLength: 64 }),
      },
      { additionalProperties: false },
    ),
  ),
  "song.game.giveUp": createMessageSchema("song.game.giveUp", EmptyPayloadSchema),
  "song.game.skipRound": createMessageSchema("song.game.skipRound", EmptyPayloadSchema),
  "song.game.nextRound": createMessageSchema("song.game.nextRound", EmptyPayloadSchema),
  "song.game.finish": createMessageSchema("song.game.finish", EmptyPayloadSchema),
  "song.test.addBot": createMessageSchema(
    "song.test.addBot",
    t.Object(
      {
        count: t.Optional(t.Integer({ minimum: 1 })),
      },
      { additionalProperties: false },
    ),
  ),
  "song.test.removeBot": createMessageSchema(
    "song.test.removeBot",
    t.Object(
      {
        count: t.Optional(t.Integer({ minimum: 1 })),
      },
      { additionalProperties: false },
    ),
  ),
};

export const SonGuessrClientMessageSchema = t.Union(
  Object.values(SonGuessrMessageSchemas),
);

/**
 * 严格类型校验与解析 SonGuessr 客户端消息。
 * 遵循 TypeBox 单一真相源，所有 Schema 均开启 additionalProperties: false，拒绝非法 payload: null 与脏字段。
 */
export const parseSonGuessrMessage = (raw: unknown): SonGuessrClientMessage => {
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

  const schema = (SonGuessrMessageSchemas as Record<string, TSchema>)[type];
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

  return parsed as SonGuessrClientMessage;
};
