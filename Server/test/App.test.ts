import { expect, spyOn, test } from "bun:test";
import { connect } from "node:net";

import { WhoIsFakerService } from "../src/application/WhoIsFakerService";
import {
  compileRouteTemplates,
  httpOperationAction,
  resolveAgentIdentity,
  UNROUTED_HTTP_ACTION,
} from "../src/transport/App";
import {
  HTTP_MAX_REQUEST_BODY_BYTES,
  WS_HANDSHAKE_IP_MAX_CONNECTIONS,
} from "../src/config/Constants";
import type { AppEnv } from "../src/config/Env";
import { describeError, EventLogger, redactData } from "../src/infrastructure/EventLogger";
import type { OtelLogRecord } from "../src/infrastructure/logging/OtelLog";
import { SERVER_SHUTDOWN_MESSAGE } from "../src/shared/Index";
import { createTestApp as createApp } from "./AppFixtures";

// ==================== 真实 HTTP / WebSocket 集成测试 ====================

test("事件日志完整进入结构化出口，控制台只显示关键事件", async () => {
  const output: string[] = [];
  const records: OtelLogRecord[] = [];
  const logger = new EventLogger(
    (message) => {
      output.push(message);
    },
    undefined,
    undefined,
    undefined,
    { sinks: [{ write: (record) => records.push(record) }] }
  );

  await logger.write({
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
  });

  expect(output).toHaveLength(1);
  expect(output[0]).not.toContain("\n");
  expect(output[0]).toContain("房间已创建");
  expect(output[0]).toContain("房间=1234");
  const [record] = records;
  expect(record).toMatchObject({
    severityText: "INFO",
    body: "房间已创建",
    attributes: { "event.name": "room.created", roomId: "1234", playerId: "player_1" },
  });
  expect((record.attributes.payload as { visibility: string }).visibility).toBe("private");
});

