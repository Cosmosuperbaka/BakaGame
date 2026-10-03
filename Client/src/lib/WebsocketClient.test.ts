import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ captureClientException: vi.fn(), captureClientLog: vi.fn(), spanAttributes: vi.fn() }));

vi.mock("@/lib/Sentry", () => ({
  captureClientLog: mocks.captureClientLog,
  captureClientException: mocks.captureClientException,
  countClientMetric: vi.fn(),
  recordClientMetric: vi.fn(),
  withClientSpan: async (_name: string, callback: (span: unknown) => unknown, attributes: unknown) => {
    mocks.spanAttributes(attributes);
    return callback({ setStatus: () => {}, setAttribute: () => {} });
  },
}));

import { generateUuid, isProtocolError, WebSocketClient } from "./WebsocketClient";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "@/config/Constants";

interface MockSocketInstance {
  url: string;
  readyState: number;
  sent: string[];
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
}

const createMockSocketClass = (options: { sendThrows?: Error } = {}) => {
  const instances: MockSocketInstance[] = [];

  class MockWebSocket implements MockSocketInstance {
    static OPEN = 1;
    static CONNECTING = 0;
    static instances = instances;
    url: string;
    readyState = MockWebSocket.OPEN;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(url: string) {
      this.url = url;
      instances.push(this);
    }

    send(data: string) {
      if (options.sendThrows) throw options.sendThrows;
      this.sent.push(data);
    }

    close() {}
  }

  return MockWebSocket;
};

/** 建立连接、发出一条请求，并取回该请求的协议 id。 */
const openRequest = async (sendThrows?: Error) => {
  const MockWebSocket = createMockSocketClass(sendThrows ? { sendThrows } : {});
  vi.stubGlobal("WebSocket", MockWebSocket);

  const client = new WebSocketClient("/api/songuessr/ws");
  client.connect();
  const socket = MockWebSocket.instances.at(-1)!;

  const pending = client.send("song.room.join", { roomId: "1234" });
  const requestId = socket.sent.length
    ? (JSON.parse(socket.sent[0]) as { id: string }).id
    : "";

  return { client, socket, pending, requestId };
};

