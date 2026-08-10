import { AppError } from "../domain/errors";
import type {
  RoomVisibility,
  SongGuessrClientMessage,
  SongGuessrSettings,
} from "../shared";

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readString = (
  value: unknown,
  field: string,
  options: { optional?: boolean; allowEmpty?: boolean } = {},
): string | undefined => {
  if (value == null && options.optional) return undefined;
  if (typeof value !== "string") throw new AppError("INVALID_MESSAGE", `${field} 必须为字符串`);
  if (!options.allowEmpty && !value.trim()) throw new AppError("INVALID_MESSAGE", `${field} 不能为空`);
  return value;
};

const readBoolean = (value: unknown, field: string, optional = false): boolean | undefined => {
  if (value == null && optional) return undefined;
  if (typeof value !== "boolean") throw new AppError("INVALID_MESSAGE", `${field} 必须为布尔值`);
  return value;
};

const readNumber = (value: unknown, field: string): number | undefined => {
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AppError("INVALID_MESSAGE", `${field} 必须为数字`);
  }
  return value;
};

const readPositiveInteger = (value: unknown, field: string): number => {
  const number = readNumber(value, field);
  if (number === undefined || !Number.isInteger(number) || number < 1) {
    throw new AppError("INVALID_MESSAGE", `${field} 必须为正整数`);
  }
  return number;
};

const readOptionalPositiveInteger = (value: unknown, field: string): number | undefined => {
  if (value == null) return undefined;
  return readPositiveInteger(value, field);
};

const readVisibility = (value: unknown, optional = false): RoomVisibility | undefined => {
  if (value == null && optional) return undefined;
  if (value !== "public" && value !== "private") {
    throw new AppError("INVALID_MESSAGE", "visibility 必须为 public 或 private");
  }
  return value;
};

export const parseSongGuessrMessage = (raw: unknown): SongGuessrClientMessage => {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new AppError("INVALID_MESSAGE", "消息必须为合法 JSON");
    }
  }
  if (!isObject(parsed)) throw new AppError("INVALID_MESSAGE", "消息必须为 JSON 对象");

  const id = readString(parsed.id, "id")!;
  const type = readString(parsed.type, "type")!;
  const roomId = readString(parsed.roomId, "roomId", { optional: true });
  const sessionToken = readString(parsed.sessionToken, "sessionToken", { optional: true });
  const payload = isObject(parsed.payload) ? parsed.payload : {};
  const envelope = { id, roomId, sessionToken };

  switch (type) {
    case "song.lobby.subscribeRooms":
    case "song.room.leave":
    case "song.auth.qr.create":
    case "song.auth.clear":
    case "song.game.start":
    case "song.game.giveUp":
    case "song.game.skipRound":
    case "song.game.nextRound":
    case "song.game.finish":
      return { ...envelope, type, payload: {} } as SongGuessrClientMessage;
    case "song.room.create":
      return {
        id,
        type,
        payload: {
          roomId: readString(payload.roomId, "payload.roomId")!,
          name: readString(payload.name, "payload.name")!,
          visibility: readVisibility(payload.visibility)!,
          password: readString(payload.password, "payload.password", { optional: true }),
          allowSpectators: readBoolean(payload.allowSpectators, "payload.allowSpectators")!,
          userName: readString(payload.userName, "payload.userName")!,
        },
      };
    case "song.room.join":
      return {
        ...envelope,
        type,
        payload: {
          userName: readString(payload.userName, "payload.userName")!,
          password: readString(payload.password, "payload.password", { optional: true }),
        },
      };
    case "song.room.reconnect":
      return {
        id,
        type,
        payload: {
          roomId: readString(payload.roomId, "payload.roomId")!,
          sessionToken: readString(payload.sessionToken, "payload.sessionToken")!,
        },
      };
    case "song.player.setReady":
      return {
        ...envelope,
        type,
        payload: { ready: readBoolean(payload.ready, "payload.ready")! },
      };
    case "song.player.setSpectator":
      return {
        ...envelope,
        type,
        payload: { spectator: readBoolean(payload.spectator, "payload.spectator")! },
      };
    case "song.test.addBot":
    case "song.test.removeBot":
      return {
        ...envelope,
        type,
        payload: { count: readOptionalPositiveInteger(payload.count, "payload.count") },
      } as SongGuessrClientMessage;
    case "song.room.updateSettings": {
      const settings: Partial<SongGuessrSettings> = {
        lyricsLineCount: readNumber(payload.lyricsLineCount, "payload.lyricsLineCount"),
        maxGuessesPerRound: readNumber(payload.maxGuessesPerRound, "payload.maxGuessesPerRound"),
        guessDurationSeconds: readNumber(payload.guessDurationSeconds, "payload.guessDurationSeconds"),
        endOnFirstCorrect: readBoolean(payload.endOnFirstCorrect, "payload.endOnFirstCorrect", true),
      };
      return {
        ...envelope,
        type,
        payload: {
          ...settings,
          name: readString(payload.name, "payload.name", { optional: true }),
          visibility: readVisibility(payload.visibility, true),
          password: readString(payload.password, "payload.password", { optional: true, allowEmpty: true }),
          allowSpectators: readBoolean(payload.allowSpectators, "payload.allowSpectators", true),
        },
      };
    }
    case "song.room.kick":
    case "song.room.transferHost":
    case "song.game.chooseSubmitter":
      return {
        ...envelope,
        type,
        payload: { playerId: readString(payload.playerId, "payload.playerId")! },
      } as SongGuessrClientMessage;
    case "song.chat.send":
      return {
        ...envelope,
        type,
        payload: { text: readString(payload.text, "payload.text")! },
      };
    case "song.auth.qr.check":
      return {
        ...envelope,
        type,
        payload: { key: readString(payload.key, "payload.key")! },
      };
    case "song.auth.phone.sendCaptcha":
      return {
        ...envelope,
        type,
        payload: {
          phone: readString(payload.phone, "payload.phone")!,
          countryCode: readString(payload.countryCode, "payload.countryCode", { optional: true }),
        },
      };
    case "song.auth.phone.login":
      return {
        ...envelope,
        type,
        payload: {
          phone: readString(payload.phone, "payload.phone")!,
          countryCode: readString(payload.countryCode, "payload.countryCode", { optional: true }),
          password: readString(payload.password, "payload.password", { optional: true }),
          captcha: readString(payload.captcha, "payload.captcha", { optional: true }),
        },
      };
    case "song.auth.email.login":
      return {
        ...envelope,
        type,
        payload: {
          email: readString(payload.email, "payload.email")!,
          password: readString(payload.password, "payload.password")!,
        },
      };
    case "song.auth.useCookie":
      return {
        ...envelope,
        type,
        payload: { cookie: readString(payload.cookie, "payload.cookie")! },
      };
    case "song.music.search":
      return {
        ...envelope,
        type,
        payload: { keyword: readString(payload.keyword, "payload.keyword")! },
      };
    case "song.game.submitSong":
    case "song.game.guess":
      return {
        ...envelope,
        type,
        payload: { songId: readString(payload.songId, "payload.songId")! },
      } as SongGuessrClientMessage;
    case "song.game.audioReady":
      return {
        ...envelope,
        type,
        payload: { roundNumber: readPositiveInteger(payload.roundNumber, "payload.roundNumber") },
      };
    default:
      throw new AppError("UNKNOWN_MESSAGE_TYPE", `未知消息类型: ${type}`);
  }
};