test("系统日志控制台输出等级、中文正文与错误首帧", () => {
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

  expect(lines).toHaveLength(3);
  expect(lines[0]).toContain("INFO");
  expect(lines[0]).toContain("WhoIsFaker 服务已启动");
  expect(lines[1]).toContain("WARN");
  expect(lines[1]).toContain("收到停机信号，开始优雅停机");
  expect(lines[2]).toContain("ERROR");
  expect(lines[2]).toContain("WebSocket 请求发生未捕获异常");
  expect(lines[2]).toContain("异常=TypeError: boom");
  for (const line of lines) expect(line.split("\n")).toHaveLength(1);
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
    maintenanceToken: "test-maintenance-token",
    clientUrl: "http://localhost:5173",
    serverUrl: "http://127.0.0.1",
    serverListenHost: "127.0.0.1",
    serverPort: 0,
    bangumiApiUrl: "https://api.bgm.tv",
    bangumiImageUrl: "",
  };
  const whoIsFakerService = new WhoIsFakerService({
    eventLogger: new EventLogger(),
  });
  const logger = new EventLogger();
  const { app } = createApp({
    env,
    whoIsFakerService,
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
    })
  );
  expect(optionsRes.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
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

const openSocket = async (port: number, game = "whoisfaker") => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/${game}/ws`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket 打开失败")), {
      once: true,
    });
  });
  return socket;
};

const startTestServer = (options?: {
  onTriggerShutdown?: () => Promise<void> | void;
  isShuttingDown?: () => boolean;
  logger?: EventLogger;
}) => {
  const env: AppEnv = {
    maintenanceToken: "test-maintenance-token",
    clientUrl: "http://localhost:5173",
    serverUrl: "http://127.0.0.1",
    serverListenHost: "127.0.0.1",
    serverPort: 0,
    bangumiApiUrl: "https://api.bgm.tv",
    bangumiImageUrl: "",
  };
  let shuttingDown = false;
  const logger = options?.logger ?? new EventLogger();
  const whoIsFakerService = new WhoIsFakerService({
    eventLogger: logger,
  });
  const { app } = createApp({
    env,
    whoIsFakerService,
    logger,
    isShuttingDown: options?.isShuttingDown ?? (() => shuttingDown),
    onTriggerShutdown: async () => {
      shuttingDown = true;
      if (options?.onTriggerShutdown) {
        await options.onTriggerShutdown();
      }
    },
  });
  const started = app.listen({
    hostname: env.serverListenHost,
    port: env.serverPort,
  });
  const port = started.server?.port;

  if (!port) {
    throw new Error("未能获取测试端口");
  }

  return {
    port,
    app,
    whoIsFakerService,
    stop: async () => {
      await started.stop(true);
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
      })
    );

    const lobbyPayload = (await waitForSocketMessage(
      (payload) =>
        Boolean(payload) &&
        (payload as { type?: string }).type === "event" &&
        (payload as { event?: string }).event === "lobby.rooms"
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
      })
    );

    const snapshot = (await waitForSocketMessage(
      (payload) =>
        Boolean(payload) &&
        (payload as { type?: string }).type === "event" &&
        (payload as { event?: string }).event === "room.snapshot" &&
        (payload as { payload?: { mode?: string; state?: { roomId?: string } } }).payload?.mode ===
          "full" &&
        (payload as { payload?: { state?: { roomId?: string } } }).payload?.state?.roomId === "8888"
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
        (payload as { error?: { code?: string } }).error?.code === "INVALID_MESSAGE"
    )) as { error: { code: string } };

    expect(invalidMessageError.error.code).toBe("INVALID_MESSAGE");
    socket.close();
  } finally {
    await stop();
  }
});

test("WebSocket 握手按来源地址配额：在途连接超限回 429，断开后立即归还名额", async () => {
  const { port, stop } = startTestServer();
  const sockets: WebSocket[] = [];

  try {
    for (let index = 0; index < WS_HANDSHAKE_IP_MAX_CONNECTIONS; index += 1) {
      sockets.push(await openSocket(port));
    }

    expect(await upgradeStatusLine(port)).toContain("429");

    const held = sockets.pop()!;
    const closed = new Promise<void>((resolve) => {
      held.addEventListener("close", () => resolve(), { once: true });
      held.close();
    });
    await closed;

    // 服务端观察断开是异步的：允许在有限次数内重试，最终必须重新放行。
    let status = "";
    for (let attempt = 0; attempt < 20 && !status.includes("101"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = await upgradeStatusLine(port);
      if (status.includes("429")) continue;
      break;
    }
    expect(status).toContain("101");
  } finally {
    for (const socket of sockets) socket.close();
    await stop();
  }
});

test("HTTP 请求体超过上限由运行时回 413，不进业务解析", async () => {
  const env: AppEnv = {
    maintenanceToken: "test-maintenance-token",
    clientUrl: "http://localhost:5173",
    serverUrl: "http://127.0.0.1",
    serverListenHost: "127.0.0.1",
    serverPort: 0,
    bangumiApiUrl: "https://api.bgm.tv",
    bangumiImageUrl: "",
  };
  const logger = new EventLogger();
  const { app } = createApp({
    env,
    logger,
    whoIsFakerService: new WhoIsFakerService({ eventLogger: logger }),
  });
  const started = app.listen({
    hostname: env.serverListenHost,
    port: env.serverPort,
    maxRequestBodySize: HTTP_MAX_REQUEST_BODY_BYTES,
  });
  const port = started.server?.port;
  if (!port) {
    throw new Error("未能获取测试端口");
  }

  try {
    const oversized = await fetch(`http://127.0.0.1:${port}/health`, {
      method: "POST",
      body: new Uint8Array(HTTP_MAX_REQUEST_BODY_BYTES + 1024),
    });
    expect(oversized.status).toBe(413);

    const legal = await fetch(`http://127.0.0.1:${port}/health`);
    expect(legal.status).toBe(200);
  } finally {
    await started.stop(true);
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
      })
    );

    const ackA = (await collectorA(
      (payload) =>
        (payload as { type?: string }).type === "ack" &&
        (payload as { id?: string }).id === "req-shared-id"
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
      })
    );

    const ackB = (await collectorB(
      (payload) =>
        (payload as { type?: string }).type === "ack" &&
        (payload as { id?: string }).id === "req-shared-id"
    )) as { type: string; id: string; traceId?: string };
    expect(ackB.type).toBe("ack");
    expect(ackB.traceId).toBe("trace-client-b");

    socketA.close();
    socketB.close();
  } finally {
    await stop();
  }
});

