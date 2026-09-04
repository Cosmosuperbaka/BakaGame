import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RoomService } from "../src/application/RoomService";
import type { AppEnv } from "../src/config/Env";
import {
  describeError,
  EventLogger,
  formatLogEntry,
  formatSystemLog,
  redactData,
} from "../src/infrastructure/EventLogger";
import { WordBankRepository } from "../src/infrastructure/WordBankRepository";
import { createApp } from "../src/transport/App";

// ==================== 真实 HTTP / WebSocket 集成测试 ====================

test("事件日志输出为极简 GIN 风格格式化文本", async () => {
  const output: string[] = [];
  const logger = new EventLogger((message) => {
    output.push(message);
  });

  const entry = {
    type: "room.created",
    createdAt: Date.UTC(2026, 3, 16, 9, 30, 15, 120),
    roomId: "1234",
    playerId: "player_1",
    payload: {
      visibility: "private",
      allowSpectators: true,
      roleConfig: {
        undercoverCount: 2,
        hasAngel: false,
        hasBlank: true,
      },
    },
  } as const;

  const formatted = formatLogEntry(entry);
  await logger.write(entry);

  expect(output).toHaveLength(1);
  expect(output[0]).toBe(formatted);
  expect(formatted).toContain("[BAKA]");
  expect(formatted).toContain("200");
  expect(formatted).toContain("EVENT room.created (房间已创建)");
  expect(formatted).toContain("1234");
  expect(formatted).not.toContain("详情:");
});

test("系统日志支持极简 GIN 风格状态码与列表格式", () => {
  const lines: string[] = [];
  const logger = new EventLogger({
    info: (message) => lines.push(message),
    warn: (message) => lines.push(message),
    error: (message) => lines.push(message),
  });

  logger.info("WhoIsFaker 服务已启动", {
    version: "1.1.0",
    serverUrl: "http://127.0.0.1:4850",
    listenAddress: "127.0.0.1:4850",
  });
  logger.warn("收到停机信号，开始优雅停机", {
    signal: "SIGTERM",
  });
  logger.error("WebSocket 请求发生未捕获异常", {
    connectionId: "conn_1",
    requestId: "req_1",
    errorName: "TypeError",
    errorMessage: "boom",
  });

  expect(lines[0]).toContain("[BAKA]");
  expect(lines[0]).toContain("200");
  expect(lines[0]).toContain("SYS WhoIsFaker 服务已启动");
  expect(lines[1]).toContain("400");
  expect(lines[2]).toContain("500");
  expect(lines[0]).not.toContain("详情:");
  expect(
    formatSystemLog({
      level: "WARN",
      message: "收到停机信号，开始优雅停机",
      createdAt: Date.UTC(2026, 3, 17, 8, 0, 0, 0),
      context: {
        signal: "SIGTERM",
      },
    }),
  ).toContain("[BAKA]");
});

test("describeError 完整保留调用栈与 Cause，且 redactData 对敏感凭据有效脱敏", () => {
  const innerError = new Error("底层文件损坏");
  const outerError = new Error("保存房间失败", { cause: innerError });
  const desc = describeError(outerError);

  expect(desc.errorName).toBe("Error");
  expect(desc.errorMessage).toBe("保存房间失败");
  expect(typeof desc.stack).toBe("string");
  expect((desc.cause as Record<string, unknown>).errorMessage).toBe("底层文件损坏");

  const sensitive = {
    cookie: "MUSIC_U=abcdef1234567890",
    sessionToken: "secret-token-xyz",
    password: "my-password",
    normalField: "visible",
  };
  const redacted = redactData(sensitive) as Record<string, string>;
  expect(redacted.cookie).toContain("***[REDACTED]");
  expect(redacted.cookie).not.toContain("1234567890");
  expect(redacted.sessionToken).toContain("***[REDACTED]");
  expect(redacted.password).toBe("***[REDACTED]");
  expect(redacted.normalField).toBe("visible");
});

test("Elysia 原生 app.handle 可以直接测试 HTTP 与 CORS 逻辑", async () => {
  const env: AppEnv = {
    clientUrl: "http://localhost:5173",
    serverUrl: "http://127.0.0.1",
    serverListenHost: "127.0.0.1",
    serverPort: 0,
    wordBankPath: ":memory:",
  };
  const roomService = new RoomService({
    eventLogger: new EventLogger(),
    wordBankRepository: new WordBankRepository(env.wordBankPath),
  });
  const logger = new EventLogger();
  const { app } = createApp({
    env,
    roomService,
    logger,
  });

  const healthRes = await app.handle(new Request("http://localhost/health"));
  expect(healthRes.status).toBe(200);
  expect((await healthRes.json()).status).toBe("ok");

  const optionsRes = await app.handle(
    new Request("http://localhost/health", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "GET",
      },
    }),
  );
  expect(optionsRes.headers.get("access-control-allow-origin")).toBe(
    "http://localhost:5173",
  );
});

// 收集测试期间的 WebSocket 推送，便于按事件类型断言。
const createSocketCollector = (socket: WebSocket) => {
  const queue: unknown[] = [];
  socket.addEventListener("message", (event: MessageEvent<string>) => {
    queue.push(JSON.parse(event.data));
  });

  return async (predicate: (payload: unknown) => boolean, timeoutMs = 3000) =>
    new Promise<unknown>((resolve, reject) => {
      const startedAt = Date.now();

      const tick = () => {
        const matched = queue.find((payload) => predicate(payload));

        if (matched) {
          resolve(matched);
          return;
        }

        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error("等待 WebSocket 消息超时"));
          return;
        }

        setTimeout(tick, 20);
      };

      tick();
    });
};

