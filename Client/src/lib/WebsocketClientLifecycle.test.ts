import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/Sentry", () => ({
  captureClientLog: vi.fn(),
  captureClientException: vi.fn(),
  countClientMetric: vi.fn(),
  recordClientMetric: vi.fn(),
  withClientSpan: async (_name: string, callback: (span: unknown) => unknown) =>
    callback({ setStatus: () => {}, setAttribute: () => {} }),
}));

import { WebSocketClient } from "./WebsocketClient";
import { MAX_RECONNECT_DELAY_MS } from "@/config/Constants";
import { FakeSocket, setVisibility } from "@/test/FakeWebSocket";

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setVisibility("visible");
});

describe("连接身份核对", () => {
  it("新连接建立后才到达的旧连接关闭与消息事件不改变新连接的状态", async () => {
    vi.useFakeTimers();
    const client = new WebSocketClient("/api/ws");
    const statuses: boolean[] = [];
    const received: unknown[] = [];
    client.onStatus((connected) => statuses.push(connected));
    client.onMessage((message) => received.push(message));

    client.connect();
    const oldSocket = FakeSocket.instances[0];
    oldSocket.open();
    const oldRequest = client.send("room.join");
    const oldRejection = expect(oldRequest).rejects.toMatchObject({ code: "DISCONNECTED" });

    // 登录换身份：旧连接进入关闭中，收尾事件还没到，页面就重新建连。
    client.refreshIdentity();
    expect(oldSocket.readyState).toBe(FakeSocket.CLOSING);
    client.connect();
    const newSocket = FakeSocket.instances[1];
    newSocket.open();
    const newRequest = client.send("room.join", {}, { timeout: 0 });
    let newSettled = false;
    void newRequest.then(
      () => (newSettled = true),
      () => (newSettled = true)
    );
    statuses.length = 0;

    // 旧连接的收尾与残留消息此刻才到。
    oldSocket.receive({ type: "event", event: "room.updated", payload: {} });
    oldSocket.finishClose();
    await oldRejection;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(received).toEqual([]);
    expect(statuses).toEqual([]);
    expect(newSettled).toBe(false);
    expect(FakeSocket.instances).toHaveLength(2);
    // 新连接仍是当前连接：命令照常发出并得到应答。
    const { id } = JSON.parse(newSocket.sent[0]) as { id: string };
    newSocket.receive({ type: "ack", id, payload: { ok: true } });
    await expect(newRequest).resolves.toMatchObject({ ok: true });
  });

  it("当前连接的关闭照旧拒绝请求、通知断线并重连", async () => {
    vi.useFakeTimers();
    const client = new WebSocketClient("/api/ws");
    const statuses: boolean[] = [];
    client.onStatus((connected) => statuses.push(connected));
    client.connect();
    const socket = FakeSocket.instances[0];
    socket.open();
    const pending = client.send("room.join");
    const rejection = expect(pending).rejects.toMatchObject({ code: "DISCONNECTED" });

    socket.finishClose();
    await rejection;
    expect(statuses).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(MAX_RECONNECT_DELAY_MS);
    expect(FakeSocket.instances).toHaveLength(2);
  });
});
