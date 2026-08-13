import { AppError } from "../domain/errors";
import type {
  RoomVisibility,
  SongArtistFilter,
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

const readQuestionType = (value: unknown): SongGuessrSettings["questionType"] | undefined => {
  if (value == null) return undefined;
  if (value !== "song" && value !== "anime") {
    throw new AppError("INVALID_MESSAGE", "questionType 必须为 song 或 anime");
  }
  return value;
};

const readQuestionMode = (value: unknown): SongGuessrSettings["questionMode"] | undefined => {
  if (value == null) return undefined;
  if (value !== "manual" && value !== "automatic") {
    throw new AppError("INVALID_MESSAGE", "questionMode 必须为 manual 或 automatic");
  }
  return value;
};

const readAutoFilters = (value: unknown): SongGuessrSettings["autoFilters"] | undefined => {
  if (value == null) return undefined;
  if (!isObject(value)) throw new AppError("INVALID_MESSAGE", "autoFilters 必须为对象");
  const playlistValue = value.playlist;
  let playlist: SongGuessrSettings["autoFilters"]["playlist"];
  if (playlistValue != null) {
    if (!isObject(playlistValue)) throw new AppError("INVALID_MESSAGE", "autoFilters.playlist 必须为对象");
    playlist = {
      id: readString(playlistValue.id, "autoFilters.playlist.id")!,
      name: readString(playlistValue.name, "autoFilters.playlist.name", { optional: true }),
      songCount: readOptionalPositiveInteger(playlistValue.songCount, "autoFilters.playlist.songCount"),
    };
  }
  if (!Array.isArray(value.artists)) {
    throw new AppError("INVALID_MESSAGE", "autoFilters.artists 必须为数组");
  }
  const artists = value.artists.map((artist, index): SongArtistFilter => {
    if (!isObject(artist)) throw new AppError("INVALID_MESSAGE", `autoFilters.artists.${index} 必须为对象`);
    return {
      id: readString(artist.id, `autoFilters.artists.${index}.id`)!,
      name: readString(artist.name, `autoFilters.artists.${index}.name`)!,
    };
  });
  const minPopularity = readNumber(value.minPopularity, "autoFilters.minPopularity");
  if (![0, 1_000, 10_000, 100_000].includes(minPopularity ?? -1)) {
    throw new AppError("INVALID_MESSAGE", "autoFilters.minPopularity 不是支持的热度档位");
  }
  return { playlist, artists, minPopularity: minPopularity as 0 | 1_000 | 10_000 | 100_000 };
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
    case "song.room.requestSync":
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
        questionType: readQuestionType(payload.questionType),
        questionMode: readQuestionMode(payload.questionMode),
        autoRotateSubmitter: readBoolean(payload.autoRotateSubmitter, "payload.autoRotateSubmitter", true),
        autoFilters: readAutoFilters(payload.autoFilters),
        lyricsLineCount: readNumber(payload.lyricsLineCount, "payload.lyricsLineCount"),
        showLyrics: readBoolean(payload.showLyrics, "payload.showLyrics", true),
        maxGuessesPerRound: readNumber(payload.maxGuessesPerRound, "payload.maxGuessesPerRound"),
        guessDurationSeconds: readNumber(payload.guessDurationSeconds, "payload.guessDurationSeconds"),
        bloodMode: readBoolean(payload.bloodMode, "payload.bloodMode", true),
        showGuessTimer: readBoolean(payload.showGuessTimer, "payload.showGuessTimer", true),
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
    case "song.music.playlist.resolve":
      return {
        ...envelope,
        type,
        payload: { value: readString(payload.value, "payload.value")! },
      };
    case "song.music.artist.search":
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