/**
 * 解析失败时必须回一条**客户端能匹配**的错误包，并把原始载荷形态写进日志。
 *
 * 否则链路是：`parse` 抛错 → 错误包 id 退化成占位值 → 客户端 `pendingRequests`
 * 查不到该 id 就静默丢弃 → 进入房间类请求用 `timeout: 0` 永不超时，
 * 页面永远卡在「正在连接房间…」且毫无提示，事后日志只剩 `WS raw` 无法定位命令。
 */
test("解析失败时保留信封身份并记录原始载荷形态", async () => {
  const { port, stop } = startTestServer();
  const socket = await openSocket(port);
  const collector = createSocketCollector(socket);

  try {
    // 命令类型合法、载荷非法：解析阶段抛错，但 id/type 都可从原始载荷抢救出来。
    socket.send(
      JSON.stringify({
        id: "req-salvage-1",
        traceId: "trace-salvage",
        type: "lobby.subscribeRooms",
        payload: { 非法字段: true },
      })
    );

    const errorPacket = (await collector(
      (payload) => (payload as { type?: string }).type === "error"
    )) as { type: string; id: string; error?: { code?: string } };

    expect(errorPacket.id).toBe("req-salvage-1");
    expect(errorPacket.error?.code).toBe("INVALID_MESSAGE");
  } finally {
    socket.close();
    await stop();
  }
});

test("系统探针 /livez 与 /readyz 正确反映就绪度与优雅停机状态", async () => {
  const env: AppEnv = {
    maintenanceToken: "test-maintenance-token",
    clientUrl: "http://localhost:5173",
    serverUrl: "http://127.0.0.1",
    serverListenHost: "127.0.0.1",
    serverPort: 4899,
    bangumiApiUrl: "https://api.bgm.tv",
    bangumiImageUrl: "",
  };
  const logger = new EventLogger();
  let shuttingDown = false;

  const whoIsFakerService = new WhoIsFakerService({ eventLogger: logger });

  const { app } = createApp({
    env,
    whoIsFakerService,
    logger,
    isShuttingDown: () => shuttingDown,
  });

  // 1. livez 探针始终返回 200
  const liveRes = await app.handle(new Request("http://localhost/livez"));
  expect(liveRes.status).toBe(200);
  expect(await liveRes.json()).toEqual({ status: "ok" });

  // 2. 健康状态下 readyz 返回 200
  const readyRes = await app.handle(new Request("http://localhost/readyz"));
  expect(readyRes.status).toBe(200);
  expect(await readyRes.json()).toEqual({ status: "ok", ready: true });

  // 3. 停机流程启动后 readyz 返回 503（数据库不参与就绪判定，游客游玩不依赖它）
  shuttingDown = true;
  const shuttingDownRes = await app.handle(new Request("http://localhost/readyz"));
  expect(shuttingDownRes.status).toBe(503);
  expect(await shuttingDownRes.json()).toEqual({ status: "shutting_down", ready: false });
});

test("WhoIsFakerService.notifyShutdown 会向所有在线连接广播停机通知", async () => {
  const { port, stop, whoIsFakerService } = startTestServer();

  try {
    const socket = await openSocket(port);
    const collector = createSocketCollector(socket);

    whoIsFakerService.notifyShutdown();

    const shutdownEvent = (await collector(
      (payload) =>
        (payload as { type?: string }).type === "event" &&
        (payload as { event?: string }).event === "server.shutdown"
    )) as { type: string; event: string; payload: { message: string } };

    expect(shutdownEvent.type).toBe("event");
    expect(shutdownEvent.event).toBe("server.shutdown");
    expect(shutdownEvent.payload.message).toBe(SERVER_SHUTDOWN_MESSAGE);

    socket.close();
  } finally {
    await stop();
  }
});