describe("WebSocketClient", () => {
  it("在非安全上下文（crypto.randomUUID 不存在）时平滑降级生成合法 UUID", () => {
    const originalRandomUuid = globalThis.crypto?.randomUUID;
    try {
      // @ts-expect-error 模拟非安全上下文缺少 randomUUID
      globalThis.crypto.randomUUID = undefined;
      const uuid = generateUuid();
      expect(uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    } finally {
      if (originalRandomUuid) {
        globalThis.crypto.randomUUID = originalRandomUuid;
      }
    }
  });

  it("在安全上下文中优先使用原生 crypto.randomUUID", () => {
    const uuid = generateUuid();
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("正确去除服务器地址末尾斜杠，避免双斜杠路径", () => {
    let createdWsUrl = "";
    class MockWebSocket {
      static OPEN = 1;
      static CONNECTING = 0;
      readyState = MockWebSocket.CONNECTING;
      constructor(url: string) {
        createdWsUrl = url;
      }
      close() {}
      send() {}
    }
    vi.stubGlobal("WebSocket", MockWebSocket);

    const client = new WebSocketClient("/api/whoisfaker/ws");
    client.connect();

    expect(createdWsUrl).not.toContain("//api");
    expect(createdWsUrl).toMatch(/\/api\/whoisfaker\/ws$/);

    vi.unstubAllGlobals();
  });

  it("isProtocolError 只认携带 code 与 message 的协议错误体", () => {
    expect(isProtocolError({ code: "ROOM_NOT_FOUND", message: "房间不存在" })).toBe(true);
    expect(isProtocolError({ code: "PASSWORD_INCORRECT", message: "房间密码错误", details: {} })).toBe(true);
    expect(isProtocolError(new Error("房间不存在"))).toBe(false);
    expect(isProtocolError({ code: "ROOM_NOT_FOUND" })).toBe(false);
    expect(isProtocolError({ message: "房间不存在" })).toBe(false);
    expect(isProtocolError("房间不存在")).toBe(false);
    expect(isProtocolError(null)).toBe(false);
    expect(isProtocolError(undefined)).toBe(false);
  });

  it("业务拒绝（密码错误等）原样抛给调用方，但绝不上报为异常事件", async () => {
    const { socket, pending, requestId } = await openRequest();

    socket.onmessage!({
      data: JSON.stringify({
        type: "error",
        id: requestId,
        error: { code: "PASSWORD_INCORRECT", message: "房间密码错误" },
      }),
    });

    await expect(pending).rejects.toMatchObject({
      code: "PASSWORD_INCORRECT",
      message: "房间密码错误",
    });
    expect(mocks.captureClientException).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("断连等可预期协议应答同样不产生异常事件", async () => {
    const { socket, pending } = await openRequest();

    socket.onclose!();

    await expect(pending).rejects.toMatchObject({ code: "DISCONNECTED" });
    expect(mocks.captureClientException).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("真正的异常仍然照常上报", async () => {
    const explosion = new Error("socket exploded");
    const { pending } = await openRequest(explosion);

    await expect(pending).rejects.toThrow("socket exploded");
    expect(mocks.captureClientException).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it("主动离开会拒绝未完成请求、取消重连且允许随后重新连接", async () => {
    vi.useFakeTimers();
    try {
      const MockWebSocket = createMockSocketClass();
      vi.stubGlobal("WebSocket", MockWebSocket);
      const client = new WebSocketClient("/api/ccb/ws");
      client.connect();
      const socket = MockWebSocket.instances[0];
      const pending = client.send("ccb.game.next", {}, { timeout: 0 });
      const rejection = expect(pending).rejects.toMatchObject({ code: "DISCONNECTED" });
      client.disconnect();
      await rejection;
      expect(socket.onclose).toBeNull();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(MockWebSocket.instances).toHaveLength(1);
      client.connect();
      expect(MockWebSocket.instances).toHaveLength(2);
      MockWebSocket.instances[1].onclose!();
      client.disconnect();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(MockWebSocket.instances).toHaveLength(2);
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
  });

  it("主动断开取消正在等待的首次连接", async () => {
    const MockWebSocket = createMockSocketClass();
    vi.stubGlobal("WebSocket", MockWebSocket);
    try {
      const client = new WebSocketClient("/api/ccb/ws");
      client.connect();
      MockWebSocket.instances[0].readyState = MockWebSocket.CONNECTING;
      const pending = client.send("ccb.room.reconnect");
      const rejection = expect(pending).rejects.toMatchObject({ code: "DISCONNECTED" });
      client.disconnect();
      await rejection;
    } finally { vi.unstubAllGlobals(); }
  });

  it("timeout 为 0 时不设请求超时，越过默认超时后迟到的 ACK 依然能完成请求", async () => {
    vi.useFakeTimers();
    try {
      const MockWebSocket = createMockSocketClass();
      vi.stubGlobal("WebSocket", MockWebSocket);

      const client = new WebSocketClient("/api/songuessr/ws");
      client.connect();
      const socket = MockWebSocket.instances.at(-1)!;

      const pending = client.send("song.game.start", {}, { timeout: 0 });
      const requestId = (JSON.parse(socket.sent[0]) as { id: string }).id;

      // 自动出题耗时由上游决定：越过默认请求超时也不得被判为失败。
      await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS + 5_000);

      socket.onmessage!({
        data: JSON.stringify({ type: "ack", id: requestId, payload: { started: true } }),
      });
      await expect(pending).resolves.toMatchObject({ started: true });
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});


describe("传输边界与命令诊断", () => {
  beforeEach(() => vi.clearAllMocks());

  it("坏帧不派发，消费失败保留原异常且不阻断后续消费者", () => {
    const Socket = createMockSocketClass();
    vi.stubGlobal("WebSocket", Socket);
    try {
      const client = new WebSocketClient("/api/ccb/ws");
      client.connect();
      const error = new Error("consumer failed");
      const first = vi.fn(() => { throw error; });
      const second = vi.fn();
      client.onMessage(first);
      client.onMessage(second);
      for (const data of ["{", "null", "[]", '{"type":"error","id":"x","error":{}}', '{"type":"event"}']) {
        Socket.instances[0].onmessage!({ data });
      }
      expect(first).not.toHaveBeenCalled();
      expect(mocks.captureClientException).not.toHaveBeenCalled();
      const message = { type: "event", event: "room.updated", payload: {} };
      Socket.instances[0].onmessage!({ data: JSON.stringify(message) });
      expect(second).toHaveBeenCalledWith(message);
      expect(mocks.captureClientException).toHaveBeenCalledWith(error, {
        path: "/api/ccb/ws", messageType: "event",
      });
      client.disconnect();
    } finally { vi.unstubAllGlobals(); }
  });

  it("命令 span、拒绝日志与信封共用关联键，ACK 清理计时器", async () => {
    vi.useFakeTimers();
    const Socket = createMockSocketClass();
    vi.stubGlobal("WebSocket", Socket);
    try {
      const client = new WebSocketClient("/api/ccb/ws");
      client.connect();
      const socket = Socket.instances[0];
      const pending = client.send("ccb.room.join", { password: "private" });
      const rejection = expect(pending).rejects.toMatchObject({ code: "PASSWORD_INCORRECT" });
      const envelope = JSON.parse(socket.sent[0]);
      socket.onmessage!({ data: JSON.stringify({ type: "error", id: envelope.id, error: {
        code: "PASSWORD_INCORRECT", message: "密码错误",
      } }) });
      await rejection;
      expect(mocks.spanAttributes).toHaveBeenCalledWith(expect.objectContaining({ traceId: envelope.traceId }));
      expect(mocks.captureClientLog).toHaveBeenCalledWith("WebSocket 命令失败", "error", expect.objectContaining({
        traceId: envelope.traceId, code: "PASSWORD_INCORRECT", message: "密码错误", error: "密码错误",
      }));
      expect(mocks.captureClientException).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      const accepted = client.send("ccb.room.get");
      const next = JSON.parse(socket.sent[1]);
      expect(next.traceId).not.toBe(envelope.traceId);
      socket.onmessage!({ data: JSON.stringify({ type: "ack", id: next.id, payload: { ok: true } }) });
      await expect(accepted).resolves.toEqual({ ok: true });
      expect(vi.getTimerCount()).toBe(0);
      client.disconnect();
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
  });
});
