import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import type { PublicStatusSnapshot } from "../src/shared/Status";
import { statusWsRoutes } from "../src/transport/routes/StatusWs";
import type { StatusAggregator } from "../src/transport/routes/Status";
import { quotaOf } from "./support/AppServer";

const snapshot = (observedAt: number): PublicStatusSnapshot => ({
  observedAt,
  level: "operational",
  version: "test",
  components: [{ id: "backend", level: "operational", latencyMs: 1 }],
});

/** 状态 WS 只读 readSnapshot，history 在这条通道上不会被触达。 */
const aggregatorOf = (readSnapshot: () => Promise<PublicStatusSnapshot>) =>
  ({ readSnapshot }) as unknown as StatusAggregator;

const startStatusServer = (
  aggregator: StatusAggregator,
  quota: ReturnType<typeof quotaOf>,
  sendError: (scope: string, error: unknown) => void
) => {
  const app = new Elysia().use(statusWsRoutes({ aggregator, quota, sendError }));
  const started = app.listen({ hostname: "127.0.0.1", port: 0 });
  const port = started.server?.port;
  if (!port) throw new Error("未能获取测试端口");
  return { port, stop: () => started.stop(true) };
};

/** 消息监听先于 open 挂上，连上即推的首帧才不会漏接。 */
const connectStatus = (port: number) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/status/ws`);
  const messages: PublicStatusSnapshot[] = [];
  socket.addEventListener("message", (event: MessageEvent<string>) => {
    messages.push(JSON.parse(event.data));
  });
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket 打开失败")), { once: true });
  });
  return { socket, messages, opened };
};

const waitFor = async (predicate: () => boolean, timeoutMs = 2000) => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("等待条件超时");
    await Bun.sleep(10);
  }
};

describe("状态页实时通道", () => {
  test("连上即推当前快照，新订阅者触发的推送扇出给所有在线连接", async () => {
    let calls = 0;
    const aggregator = aggregatorOf(async () => {
      calls += 1;
      return snapshot(123);
    });
    const { port, stop } = startStatusServer(aggregator, quotaOf(), () => {});
    const a = connectStatus(port);
    const b = connectStatus(port);
    try {
      await a.opened;
      await waitFor(() => a.messages.length >= 1);
      expect(a.messages[0]).toMatchObject({ observedAt: 123, level: "operational" });

      await b.opened;
      await waitFor(() => b.messages.length >= 1);
      // b 的 open 触发一次推送，a 也应收到第二帧——证明是扇出而非只发新连接。
      await waitFor(() => a.messages.length >= 2);
      expect(b.messages[0]).toMatchObject({ observedAt: 123 });
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      a.socket.close();
      b.socket.close();
      await stop();
    }
  });

  test("快照读取失败只走 sendError 告警，不向订阅者推送", async () => {
    const errors: Array<[string, unknown]> = [];
    const aggregator = aggregatorOf(async () => {
      throw new Error("probe failed");
    });
    const { port, stop } = startStatusServer(aggregator, quotaOf(), (scope, error) =>
      errors.push([scope, error])
    );
    const a = connectStatus(port);
    try {
      await a.opened;
      await waitFor(() => errors.some(([scope]) => scope === "status-ws"));
      await Bun.sleep(30);
      expect(a.messages).toEqual([]);
      expect(errors[0][1]).toBeInstanceOf(Error);
    } finally {
      a.socket.close();
      await stop();
    }
  });

  test("握手名额随连接生命周期占用与归还", async () => {
    const quota = quotaOf();
    const aggregator = aggregatorOf(async () => snapshot(1));
    const { port, stop } = startStatusServer(aggregator, quota, () => {});
    const a = connectStatus(port);
    try {
      await a.opened;
      await waitFor(() => quota.liveConnections() === 1);
      a.socket.close();
      await waitFor(() => quota.liveConnections() === 0);
    } finally {
      a.socket.close();
      await stop();
    }
  });
});
