import type {
  CCBCharacterSummary, CCBCommand, CCBDirectoryResult, CCBPayload,
  CCBRoomEnterResult, CCBSubjectSummary,
} from "@bakagame/shared";
import { createWebSocketClient } from "@/lib/WebsocketClient";

export const ccbWs = createWebSocketClient("/api/ccb/ws");

export type CCBResponse<T extends CCBCommand> =
  T extends "ccb.lobby.subscribeRooms" ? { originalAvailable: boolean } :
  T extends "ccb.room.create" | "ccb.room.join" | "ccb.room.reconnect" ? CCBRoomEnterResult :
  T extends "ccb.character.search" | "ccb.subject.characters" ? { results: CCBCharacterSummary[] } :
  T extends "ccb.subject.search" | "ccb.subject.lookup" ? { results: CCBSubjectSummary[] } :
  T extends "ccb.directory.import" ? CCBDirectoryResult :
  T extends "ccb.character.image" ? { imageUrl?: string } :
  T extends "ccb.game.imageHint" ? { dataUrl: string } : Record<string, unknown>;

export function sendCCB<T extends CCBCommand>(
  type: T, payload: CCBPayload<T>, options?: { roomId?: string; sessionToken?: string; timeout?: number },
): Promise<CCBResponse<T>> {
  return ccbWs.send(type, payload, options) as Promise<CCBResponse<T>>;
}
