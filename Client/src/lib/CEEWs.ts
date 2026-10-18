import type {
  CEECharacterSummary,
  CEECommand,
  CEEDirectoryResult,
  CEEPayload,
  CEERoomEnterResult,
  CEESubjectSummary,
} from "@bakagame/shared";
import { createWebSocketClient } from "@/lib/WebsocketClient";

export const ceeWs = createWebSocketClient("/api/cee/ws");

export type CEEResponse<T extends CEECommand> = T extends "cee.lobby.subscribeRooms"
  ? { originalAvailable: boolean }
  : T extends "cee.room.create" | "cee.room.join" | "cee.room.reconnect"
    ? CEERoomEnterResult
    : T extends "cee.character.search" | "cee.subject.characters"
      ? { results: CEECharacterSummary[] }
      : T extends "cee.subject.search" | "cee.subject.lookup"
        ? { results: CEESubjectSummary[] }
        : T extends "cee.directory.import"
          ? CEEDirectoryResult
          : T extends "cee.character.image" | "cee.subject.image"
            ? { imageUrl?: string }
            : T extends "cee.game.imageHint"
              ? { dataUrl: string }
              : Record<string, unknown>;

export function sendCEE<T extends CEECommand>(
  type: T,
  payload: CEEPayload<T>,
  options?: { roomId?: string; sessionToken?: string; timeout?: number }
): Promise<CEEResponse<T>> {
  return ceeWs.send(type, payload, options) as Promise<CEEResponse<T>>;
}