test("POST /api/system/notify-shutdown 拦截携带公网代理转发头的外部请求 (403 Forbidden)", async () => {
  const { port, stop } = startTestServer();

  try {
    const resWithXForwardedFor = await fetch(
      `http://127.0.0.1:${port}/api/system/notify-shutdown`,
      {
        method: "POST",
        headers: { "x-forwarded-for": "198.51.100.1, 10.0.0.1" },
      }
    );
    expect(resWithXForwardedFor.status).toBe(403);
    const json1 = (await resWithXForwardedFor.json()) as {
      error?: { code?: string; message?: string; traceId?: string };
    };
    expect(json1.error?.code).toBe("FORBIDDEN");
    expect(json1.error?.message).toContain("维护凭据");
    // 真实服务器由全局 onRequest 写入响应头，错误信封必须带上同一个追踪号，运维才能在日志里定位这一次拒绝。
    const trace1 = resWithXForwardedFor.headers.get("x-trace-id") ?? "";
    expect(trace1).not.toBe("");
    expect(json1.error?.traceId).toBe(trace1);

    const resWithXRealIp = await fetch(`http://127.0.0.1:${port}/api/system/notify-shutdown`, {
      method: "POST",
      headers: { "x-real-ip": "203.0.113.50" },
    });
    expect(resWithXRealIp.status).toBe(403);
    const json2 = (await resWithXRealIp.json()) as {
      error?: { code?: string; message?: string; traceId?: string };
    };
    expect(json2.error?.code).toBe("FORBIDDEN");
    const trace2 = resWithXRealIp.headers.get("x-trace-id") ?? "";
    expect(trace2).not.toBe("");
    expect(json2.error?.traceId).toBe(trace2);
  } finally {
    await stop();
  }
});

