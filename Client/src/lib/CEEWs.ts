import type { CEECommand, CEEPayload, CEEResponse } from "@bakagame/shared";
import { bakaChannelQuery } from "@/lib/BakaChannel";
import { createWebSocketClient, type SendOptions } from "@/lib/WebsocketClient";

// 原生客户端在每次建连时把通道凭据拼进握手 URL，网页环境拿到空串。
// 走查询串而非进房载荷：CEE 命令 schema 是 strict 的塞不下额外字段，而共享 WS 客户端只把
// path 原样拼进 URL、没有首帧注册机制——查询串是不改动公共客户端的最小通道。
// 必须传函数而不是结果：ticket 一次性、30 秒即焚，构造时读一次会让重连全部带上废票。
export const ceeWs = createWebSocketClient("/api/cee/ws", bakaChannelQuery);

/** 命令名、载荷与 ack 形状一律由 shared 的命令表推导（`CEEResponse` 就定义在那张表旁边）。 */
export function sendCEE<T extends CEECommand>(
  type: T,
  payload: CEEPayload<T>,
  options?: SendOptions
): Promise<CEEResponse<T>> {
  return ceeWs.send(type, payload, options) as Promise<CEEResponse<T>>;
}
