import type {
  CEECharacterSummary,
  CEECommand,
  CEEDirectoryResult,
  CEEPayload,
  CEERoomEnterResult,
  CEESubjectSummary,
} from "@bakagame/shared";
import { bakaChannelQuery } from "@/lib/BakaChannel";
import { createWebSocketClient } from "@/lib/WebsocketClient";

// 原生客户端在每次建连时把通道凭据拼进握手 URL，网页环境拿到空串。
// 走查询串而非进房载荷：CEE 命令 schema 是 strict 的塞不下额外字段，而共享 WS 客户端只把
// path 原样拼进 URL、没有首帧注册机制——查询串是不改动公共客户端的最小通道。
// 必须传函数而不是结果：ticket 一次性、30 秒即焚，构造时读一次会让重连全部带上废票。
export const ceeWs = createWebSocketClient("/api/cee/ws", bakaChannelQuery);

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
