import { Elysia, t } from "elysia";
import type { PublicStatusSnapshot } from "../../shared/Status";
import type { StatusAggregator } from "./Status";

/**
 * 推送间隔与快照缓存同值：每个间隔最多触发一轮真实探测，
 * 连接再多也只读同一份缓存，不会把外部依赖打穿。
 */
const PUSH_INTERVAL_MS = 15_000;

/** 公开端点的扇出上限：超出的连接直接拒，保护小规格主机上的探测与游戏服务。 */
const MAX_CLIENTS = 128;

const snapshotSchema = t.Object({
  observedAt: t.Number(),
  level: t.Union([t.Literal("operational"), t.Literal("degraded"), t.Literal("unknown")]),
  version: t.String(),
  components: t.Array(
    t.Object({
      id: t.String(),
      level: t.Union([t.Literal("operational"), t.Literal("degraded"), t.Literal("unknown")]),
      latencyMs: t.Nullable(t.Number()),
    })
  ),
});

export interface StatusWsDependencies {
  aggregator: StatusAggregator;
  /**
   * 与游戏 socket 同一把来源闸。Origin 判定只在 App 里实现一次，
   * 这里经参数注入，不在公开端点上另写一份宽松版。
   */
  rejectOrigin: (headers: unknown, request: Request | undefined) => void;
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
  rejectOrigin,
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
    response: snapshotSchema,
    upgrade: (context) => {
      rejectOrigin(context.headers, context.request);
    },
    open: (ws) => {
      if (sockets.size >= MAX_CLIENTS) {
        ws.close(1013, "too-many-viewers");
        return;
      }
      sockets.add(ws);
      startTimer();
      void push();
    },
    close: (ws) => {
      sockets.delete(ws);
      stopTimer();
    },
  });
};
