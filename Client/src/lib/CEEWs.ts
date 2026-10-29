import type { CEECommand, CEEPayload, CEEResponse } from "@bakagame/shared";
import {
  bakaChannelQuery,
  isBakaClient,
  lastHandshakeHadTicket,
  waitForChannelTicket,
} from "@/lib/BakaChannel";
import {
  createWebSocketClient,
  isProtocolError,
  type ProtocolError,
  type SendOptions,
} from "@/lib/WebsocketClient";
import { rejectedProtocol } from "@/lib/ProtocolFailure";

// 原生客户端在每次建连时把通道凭据拼进握手 URL，网页环境拿到空串。
// 走查询串而非进房载荷：CEE 命令 schema 是 strict 的塞不下额外字段，而共享 WS 客户端只把
// path 原样拼进 URL、没有首帧注册机制——查询串是不改动公共客户端的最小通道。
// 必须传函数而不是结果：ticket 一次性、30 秒即焚，构造时读一次会让重连全部带上废票。
const client = createWebSocketClient("/api/ws", bakaChannelQuery);

/** 等壳签票的上限：等不到就不建带票连接，给可重试错误，不白跑一次注定被拒的握手。 */
const CHANNEL_TICKET_WAIT_MS = 6_000;
/** 换票重连的等待上限：要覆盖 1 秒退避加一次握手，不能用普通请求的 10 秒语义。 */
const CHANNEL_RECONNECT_WAIT_MS = 8_000;
const ADMISSION_COMMANDS = new Set<string>([
  "cee.room.create",
  "cee.room.join",
  "cee.room.reconnect",
]);

const channelNotReady = (): ProtocolError => ({
  code: "CLIENT_CHANNEL_NOT_READY",
  message: "客户端通道尚未就绪",
});

const isChannelRefused = (error: unknown): boolean =>
  isProtocolError(error) && error.code === "CLIENT_REQUIRED";

/**
 * 用一张新票重新握手，并确认这次握手确实带上了票。
 *
 * 服务端的通道证明挂在**连接**上，同一连接上重发命令补不上证明；票是一次性的，
 * 所以只能重新建连。壳此时若还签不出票（未注册、离线、自检判死），返回 false。
 */
async function reconnectWithTicket(): Promise<boolean> {
  if (!(await waitForChannelTicket(CHANNEL_TICKET_WAIT_MS))) return false;
  client.refreshIdentity();
  try {
    await client.waitForConnection(CHANNEL_RECONNECT_WAIT_MS);
  } catch {
    return false;
  }
  return lastHandshakeHadTicket();
}

const rawSend = client.send.bind(client);

/** 服务端明确拒绝票据后换一张重试一次；仍被拒就换成玩家能据此重试的文案。 */
async function resendAfterRefusal(
  type: string,
  payload: Record<string, unknown>,
  options: SendOptions | undefined
): Promise<Record<string, unknown>> {
  if (!(await reconnectWithTicket())) return rejectedProtocol(channelNotReady());
  try {
    return await rawSend(type, payload, options);
  } catch (error) {
    if (isChannelRefused(error)) return rejectedProtocol(channelNotReady());
    throw error;
  }
}

client.send = (async (
  type: string,
  payload: Record<string, unknown> = {},
  options?: SendOptions
): Promise<Record<string, unknown>> => {
  const shell = isBakaClient();
  const antiCheatCreate = type === "cee.room.create" && payload.bakaAntiCheat === true;
  // 进入 CEE 页面时壳还在异步签票：这条连接建出来就没有通道证明，且不会自己补。
  // 建房前先换一次带票连接，否则开关可见、建房必被服务端拒。
  if (shell && antiCheatCreate && !lastHandshakeHadTicket()) {
    if (!(await reconnectWithTicket())) return rejectedProtocol(channelNotReady());
  }
  try {
    return await rawSend(type, payload, options);
  } catch (error) {
    // 票被拒（过期、已被上一次连接消费、来源地址不符）：换一张票重连后重试一次。
    // 只重试准入类命令：它们的失败发生在建人/建房之前，重发不会产生第二份状态。
    const retryable = shell && isChannelRefused(error) && ADMISSION_COMMANDS.has(type);
    if (!retryable) throw error;
    return resendAfterRefusal(type, payload, options);
  }
}) as unknown as typeof client.send;

export const ceeWsClient = client;

/** 与卧底、猜歌同一组 facade 形状：连接、等待、发送、消息与状态订阅。 */
export const connect = () => ceeWsClient.connect();
export const disconnect = () => ceeWsClient.disconnect();
export const waitForConnection = (timeoutMs?: number) => ceeWsClient.waitForConnection(timeoutMs);

/** 命令名、载荷与 ack 形状一律由 shared 的命令表推导（`CEEResponse` 就定义在那张表旁边）。 */
export function send<T extends CEECommand>(
  type: T,
  payload: CEEPayload<T>,
  options?: SendOptions
): Promise<CEEResponse<T>> {
  return ceeWsClient.send(type, payload, options) as Promise<CEEResponse<T>>;
}

export const onMessage = (handler: Parameters<typeof ceeWsClient.onMessage>[0]) =>
  ceeWsClient.onMessage(handler);
export const onStatus = (handler: Parameters<typeof ceeWsClient.onStatus>[0]) =>
  ceeWsClient.onStatus(handler);

/**
 * store 的 `sendCommand` 与组件 props 之间传的是同一个函数，形状只在这里写一次。
 * 房号、会话凭据与超时由 store 按当前房间补齐，调用方只给命令与载荷。
 */
export type CEESendCommand = <T extends CEECommand>(
  type: T,
  payload: CEEPayload<T>
) => Promise<CEEResponse<T>>;
