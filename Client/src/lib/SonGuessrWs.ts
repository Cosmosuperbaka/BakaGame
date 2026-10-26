import type { SonGuessrAck, SonGuessrCommand, SonGuessrPayload } from "@bakagame/shared";
import { createWebSocketClient, type SendOptions } from "@/lib/WebsocketClient";

export const sonGuessrWsClient = createWebSocketClient("/api/ws");

/** 与卧底、CEE 同一组 facade 形状：连接、等待、发送、消息与状态订阅。 */
export const connect = () => sonGuessrWsClient.connect();
export const disconnect = () => sonGuessrWsClient.disconnect();
export const waitForConnection = (timeoutMs?: number) =>
  sonGuessrWsClient.waitForConnection(timeoutMs);

/**
 * 命令名、载荷与 ack 形状都由 shared 的派生契约锁定：拼错命令名或漏必填字段在编译期失败。
 */
export function send<T extends SonGuessrCommand>(
  type: T,
  payload: SonGuessrPayload<T>,
  options?: SendOptions
): Promise<SonGuessrAck<T>> {
  return sonGuessrWsClient.send(type, payload as Record<string, unknown>, options) as Promise<
    SonGuessrAck<T>
  >;
}

export const onMessage = (handler: Parameters<typeof sonGuessrWsClient.onMessage>[0]) =>
  sonGuessrWsClient.onMessage(handler);
export const onStatus = (handler: Parameters<typeof sonGuessrWsClient.onStatus>[0]) =>
  sonGuessrWsClient.onStatus(handler);

/**
 * store 的 `sendCommand` 与组件 props 之间传的是同一个函数，形状只在这里写一次：
 * 组件侧另写一份 `(type: string, payload?: Record<string, unknown>) => ...` 会把收紧的命令名与载荷又放宽回 string。
 */
export type SonGuessrSendCommand = <TCommand extends SonGuessrCommand>(
  type: TCommand,
  payload?: SonGuessrPayload<TCommand>,
  /** `timeout: 0` 表示不设请求超时，用于自动出题这类耗时由上游决定的长任务。 */
  options?: { timeout?: number }
) => Promise<SonGuessrAck<TCommand>>;
