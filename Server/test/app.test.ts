import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RoomService } from "../src/application/room-service";
import type { AppEnv } from "../src/config/env";
import { createVersionInfo } from "../src/config/version";
import {
  EventLogger,
  formatLogEntry,
  formatSystemLog,
} from "../src/infrastructure/event-logger";
import { WordBankRepository } from "../src/infrastructure/word-bank-repository";
import { createApp } from "../src/transport/app";

// ==================== 真实 HTTP / WebSocket 集成测试 ====================

test("事件日志输出为格式化语义化文本", async () => {
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
  expect(formatted).toContain("房间已创建");
  expect(formatted).toContain("房间=1234");
  expect(formatted).toContain("玩家=player_1");
  expect(formatted).toContain("可见性=私密");
  expect(formatted).toContain("允许旁观=是");
  expect(formatted).toContain("阵营配置={卧底数=2, 天使=否, 白板=是}");
  expect(formatted).not.toContain('{"type"');
});

test("系统日志支持统一级别格式", () => {
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

  expect(lines[0]).toContain("[INFO]");
  expect(lines[0]).toContain("WhoIsFaker 服务已启动");
  expect(lines[0]).toContain("版本=1.1.0");
  expect(lines[1]).toContain("[WARN]");
  expect(lines[1]).toContain("信号=终止信号");
  expect(lines[2]).toContain("[ERROR]");
  expect(lines[2]).toContain("错误类型=TypeError");
  expect(
    formatSystemLog({
      level: "WARN",
      message: "收到停机信号，开始优雅停机",
      createdAt: Date.UTC(2026, 3, 17, 8, 0, 0, 0),
      context: {
        signal: "SIGTERM",
      },
    }),
  ).toContain("[WARN]");
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

test("HTTP 与 WebSocket 路由可以联通", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "whoisfaker-app-"));

  afterEach(() => {
    rmSync(tempDir, { force: true, recursive: true });
  });

  const env: AppEnv = {
    clientUrl: "http://localhost:5173",
    serverUrl: "http://127.0.0.1",
    serverListenHost: "127.0.0.1",
    serverPort: 0,
    gitCommit: "test",
    wordBankPath: join(tempDir, "word-bank.json"),
  };
  const roomService = new RoomService({
    eventLogger: new EventLogger(),
    wordBankRepository: new WordBankRepository(env.wordBankPath),
  });
  const logger = new EventLogger();
  const { app } = createApp({
    env,
    roomService,
    versionInfo: createVersionInfo(env.gitCommit),
    logger,
  });
  const started = app.listen({
    hostname: env.serverListenHost,
    port: env.serverPort,
  });
  const port = started.server?.port;

  if (!port) {
    throw new Error("未能获取测试端口");
  }

  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    const version = await fetch(`http://127.0.0.1:${port}/version`);

    expect(health.ok).toBe(true);
    expect(version.ok).toBe(true);
    expect((await health.json()).status).toBe("ok");
    expect((await version.json()).commit).toBe("test");

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("WebSocket 打开失败")),
        {
          once: true,
        },
      );
    });
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
        (payload as { payload?: { roomId?: string } }).payload?.roomId === "8888",
    )) as { payload: { roomId: string } };

    expect(snapshot.payload.roomId).toBe("8888");

    socket.send("not-json");
    const invalidMessageError = (await waitForSocketMessage(
      (payload) =>
        Boolean(payload) &&
        (payload as { type?: string }).type === "error" &&
        (payload as { error?: { code?: string } }).error?.code === "INTERNAL_ERROR",
    )) as { error: { code: string } };

    expect(invalidMessageError.error.code).toBe("INTERNAL_ERROR");
    socket.close();
  } finally {
    await started.stop(true);
  }
});
