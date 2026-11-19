import { AppError } from "../domain/Errors";
import type { ConnectionRecord } from "../shared/Index";
import type { CEEDataProvider } from "../infrastructure/CEEData";
import { CEEImageHints } from "../infrastructure/CEEImageHints";
import type { EventLogger } from "../infrastructure/EventLogger";
import {
  originalConfirmedEvent,
  originalRequest,
  type CEEOriginalSocket,
  type CEEOriginalSocketFactory,
} from "../infrastructure/CEEOriginalSocket";
import { createEvent } from "../transport/Packets";
import type { CEEOriginalChatRoom, CEEOriginalSession } from "./CEEOriginalModel";
import { originalPrivateState, originalSnapshot } from "./CEEOriginalView";

export interface CEEOriginalOptions {
  data: CEEDataProvider;
  serverUrl?: string;
  aesSecret?: string;
  now?: () => number;
  logger?: Pick<EventLogger, "warn">;
  socketFactory?: CEEOriginalSocketFactory;
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  imageHints?: Pick<CEEImageHints, "render">;
  /** 上游请求与事件确认的等待上限；缺省取生产值，测试注入小值避免真实等待。 */
  ackTimeoutMs?: number;
}

/** 日志里的失败原因：业务错误取码，我们自己抛的简短说明原样保留，其余取异常名；不含载荷与密钥。 */
export function reasonOf(error: unknown): string {
  if (error instanceof AppError) return error.code;
  if (error instanceof Error) return error.name === "Error" ? error.message : error.name;
  return "unknown";
}

/**
 * 原版房各模块共享的服务状态：三张表（会话、连接到会话、聊天房）全服务只有一份，
 * 这里持有的是同一实例的引用，不是拷贝。
 */
export interface CEEOriginalContext {
  readonly options: CEEOriginalOptions;
  readonly connections: Map<string, ConnectionRecord>;
  readonly sessions: Map<string, CEEOriginalSession>;
  readonly byConnection: Map<string, CEEOriginalSession>;
  readonly chats: Map<string, CEEOriginalChatRoom>;
  readonly now: () => number;
  readonly fetcher: NonNullable<CEEOriginalOptions["fetcher"]>;
  readonly imageHints: Pick<CEEImageHints, "render">;
  readonly configured: boolean;
}

/** 上游请求统一带上本服务的确认超时。 */
export function upstreamRequest(
  ctx: CEEOriginalContext,
  socket: CEEOriginalSocket,
  event: string,
  payload: unknown
): Promise<Record<string, unknown>> {
  return originalRequest(socket, event, payload, ctx.options.ackTimeoutMs);
}

export function upstreamConfirmed(
  ctx: CEEOriginalContext,
  socket: CEEOriginalSocket,
  event: string,
  predicate: (payload: unknown) => boolean,
  send: () => void
): Promise<unknown> {
  return originalConfirmedEvent(socket, event, predicate, send, ctx.options.ackTimeoutMs);
}

export function cancelPreparation(session: CEEOriginalSession): void {
  const operation = session.preparation;
  if (!operation) return;
  if (session.phase === "preparing") session.phase = operation.phase;
  delete session.preparation;
}

export function selfOf(session: CEEOriginalSession) {
  const player = session.players.find((player) => player.id === session.socket.id);
  if (!player) throw new AppError("NOT_IN_ROOM", "原版房间内没有当前玩家");
  return player;
}
export function requireHost(session: CEEOriginalSession): void {
  if (!selfOf(session).isHost) throw new AppError("FORBIDDEN", "只有房主可以执行该操作");
}
export function publish(
  ctx: CEEOriginalContext,
  session: CEEOriginalSession,
  calibration = false
): void {
  if (!session.confirmed || !session.connectionId) return;
  const connection = ctx.connections.get(session.connectionId);
  if (!connection) return;
  const send = calibration ? connection.sendStateSyncCalibration : connection.send;
  send?.(
    createEvent("cee.room.snapshot", originalSnapshot(session, ctx.chats.get(session.roomId)))
  );
  send?.(createEvent("cee.game.privateState", originalPrivateState(session)));
}

export function revoke(
  ctx: CEEOriginalContext,
  session: CEEOriginalSession,
  reason: string,
  notify = true,
  kicked = false
): void {
  if (session.revoked) return;
  cancelPreparation(session);
  session.revoked = true;
  session.confirmed = false;
  if (session.connectionId) {
    const connection = ctx.connections.get(session.connectionId);
    if (notify)
      connection?.send(
        createEvent(kicked ? "cee.player.kicked" : "cee.room.closed", {
          roomId: session.alias,
          source: "original",
          reason,
        })
      );
    if (connection) {
      connection.roomId = undefined;
      connection.playerId = undefined;
    }
    ctx.byConnection.delete(session.connectionId);
  }
  ctx.sessions.delete(session.token);
  session.socket.removeAllListeners();
  session.socket.disconnect();
  if (![...ctx.sessions.values()].some((peer) => peer.confirmed && peer.roomId === session.roomId))
    ctx.chats.delete(session.roomId);
}