test("POST /api/system/notify-shutdown 缺少任何来源 IP 头时同样拒绝，且不触发停机 (fail-closed)", async () => {
  let shutdownTriggered = false;
  const { port, stop } = startTestServer({
    onTriggerShutdown: async () => {
      shutdownTriggered = true;
    },
  });

  try {
    // 直接打本机端口、不经过任何反向代理时，两个转发头都不存在。
    // 以前这会让整个校验块落空、直接触发全服停机广播。
    const res = await fetch(`http://127.0.0.1:${port}/api/system/notify-shutdown`, {
      method: "POST",
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error?: { code?: string } };
    expect(json.error?.code).toBe("FORBIDDEN");
    expect(shutdownTriggered).toBe(false);
  } finally {
    await stop();
  }
});

test("POST /api/system/notify-shutdown 本地调用成功，触发广播、探针状态切换与回调执行", async () => {
  let shutdownTriggered = false;
  const { port, stop } = startTestServer({
    onTriggerShutdown: async () => {
      shutdownTriggered = true;
    },
  });

  try {
    const socket = await openSocket(port);
    const collector = createSocketCollector(socket);

    // 初始 readyz 状态为健康 200
    const initialReady = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(initialReady.status).toBe(200);

    // 本地调用停机通知接口：运维脚本必须显式带上私网来源头，
    // fail-closed 之后缺头的请求一律按来源不可信拒绝。
    const shutdownRes = await fetch(`http://127.0.0.1:${port}/api/system/notify-shutdown`, {
      method: "POST",
      headers: { authorization: "Bearer test-maintenance-token" },
    });
    expect(shutdownRes.status).toBe(200);
    const shutdownBody = await shutdownRes.json();
    expect(shutdownBody).toEqual({
      ok: true,
      message: "停机通知已向所有房间广播",
    });

    // 验证停机回调已触发执行
    expect(shutdownTriggered).toBe(true);

    // 验证 WebSocket 收到停机广播
    const shutdownEvent = (await collector(
      (payload) =>
        (payload as { type?: string }).type === "event" &&
        (payload as { event?: string }).event === "server.shutdown"
    )) as { type: string; event: string; payload: { message: string } };
    expect(shutdownEvent.type).toBe("event");
    expect(shutdownEvent.event).toBe("server.shutdown");
    expect(shutdownEvent.payload.message).toBe(SERVER_SHUTDOWN_MESSAGE);

    // 验证 readyz 探针立即转为 503
    const readyAfterShutdown = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(readyAfterShutdown.status).toBe(503);
    expect(await readyAfterShutdown.json()).toEqual({
      status: "shutting_down",
      ready: false,
    });

    socket.close();
  } finally {
    await stop();
  }
});

test("WebSocket 幂等重传在执行中到达时等待并回放相同响应包", async () => {
  const { port, stop } = startTestServer();

  try {
    const socket = await openSocket(port);
    const messages: Array<{ type?: string; id?: string }> = [];
    socket.onmessage = (event) => {
      messages.push(JSON.parse(event.data as string));
    };

    const req = {
      id: "req-dedup-concurrency",
      type: "lobby.subscribeRooms",
      payload: {},
    };

    // 连续并发发送两个完全相同的帧，模拟网络重传
    socket.send(JSON.stringify(req));
    socket.send(JSON.stringify(req));

    // 等待两次回应
    const start = Date.now();
    while (
      messages.filter((m) => m.id === "req-dedup-concurrency").length < 2 &&
      Date.now() - start < 3000
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const acks = messages.filter((m) => m.type === "ack" && m.id === "req-dedup-concurrency");
    // 两个请求都必须收到 ACK，第二个重传帧不得被静默丢弃
    expect(acks).toHaveLength(2);
    expect(acks[0]).toEqual(acks[1]);

    socket.close();
  } finally {
    await stop();
  }
});

/**
 * 跨站 WebSocket 劫持（CSWSH）防护的回归用例。
 *
 * WebSocket **不受浏览器同源策略约束**，服务端的 Origin 白名单是唯一防线。
 * 这里曾经写成 `return { status: 403 }`，而 Elysia `.ws()` 的 `upgrade` 钩子
 * **忽略返回值**（1.4.29 与 1.4.30 实测：任意 Origin 照样 101 完成握手），
 * 整道防线形同虚设却无人发现——因为当时没有任何用例覆盖它。现在改为 throw，
 * 并用下面这条钉死：改回 return 会立刻失败。
 */
const upgradeStatusLine = (port: number, origin?: string) =>
  new Promise<string>((resolve) => {
    const lines = [
      "GET /api/whoisfaker/ws HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
    ];
    if (origin) lines.push(`Origin: ${origin}`);
    lines.push("", "");
    let buffer = "";
    let done = false;
    const socket = connect({ host: "127.0.0.1", port }, () => socket.write(lines.join("\r\n")));
    const timer = setTimeout(() => finish("TIMEOUT"), 3000);
    const finish = (value: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("\r\n\r\n")) finish(buffer.split("\r\n")[0]);
    });
    socket.on("error", (error) => finish(`ERR ${error.message}`));
  });

test("WebSocket 升级按 Origin 白名单拦截（防跨站 WebSocket 劫持）", async () => {
  const { port, stop } = startTestServer();

  try {
    // 白名单内的来源正常完成握手
    const allowed = await upgradeStatusLine(port, "http://localhost:5173");
    expect(allowed).toContain("101");

    // 任意第三方站点必须被拒绝
    const hostile = await upgradeStatusLine(port, "https://evil.example");
    expect(hostile).toContain("403");

    // 不带 Origin 的是非浏览器来源（本地工具 / 内部调用），按现有策略放行
    const missing = await upgradeStatusLine(port);
    expect(missing).toContain("101");
  } finally {
    await stop();
  }
});

/**
 * 停机窗口内的新握手必须被直接拒绝。
 *
 * `/readyz` 回 503 只让边缘停止分配新流量，进程内的升级照样会完成 101：排空窗口因此永远
 * 等不到「没有新连接」的那一刻，刚进来的玩家会被 `app.stop(true)` 硬切断。
 * 闸门判在 Origin 白名单与握手配额之前，所以拒绝既不占配额桶，也不给来源探测留可分辨的差异。
 */
