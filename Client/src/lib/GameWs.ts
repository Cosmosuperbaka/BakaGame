import type { SendOptions, WebSocketClient } from "@/lib/WebsocketClient";

/** 一款游戏的命令表：命令名 → 载荷与确认包形状，由 shared 的派生契约填充。 */
export type CommandSpecMap = Record<string, { payload: unknown; ack: unknown }>;

/**
 * 命令名与载荷形状由命令表锁定：拼错命令名、漏必填字段在编译期就失败，
 * 不再只有运行时的 UNKNOWN_MESSAGE_TYPE。ack 同样由命令推导。
 */
export type GameSend<M extends CommandSpecMap> = <K extends keyof M & string>(
  type: K,
  payload: M[K]["payload"],
  options?: SendOptions
) => Promise<M[K]["ack"]>;

/**
 * store 的 `sendCommand` 与组件 props 之间传的是同一个函数，形状只在这里写一次：
 * 组件侧另写一份 `(type: string, payload?: Record<string, unknown>) => ...` 会把收紧的命令名与载荷又放宽回 string。
 * 房号与会话凭据由 store 补齐，调用方只给命令、载荷与超时。
 */
export type GameSendCommand<M extends CommandSpecMap> = <K extends keyof M & string>(
  type: K,
  payload?: M[K]["payload"],
  /** `timeout: 0` 表示不设请求超时，用于耗时由上游决定的长任务。 */
  options?: { timeout?: number }
) => Promise<M[K]["ack"]>;

/** `timeout: 0` 不设请求超时；`pollSync` 在途期间按固定间隔请求全量（Spec §6）。 */
export type CommandPolicy<M extends CommandSpecMap> = Partial<
  Record<keyof M & string, { timeout?: 0; pollSync?: true }>
>;

/** 三条游戏通道对外的 facade 形状一致：连接、等待、发送、消息与状态订阅。 */
export interface GameWs<M extends CommandSpecMap> {
  connect: () => void;
  disconnect: () => void;
  waitForConnection: (timeoutMs?: number) => Promise<void>;
  send: GameSend<M>;
  onMessage: WebSocketClient["onMessage"];
  onStatus: WebSocketClient["onStatus"];
}

export function createGameWs<M extends CommandSpecMap>(client: WebSocketClient): GameWs<M> {
  return {
    connect: () => client.connect(),
    disconnect: () => client.disconnect(),
    waitForConnection: (timeoutMs) => client.waitForConnection(timeoutMs),
    send: <K extends keyof M & string>(type: K, payload: M[K]["payload"], options?: SendOptions) =>
      client.send(type, payload as Record<string, unknown>, options) as Promise<M[K]["ack"]>,
    onMessage: (handler) => client.onMessage(handler),
    onStatus: (handler) => client.onStatus(handler),
  };
}
