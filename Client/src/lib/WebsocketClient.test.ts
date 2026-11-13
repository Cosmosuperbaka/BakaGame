import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureClientException: vi.fn(),
  captureClientLog: vi.fn(),
  spanAttribute: vi.fn(),
  /** 假的「当前活动跨度」的追踪号；置成全零模拟没有活动跨度。 */
  spanTraceId: { current: "0af7651916cd43dd8448eb211c80319c" },
}));

vi.mock("@/lib/Sentry", () => ({
  captureClientLog: mocks.captureClientLog,
  captureClientException: mocks.captureClientException,
  countClientMetric: vi.fn(),
  recordClientMetric: vi.fn(),
  withClientSpan: async (_name: string, callback: (span: unknown) => unknown) =>
    callback({
      setStatus: () => {},
      setAttribute: mocks.spanAttribute,
      spanContext: () => ({ traceId: mocks.spanTraceId.current }),
    }),
}));

import {
  generateUuid,
  isProtocolError,
  WebSocketClient,
  type ConnectionPrelude,
} from "./WebsocketClient";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "@/config/Constants";
import { getClockOffsetMs, resetClockSample } from "@/stores/UseServerClock";

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
  const requestId = socket.sent.length ? (JSON.parse(socket.sent[0]) as { id: string }).id : "";

  return { client, socket, pending, requestId };
};