const openSocket = async (port: number) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/whoisfaker/ws`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket 打开失败")), {
      once: true,
    });
  });
  return socket;
};

const startTestServer = () => {
  const tempDir = mkdtempSync(join(tmpdir(), "whoisfaker-app-"));
  const env: AppEnv = {
    clientUrl: "http://localhost:5173",
    serverUrl: "http://127.0.0.1",
    serverListenHost: "127.0.0.1",
    serverPort: 0,
    wordBankPath: join(tempDir, "word-bank.json"),
  };
  const roomService = new RoomService({
    eventLogger: new EventLogger(),
    wordBankRepository: new WordBankRepository(env.wordBankPath),
  });
  const { app } = createApp({
    env,
    roomService,
    logger: new EventLogger(),
  });
  const started = app.listen({
    hostname: env.serverListenHost,
    port: env.serverPort,
  });
  const port = started.server?.port;

  if (!port) {
    rmSync(tempDir, { force: true, recursive: true });
    throw new Error("未能获取测试端口");
  }

  return {
    port,
    stop: async () => {
      await started.stop(true);
      rmSync(tempDir, { force: true, recursive: true });
    },
  };
};

test("WebSocket 不协商 permessage-deflate", async () => {
  const { port, stop } = startTestServer();

  try {
    const socket = await openSocket(port);
    expect(socket.extensions).not.toContain("permessage-deflate");
    socket.close();
  } finally {
    await stop();
  }
});

test("HTTP 与 WebSocket 路由可以联通", async () => {
  const { port, stop } = startTestServer();

  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);

    expect(health.ok).toBe(true);
    expect((await health.json()).status).toBe("ok");

    const socket = await openSocket(port);
    const waitForSocketMessage = createSocketCollector(socket);

    socket.send(
      JSON.stringify({
        id: "sub",
        type: "lobby.subscribeRooms",
        payload: {},
      }),
    );

    const lobbyPayload = (await waitForSocketMessage(
      (payload) =>
        Boolean(payload) &&
        (payload as { type?: string }).type === "event" &&
        (payload as { event?: string }).event === "lobby.rooms",
    )) as { payload: Array<{ roomId: string }> };

    expect(Array.isArray(lobbyPayload.payload)).toBe(true);

    socket.send(
      JSON.stringify({
        id: "create",
        type: "room.create",
        payload: {
          roomId: "8888",
          name: "集成测试房间",
          visibility: "public",
          allowSpectators: true,
          userName: "集成房主",
        },
      }),
    );

    const snapshot = (await waitForSocketMessage(
      (payload) =>
        Boolean(payload) &&
        (payload as { type?: string }).type === "event" &&
        (payload as { event?: string }).event === "room.snapshot" &&
        (payload as { payload?: { mode?: string; state?: { roomId?: string } } }).payload?.mode === "full" &&
        (payload as { payload?: { state?: { roomId?: string } } }).payload?.state?.roomId === "8888",
    )) as { payload: { state: { roomId: string } } };

    expect(snapshot.payload.state.roomId).toBe("8888");

    const populatedHealth = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await populatedHealth.json()).toMatchObject({
      status: "ok",
      roomCount: 1,
      connectionCount: 1,
      onlinePlayerCount: 1,
    });

    socket.send("not-json");
    const invalidMessageError = (await waitForSocketMessage(
      (payload) =>
        Boolean(payload) &&
        (payload as { type?: string }).type === "error" &&
        (payload as { error?: { code?: string } }).error?.code === "INVALID_MESSAGE",
    )) as { error: { code: string } };

    expect(invalidMessageError.error.code).toBe("INVALID_MESSAGE");
    socket.close();
  } finally {
    await stop();
  }
});

test("HTTP 响应头携带 x-trace-id，且 WebSocket 请求透传 traceId 并实现会话隔离", async () => {
  const { port, stop } = startTestServer();

  try {
    const customTraceId = "trace-test-123456";
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { "x-trace-id": customTraceId },
    });
    expect(res.headers.get("x-trace-id")).toBe(customTraceId);

    const socketA = await openSocket(port);
    const socketB = await openSocket(port);
    const collectorA = createSocketCollector(socketA);
    const collectorB = createSocketCollector(socketB);

    // Socket A 发送带 traceId 的请求
    socketA.send(
      JSON.stringify({
        id: "req-shared-id",
        traceId: "trace-client-a",
        type: "lobby.subscribeRooms",
        payload: {},
      }),
    );

    const ackA = (await collectorA(
      (payload) => (payload as { type?: string }).type === "ack" && (payload as { id?: string }).id === "req-shared-id",
    )) as { type: string; id: string; traceId?: string };
    expect(ackA.type).toBe("ack");
    expect(ackA.traceId).toBe("trace-client-a");

    // Socket B 发送相同的 id，但不应该命中 Socket A 的缓存，应独立处理
    socketB.send(
      JSON.stringify({
        id: "req-shared-id",
        traceId: "trace-client-b",
        type: "lobby.subscribeRooms",
        payload: {},
      }),
    );

    const ackB = (await collectorB(
      (payload) => (payload as { type?: string }).type === "ack" && (payload as { id?: string }).id === "req-shared-id",
    )) as { type: string; id: string; traceId?: string };
    expect(ackB.type).toBe("ack");
    expect(ackB.traceId).toBe("trace-client-b");

    socketA.close();
    socketB.close();
  } finally {
    await stop();
  }
});