test("停机中拒绝新的 WebSocket 升级，未停机时同一入口照常放行", async () => {
  const closing = startTestServer({ isShuttingDown: () => true });
  const normal = startTestServer();

  try {
    const rejected = await upgradeStatusLine(closing.port, "http://localhost:5173");
    expect(rejected).toContain("503");

    // 闸门只认停机标志：白名单内的来源在正常态必须仍然拿到 101，否则就是把正常流量锁死了
    const allowed = await upgradeStatusLine(normal.port, "http://localhost:5173");
    expect(allowed).toContain("101");
  } finally {
    await closing.stop();
    await normal.stop();
  }
});

for (const [game, command] of [
  ["whoisfaker", "lobby.subscribeRooms"],
  ["songuessr", "song.lobby.subscribeRooms"],
  ["cee", "cee.lobby.subscribeRooms"],
] as const) {
  test(`${game} 原生 WS schema 保持二进制/空白 JSON、关联错误与严格字段契约`, async () => {
    const { port, stop } = startTestServer();
    const socket = await openSocket(port, game);
    const collect = createSocketCollector(socket);
    const getPacket = (id: string) =>
      collect((packet) => (packet as { id?: string }).id === id) as Promise<{
        type: string;
        traceId?: string;
        error?: { code: string };
      }>;
    try {
      for (const [id, frame] of [
        ["native-text", "text"],
        ["native-binary", "binary"],
      ] as const) {
        const message = JSON.stringify({
          id,
          type: command,
          traceId: "native-trace",
          payload: {},
          ...(game === "cee" ? { roomId: null, sessionToken: null } : {}),
        });
        socket.send(frame === "text" ? ` \n${message}\n ` : new TextEncoder().encode(message));
        expect(await getPacket(id)).toMatchObject({ type: "ack", traceId: "native-trace" });
      }
      for (const [id, patch, code] of [
        ["native-invalid", { payload: { unauthorizedField: true } }, "INVALID_MESSAGE"],
        ["native-prototype", { type: "constructor" }, "UNKNOWN_MESSAGE_TYPE"],
        ["native-unknown", { type: "not.a.command" }, "UNKNOWN_MESSAGE_TYPE"],
        ["native-extra", { extraEnvelopeField: true }, "INVALID_MESSAGE"],
      ] as const) {
        socket.send(
          JSON.stringify(
            Object.assign({ id, type: command, traceId: "error-trace", payload: {} }, patch)
          )
        );
        expect(await getPacket(id)).toMatchObject({
          type: "error",
          traceId: "error-trace",
          error: { code },
        });
      }
      socket.send("{broken json");
      const raw = await getPacket("unknown");
      expect(raw).toMatchObject({ type: "error", error: { code: "INVALID_MESSAGE" } });
    } finally {
      socket.close();
      await stop();
    }
  });
}

test("关闭文档页时 /openapi 落到 404 信封，不再向公网公开整张路由表", async () => {
  const env: AppEnv = {
    clientUrl: "http://localhost:5173",
    serverUrl: "http://127.0.0.1",
    serverListenHost: "127.0.0.1",
    serverPort: 0,
    bangumiApiUrl: "https://api.bgm.tv",
    bangumiImageUrl: "",
  };
  const logger = new EventLogger();
  const build = (openapiEnabled?: boolean) =>
    createApp({
      env: { ...env, openapiEnabled },
      logger,
      whoIsFakerService: new WhoIsFakerService({ eventLogger: logger }),
    }).app;
  const closed = await build(false).handle(new Request("http://localhost/openapi/json"));
  expect(closed.status).toBe(404);
  expect(((await closed.json()) as { error?: { code?: string } }).error?.code).toBe("NOT_FOUND");
  // 缺省仍挂着：离线契约导出（ExportOpenapi）与本地开发都依赖它。
  expect((await build(undefined).handle(new Request("http://localhost/openapi/json"))).status).toBe(
    200
  );
});

/**
 * F07：HTTP 操作名（指标序列与 Sentry 事务名共用）必须取自**已注册路由模板**，
 * 不能拼未约束的 inbound pathname——扫描器的随机路径会把基数推到无界。
 * 模板匹配的边界（`:param`、`*`、非标方法）在纯函数上直接钉死。
 */