describe("WebSocketClient", () => {
  it("在非安全上下文（crypto.randomUUID 不存在）时平滑降级生成合法 UUID", () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- 只保存原引用并在 finally 写回同一个 crypto，从不解绑调用
    const originalRandomUuid = globalThis.crypto?.randomUUID;
    try {
      // @ts-expect-error 模拟非安全上下文缺少 randomUUID
      globalThis.crypto.randomUUID = undefined;
      const uuid = generateUuid();
      expect(uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    } finally {
      if (originalRandomUuid) {
        globalThis.crypto.randomUUID = originalRandomUuid;
      }
    }
  });

  it("非安全上下文的降级只用 crypto.getRandomValues，不碰 Math.random", () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- 只保存原引用并在 finally 写回同一个 crypto，从不解绑调用
    const originalRandomUuid = globalThis.crypto.randomUUID;
    const random = vi.spyOn(Math, "random");
    try {
      // @ts-expect-error 模拟非安全上下文缺少 randomUUID
      globalThis.crypto.randomUUID = undefined;
      const uuids = new Set(Array.from({ length: 50 }, () => generateUuid()));
      expect(uuids.size).toBe(50);
      for (const uuid of uuids)
        expect(uuid).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        );
      expect(random).not.toHaveBeenCalled();
    } finally {
      globalThis.crypto.randomUUID = originalRandomUuid;
    }
  });

  it("在安全上下文中优先使用原生 crypto.randomUUID", () => {
    const uuid = generateUuid();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  describe("连接前置帧", () => {
    const openWithPrelude = (prelude: ConnectionPrelude) => {
      const MockWebSocket = createMockSocketClass();
      vi.stubGlobal("WebSocket", MockWebSocket);
      const client = new WebSocketClient("/api/ws", { prelude });
      const statuses: boolean[] = [];
      client.onStatus((connected) => statuses.push(connected));
      client.connect();
      const socket = MockWebSocket.instances.at(-1)!;
      socket.onopen!();
      return { client, socket, statuses };
    };

    const ack = (socket: MockSocketInstance, index: number, payload: object) => {
      const { id } = JSON.parse(socket.sent[index]) as { id: string };
      socket.onmessage!({ data: JSON.stringify({ type: "ack", id, payload }) });
    };

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("前置帧走完才宣告可用：业务命令排在身份绑定之后", async () => {
      const { client, socket, statuses } = openWithPrelude(async (exchange) => {
        await exchange("site.session.attach", { token: "tab" });
      });

      expect(statuses).toEqual([]);
      const pending = client.send("room.join", { userName: "玩家" });
      await Promise.resolve();
      expect(socket.sent.map((frame) => (JSON.parse(frame) as { type: string }).type)).toEqual([
        "site.session.attach",
      ]);

      ack(socket, 0, { attached: true });
      await vi.waitFor(() => expect(statuses).toEqual([true]));
      await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
      expect((JSON.parse(socket.sent[1]) as { type: string }).type).toBe("room.join");

      ack(socket, 1, { roomId: "1234" });
      await expect(pending).resolves.toEqual({ roomId: "1234" });
      client.disconnect();
    });

    it("前置帧失败不拦业务：按无身份继续", async () => {
      const { client, statuses } = openWithPrelude(() => Promise.reject(new Error("旧服务端")));

      await vi.waitFor(() => expect(statuses).toEqual([true]));
      await expect(client.waitForConnection(10)).resolves.toBeUndefined();
      client.disconnect();
    });

    it("前置帧途中连接断开：不宣告可用，等待者交给下一次建连", async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { client, socket, statuses } = openWithPrelude(() => gate);

      (socket as { readyState: number }).readyState = 3;
      socket.onclose!();
      release();
      await gate;
      await Promise.resolve();

      expect(statuses).toEqual([false]);
      client.disconnect();
    });

    it("令牌只走首帧，握手地址里没有它", async () => {
      const { client, socket } = openWithPrelude(async (exchange) => {
        await exchange("site.session.attach", { token: "secret-tab-token" });
      });

      expect(socket.url).not.toContain("secret-tab-token");
      expect(socket.sent[0]).toContain("secret-tab-token");
      client.disconnect();
    });
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
    expect(
      isProtocolError({ code: "PASSWORD_INCORRECT", message: "房间密码错误", details: {} })
    ).toBe(true);
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
      const client = new WebSocketClient("/api/cee/ws");
      client.connect();
      const socket = MockWebSocket.instances[0];
      const pending = client.send("cee.game.next", {}, { timeout: 0 });
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
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("主动断开取消正在等待的首次连接", async () => {
    const MockWebSocket = createMockSocketClass();
    vi.stubGlobal("WebSocket", MockWebSocket);
    try {
      const client = new WebSocketClient("/api/cee/ws");
      client.connect();
      MockWebSocket.instances[0].readyState = MockWebSocket.CONNECTING;
      const pending = client.send("cee.room.reconnect");
      const rejection = expect(pending).rejects.toMatchObject({ code: "DISCONNECTED" });
      client.disconnect();
      await rejection;
    } finally {
      vi.unstubAllGlobals();
    }
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
      const client = new WebSocketClient("/api/cee/ws");
      client.connect();
      const error = new Error("consumer failed");
      const first = vi.fn(() => {
        throw error;
      });
      const second = vi.fn();
      client.onMessage(first);
      client.onMessage(second);
      for (const data of [
        "{",
        "null",
        "[]",
        '{"type":"error","id":"x","error":{}}',
        '{"type":"event"}',
      ]) {
        Socket.instances[0].onmessage!({ data });
      }
      expect(first).not.toHaveBeenCalled();
      expect(mocks.captureClientException).not.toHaveBeenCalled();
      const message = { type: "event", event: "room.updated", payload: {} };
      Socket.instances[0].onmessage!({ data: JSON.stringify(message) });
      expect(second).toHaveBeenCalledWith(message);
      expect(mocks.captureClientException).toHaveBeenCalledWith(error, {
        path: "/api/cee/ws",
        messageType: "event",
      });
      client.disconnect();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("命令 span、拒绝日志与信封共用关联键，ACK 清理计时器", async () => {
    vi.useFakeTimers();
    const Socket = createMockSocketClass();
    vi.stubGlobal("WebSocket", Socket);
    try {
      const client = new WebSocketClient("/api/cee/ws");
      client.connect();
      const socket = Socket.instances[0];
      const pending = client.send("cee.room.join", { password: "private" });
      const rejection = expect(pending).rejects.toMatchObject({ code: "PASSWORD_INCORRECT" });
      const envelope = JSON.parse(socket.sent[0]);
      socket.onmessage!({
        data: JSON.stringify({
          type: "error",
          id: envelope.id,
          error: {
            code: "PASSWORD_INCORRECT",
            message: "密码错误",
          },
        }),
      });
      await rejection;
      // 追踪号取自当前活动跨度，与错误上报同号；信封、span 属性与失败日志共用它。
      expect(envelope.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
      expect(mocks.spanAttribute).toHaveBeenCalledWith("traceId", envelope.traceId);
      expect(mocks.captureClientLog).toHaveBeenCalledWith(
        "WebSocket 命令失败",
        "error",
        expect.objectContaining({
          traceId: envelope.traceId,
          code: "PASSWORD_INCORRECT",
          message: "密码错误",
          error: "密码错误",
        })
      );
      expect(mocks.captureClientException).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      const accepted = client.send("cee.room.get");
      const next = JSON.parse(socket.sent[1]);
      socket.onmessage!({
        data: JSON.stringify({ type: "ack", id: next.id, payload: { ok: true } }),
      });
      await expect(accepted).resolves.toEqual({ ok: true });
      expect(vi.getTimerCount()).toBe(0);
      client.disconnect();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("没有活动跨度（追踪号全零）时自造 UUID 作追踪号，每条命令各一个", async () => {
    const Socket = createMockSocketClass();
    vi.stubGlobal("WebSocket", Socket);
    mocks.spanTraceId.current = "00000000000000000000000000000000";
    try {
      const client = new WebSocketClient("/api/cee/ws");
      client.connect();
      const socket = Socket.instances[0];
      void client.send("cee.room.get").catch(() => undefined);
      void client.send("cee.room.get").catch(() => undefined);
      const [first, second] = socket.sent.map((frame) => JSON.parse(frame) as { traceId: string });
      expect(first.traceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
      expect(second.traceId).not.toBe(first.traceId);
      client.disconnect();
    } finally {
      mocks.spanTraceId.current = "0af7651916cd43dd8448eb211c80319c";
      vi.unstubAllGlobals();
    }
  });

  it("发送拦截器包装底层发送：send 走拦截器，拦截器能改写命令并再次调用底层", async () => {
    const Socket = createMockSocketClass();
    vi.stubGlobal("WebSocket", Socket);
    try {
      const seen: string[] = [];
      const client = new WebSocketClient("/api/ws", {
        sendInterceptor: (next) => (type, payload, options) => {
          seen.push(type);
          return next(`wrapped.${type}`, payload, options);
        },
      });
      client.connect();
      const socket = Socket.instances[0];
      void client.send("room.get").catch(() => undefined);
      expect(seen).toEqual(["room.get"]);
      expect((JSON.parse(socket.sent[0]) as { type: string }).type).toBe("wrapped.room.get");
      client.disconnect();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  describe("时钟偏差取样", () => {
    const openClock = () => {
      const Socket = createMockSocketClass();
      vi.stubGlobal("WebSocket", Socket);
      const client = new WebSocketClient("/api/ws");
      client.connect();
      return { client, socket: Socket.instances[0] };
    };
    const requestIdOf = (socket: MockSocketInstance, index = 0) =>
      (JSON.parse(socket.sent[index]) as { id: string }).id;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      resetClockSample();
    });
    afterEach(() => {
      resetClockSample();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it("确认帧带服务端时刻：按发送与接收的中点记下偏差", async () => {
      const { client, socket } = openClock();
      const pending = client.send("room.get");
      vi.setSystemTime(10_200);
      // 本机时钟比服务端快 6 秒：服务端时刻 4_100 对应本机中点 10_100。
      socket.onmessage!({
        data: JSON.stringify({ type: "ack", id: requestIdOf(socket), serverNow: 4_100 }),
      });
      await pending;
      expect(getClockOffsetMs()).toBe(-6_000);
      client.disconnect();
    });

    it("不带服务端时刻的确认帧与事件帧、错误帧都不产生样本", async () => {
      const { client, socket } = openClock();
      const first = client.send("room.get");
      socket.onmessage!({ data: JSON.stringify({ type: "ack", id: requestIdOf(socket) }) });
      await first;
      socket.onmessage!({
        data: JSON.stringify({ type: "event", event: "x", payload: {}, serverNow: 1 }),
      });
      const second = client.send("room.get");
      const rejected = second.catch((error: unknown) => error);
      socket.onmessage!({
        data: JSON.stringify({
          type: "error",
          id: requestIdOf(socket, 1),
          error: { code: "X", message: "m" },
          serverNow: 1,
        }),
      });
      await rejected;
      expect(getClockOffsetMs()).toBe(0);
      client.disconnect();
    });

    it("往返长的确认帧不覆盖往返短的样本", async () => {
      const { client, socket } = openClock();
      const fast = client.send("room.get");
      vi.setSystemTime(10_040);
      socket.onmessage!({
        data: JSON.stringify({ type: "ack", id: requestIdOf(socket), serverNow: 4_020 }),
      });
      await fast;
      expect(getClockOffsetMs()).toBe(-6_000);

      const slow = client.send("room.get");
      vi.setSystemTime(11_240);
      socket.onmessage!({
        data: JSON.stringify({ type: "ack", id: requestIdOf(socket, 1), serverNow: 5_900 }),
      });
      await slow;
      expect(getClockOffsetMs()).toBe(-6_000);
      client.disconnect();
    });

    it("连接断开后样本作废，重连后重新取样", async () => {
      const { client, socket } = openClock();
      const pending = client.send("room.get");
      socket.onmessage!({
        data: JSON.stringify({ type: "ack", id: requestIdOf(socket), serverNow: 4_000 }),
      });
      await pending;
      expect(getClockOffsetMs()).toBe(-6_000);

      socket.readyState = 3;
      socket.onclose!();
      expect(getClockOffsetMs()).toBe(0);
      client.disconnect();
    });
  });
});
