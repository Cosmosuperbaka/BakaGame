import { Elysia } from "elysia";
import { AppError } from "../../domain/Errors";
import { PublicStatusSnapshotSchema } from "../../shared/PublicStatusSchemas";
import type { PublicStatusSnapshot } from "../../shared/Status";
import { resolveClientIp } from "../ClientIp";
import type { HandshakeLease, WsHandshakeQuota } from "../WsHandshakeQuota";
import type { StatusAggregator } from "./Status";

/**
 * 推送间隔与快照缓存同值：每个间隔最多触发一轮真实探测，
 * 连接再多也只读同一份缓存，不会把外部依赖打穿。
 */
const PUSH_INTERVAL_MS = 15_000;

/** 公开端点的扇出上限：超出的连接直接拒，保护小规格主机上的探测与游戏服务。 */
const MAX_CLIENTS = 128;

export interface StatusWsDependencies {
  aggregator: StatusAggregator;
  /** 按来源的握手配额：全局 128 个名额挡不住一个来源占满，所以每个来源另有在途上限与新建速率。 */
  quota: WsHandshakeQuota;
  sendError?: (scope: string, error: unknown) => void;
}

/**
 * 状态页的实时通道：连上先推一次当前快照，之后每 15 秒推一次。
 *
 * 与 `GET /api/status` 共用同一个聚合器，推送与轮询读到的因此是同一份缓存。
 * 定时器只在还有连接时存在：最后一个客户端断开就停表，没人看时不占用探测与广播开销。
 * 这是只读通道，不进任何游戏的连接注册表，也不参与对局协议。
 */
export const statusWsRoutes = ({
  aggregator,
  quota,
  sendError = () => {},
}: StatusWsDependencies) => {
  const sockets = new Set<{ send: (data: PublicStatusSnapshot) => unknown }>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const push = async (): Promise<void> => {
    if (sockets.size === 0) return;
    let snapshot: PublicStatusSnapshot;
    try {
      snapshot = await aggregator.readSnapshot();
    } catch (error) {
      sendError("status-ws", error);
      return;
    }
    for (const socket of sockets) {
      try {
        // 直接交快照对象：序列化与字段形状由上面的 response schema 负责，不在这里另拼一份 JSON。
        socket.send(snapshot);
      } catch (error) {
        // 单个连接写失败只摘掉它自己，不影响其余订阅者。
        sockets.delete(socket);
        sendError("status-ws-send", error);
      }
    }
  };

  const startTimer = (): void => {
    timer ??= setInterval(() => void push(), PUSH_INTERVAL_MS);
  };
  const stopTimer = (): void => {
    if (sockets.size > 0 || !timer) return;
    clearInterval(timer);
    timer = undefined;
  };

  return new Elysia({ name: "public-status-ws", normalize: false }).ws("/api/status/ws", {
    response: PublicStatusSnapshotSchema,
    // Origin 与停机闸在全局 onRequest 里统一判定，这里只占来源名额：拒绝必须 throw（返回值被忽略）。
    upgrade: (context: {
      request: Request;
      server?: { requestIP(request: Request): { address?: string } | null } | null;
      handshakeLease?: HandshakeLease;
    }) => {
      const peerIp = context.server?.requestIP(context.request)?.address;
      const clientIp = resolveClientIp(context.request.headers, peerIp);
      const lease = quota.reserve(clientIp, peerIp ?? clientIp);
      if (!lease) throw new AppError("RATE_LIMITED", "连接过于频繁，请稍后重试");
      context.handshakeLease = lease;
    },
    open: (ws) => {
      (ws.data as { handshakeLease?: HandshakeLease }).handshakeLease?.confirm();
      if (sockets.size >= MAX_CLIENTS) {
        ws.close(1013, "too-many-viewers");
        return;
      }
      sockets.add(ws);
      startTimer();
      void push();
    },
    close: (ws) => {
      (ws.data as { handshakeLease?: HandshakeLease }).handshakeLease?.release();
      sockets.delete(ws);
      stopTimer();
    },
  });
};
