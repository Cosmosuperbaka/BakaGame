import type { ConnectionRecord, ClientChannelProof, PlayerAccount } from "../../shared/Index";
import type { ServerMessage } from "../../shared/Protocol";
import { createStateSyncSender } from "../StateSync";

/** 状态帧在编码时已序列化成文本，其余帧是对象：运行时两者都直接交给 `send`。 */
type OutboundFrame = ServerMessage | string;

export const sendPacket = (
  ws: { send: (data: ServerMessage) => unknown },
  payload: ServerMessage
) => {
  ws.send(payload);
};

/** 传输层只需要 WebSocket 的这几个能力，避免依赖 Elysia 的内部类型。 */
export interface GameSocketLike {
  data: unknown;
  send: (data: OutboundFrame) => unknown;
  close: (code?: number, reason?: string) => unknown;
  raw?: unknown;
}

export const connectionIdOf = (ws: GameSocketLike): string | undefined =>
  (ws.data as { connectionId?: string }).connectionId;

/**
 * 这条连接攒着没发出去的字节数。Bun 原生 socket 有 `getBufferedAmount`，
 * 但 Elysia 的 `raw` 用的是它自己裁剪过的 `ServerWebSocket` 声明（不含该方法），
 * 所以这里按结构收窄后再调用。读不到（测试里的假 socket）就返回 0，等价于不启用丢弃。
 */
const socketBacklog = (ws: GameSocketLike): number => {
  const raw = ws.raw as { getBufferedAmount?: () => number } | undefined;
  if (!raw?.getBufferedAmount) return 0;
  return raw.getBufferedAmount();
};

/** 连接号在一条物理 socket 上只发一次：统一入口要把同一条连接登记进多个服务。 */
export const connectionIdFor = (ws: GameSocketLike): string => {
  const data = ws.data as { connectionId?: string };
  return (data.connectionId ??= crypto.randomUUID());
};

/**
 * 为**一个服务**构造连接记录。状态同步基线属于服务，不属于 socket：统一入口上
 * 同一条连接会分别登记进三款游戏，各自必须持有独立的差量基线，不能共用一份。
 */
export const createConnectionRecord = (
  ws: GameSocketLike,
  connectionId: string,
  isTabDriven: (tabKey: string) => boolean = () => false
): ConnectionRecord => {
  const {
    account,
    clientIp,
    clientChannel: proof,
    isAgent,
    tabKey,
  } = ws.data as {
    account?: PlayerAccount;
    clientIp?: string;
    clientChannel?: ClientChannelProof;
    isAgent?: boolean;
    tabKey?: string;
  };
  const stateSync = createStateSyncSender(
    (payload) => {
      ws.send(payload as OutboundFrame);
    },
    () => socketBacklog(ws)
  );
  return {
    id: connectionId,
    ...(account ? { account } : {}),
    ...(clientIp ? { clientIp } : {}),
    ...(proof ? { clientChannel: proof } : {}),
    ...(isAgent ? { isAgent: true } : {}),
    ...(tabKey ? { tabKey, agentDriven: () => isTabDriven(tabKey) } : {}),
    lobbySubscribed: false,
    send: stateSync.send,
    resetStateSync: stateSync.reset,
    sendStateSyncCalibration: stateSync.calibrate,
    sendPacket: (payload: unknown) => sendPacket(ws, payload as ServerMessage),
    close: (code?: number, reason?: string) => ws.close(code, reason),
  };
};

export const openGameConnection = (
  ws: GameSocketLike,
  register: (connection: ConnectionRecord) => void
): void => {
  register(createConnectionRecord(ws, connectionIdFor(ws)));
};
