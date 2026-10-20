import type { WhoIsFakerAck, WhoIsFakerCommand, WhoIsFakerPayload } from "@bakagame/shared";
import { createWebSocketClient, type SendOptions } from "@/lib/WebsocketClient";

export const whoIsFakerWsClient = createWebSocketClient("/api/whoisfaker/ws");

/** 三条游戏通道对外的 facade 形状一致：连接、等待、发送、消息与状态订阅。 */
export const connect = () => whoIsFakerWsClient.connect();
export const disconnect = () => whoIsFakerWsClient.disconnect();
export const waitForConnection = (timeoutMs?: number) =>
  whoIsFakerWsClient.waitForConnection(timeoutMs);

/**
 * 命令名与载荷形状由 shared 的派生契约锁定：拼错命令名、漏必填字段在编译期就失败，
 * 不再只有运行时的 UNKNOWN_MESSAGE_TYPE。ack 同样由命令推导（`WhoIsFakerAck<T>`）。
 */
export function send<T extends WhoIsFakerCommand>(
  type: T,
  payload: WhoIsFakerPayload<T>,
  options?: SendOptions
): Promise<WhoIsFakerAck<T>> {
  return whoIsFakerWsClient.send(type, payload as Record<string, unknown>, options) as Promise<
    WhoIsFakerAck<T>
  >;
}

export const onMessage = (handler: Parameters<typeof whoIsFakerWsClient.onMessage>[0]) =>
  whoIsFakerWsClient.onMessage(handler);
export const onStatus = (handler: Parameters<typeof whoIsFakerWsClient.onStatus>[0]) =>
  whoIsFakerWsClient.onStatus(handler);

/**
 * store 的 `sendCommand` 与组件 props 之间传的是同一个函数，形状也只在这里写一次：
 * 组件侧再声明一份 `(type: string, payload?: Record<string, unknown>) => ...` 会把刚收紧的命令名与载荷又放宽回 string。
 */
export type WhoIsFakerSendCommand = <TCommand extends WhoIsFakerCommand>(
  type: TCommand,
  payload?: WhoIsFakerPayload<TCommand>,
  /** `timeout: 0` 表示不设请求超时，用于耗时由上游决定的长任务。 */
  options?: { timeout?: number }
) => Promise<WhoIsFakerAck<TCommand>>;