test("HTTP 操作名归一到路由模板，未命中落固定桶", () => {
  const templates = compileRouteTemplates([
    { method: "GET", path: "/health" },
    { method: "GET", path: "/api/account/avatar/:userId" },
    { method: "ALL", path: "/api/auth/*" },
    { method: "WS", path: "/api/cee/ws" },
  ]);
  expect(httpOperationAction(templates, "GET", "/health")).toBe("HTTP GET /health");
  expect(httpOperationAction(templates, "GET", "/api/account/avatar/u-123")).toBe(
    "HTTP GET /api/account/avatar/:userId"
  );
  expect(httpOperationAction(templates, "POST", "/api/auth/sign-in/email")).toBe(
    "HTTP POST /api/auth/*"
  );
  expect(httpOperationAction(templates, "GET", "/api/cee/ws")).toBe("HTTP GET /api/cee/ws");
  // 参数段必须整段消费；多余段、缺失段与非标准方法一律进固定桶。
  expect(httpOperationAction(templates, "GET", "/api/account/avatar")).toBe(UNROUTED_HTTP_ACTION);
  expect(httpOperationAction(templates, "GET", "/health/extra")).toBe(UNROUTED_HTTP_ACTION);
  expect(httpOperationAction(templates, "FOO", "/health")).toBe(UNROUTED_HTTP_ACTION);
});

test("未注册路径的 HTTP 操作日志只落固定桶，已注册路由仍拿到具体模板名", async () => {
  // onAfterResponse 只在真实监听下触发（app.handle 不走该生命周期），必须经 server 验证。
  const logger = new EventLogger(() => undefined);
  const actions = spyOn(logger, "logOperation").mockImplementation(() => undefined);
  const { port, stop } = startTestServer({ logger });

  try {
    const scanned = [
      "/wp-login.php",
      "/.env",
      `/probe/${crypto.randomUUID()}/deep`,
      `/api/whoisfaker/${crypto.randomUUID()}`,
    ];
    const paths = [
      ...scanned,
      "/health",
      `/api/account/avatar/${crypto.randomUUID()}`,
      "/api/auth/login",
    ];
    for (const path of paths) {
      await fetch(`http://127.0.0.1:${port}${path}`, {
        method: path === "/api/auth/login" ? "POST" : "GET",
      });
    }
    // afterResponse 在响应发送后才排队执行：等到 HTTP 操作数与请求数一致再断言。
    const httpActionsOf = () =>
      actions.mock.calls
        .map((call) => call[0].action)
        .filter((action) => action.startsWith("HTTP"));
    for (let attempt = 0; attempt < 40 && httpActionsOf().length < paths.length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const httpActions = httpActionsOf();
    expect(httpActions).toHaveLength(paths.length);
    // 随机路径不出现在任何操作名里：指标序列与事务名的基数只落在固定集合。
    expect(httpActions.join("\n")).not.toContain("wp-login");
    expect(httpActions.join("\n")).not.toContain("probe");
    expect(new Set(httpActions)).toEqual(
      new Set([
        UNROUTED_HTTP_ACTION,
        "HTTP GET /health",
        "HTTP GET /api/account/avatar/:userId",
        "HTTP POST /api/auth/*",
      ])
    );
  } finally {
    await stop();
  }
});

test("Agent 握手标记受 MCP_ENABLED 控制，未声明时不标记", () => {
  const agentContext: { request: Request; isAgent?: boolean } = {
    request: new Request("http://localhost/api/whoisfaker/ws?agent=1"),
  };
  expect(() => resolveAgentIdentity(agentContext, false)).toThrow("Agent 接入未启用");

  resolveAgentIdentity(agentContext, true);
  expect(agentContext.isAgent).toBe(true);

  const humanContext: { request: Request; isAgent?: boolean } = {
    request: new Request("http://localhost/api/whoisfaker/ws"),
  };
  resolveAgentIdentity(humanContext, true);
  expect(humanContext.isAgent).toBeUndefined();
});
