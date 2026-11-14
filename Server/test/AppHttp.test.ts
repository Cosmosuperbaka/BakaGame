import { expect, spyOn, test } from "bun:test";

import { WhoIsFakerService } from "../src/application/WhoIsFakerService";
import { HTTP_MAX_REQUEST_BODY_BYTES } from "../src/config/Constants";
import type { AppEnv } from "../src/config/Env";
import { ClientChannel, InMemoryClientChannelStore } from "../src/infrastructure/ClientChannel";
import { EventLogger } from "../src/infrastructure/EventLogger";
import type { OtelLogRecord } from "../src/infrastructure/logging/OtelLog";
import { UNROUTED_HTTP_ACTION } from "../src/transport/HttpOperation";
import { createTestApp as createApp } from "./AppFixtures";
import { createSocketCollector, openSocket, startTestServer } from "./support/AppServer";
import { until } from "./support/Until";

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
    games: { faker: whoIsFakerService },
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
    games: { faker: new WhoIsFakerService({ eventLogger: logger }) },
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
    const customTraceId = "5d2f6c1e-7a3b-4c9d-8e0f-1a2b3c4d5e6f";
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
      games: { faker: new WhoIsFakerService({ eventLogger: logger }) },
    }).app;
  const closed = await build(false).handle(new Request("http://localhost/openapi/json"));
  expect(closed.status).toBe(404);
  expect(((await closed.json()) as { error?: { code?: string } }).error?.code).toBe("NOT_FOUND");
  // 缺省仍挂着：离线契约导出（ExportOpenapi）与本地开发都依赖它。
  expect((await build(undefined).handle(new Request("http://localhost/openapi/json"))).status).toBe(
    200
  );
});
test("客户端完整性拒绝只产生一条告警级日志，4xx 与扫描探测不产生告警", async () => {
  const records: OtelLogRecord[] = [];
  const logger = new EventLogger(() => undefined, undefined, undefined, "DEBUG", {
    sinks: [{ write: (record) => records.push(record) }],
  });
  const clientChannel = new ClientChannel({
    store: new InMemoryClientChannelStore(),
    minimumVersion: () => "",
    onWarn: (message, detail) => logger.warn(message, detail),
  });
  const { port, stop } = startTestServer({ logger, clientChannel });
  try {
    // 自检硬失败：注册接口拒绝并抛出 CLIENT_UNTRUSTED（调用方的错，4xx）。
    const registered = await fetch(`http://127.0.0.1:${port}/api/client/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientType: "desktop",
        platform: "windows",
        clientVersion: "1.0.0",
        keyAlgorithm: "ed25519",
        publicKey: "A".repeat(43),
        selfCheck: { hardFail: ["debugger_attached"], softFail: [], keyProtection: "hardware" },
      }),
    });
    expect(registered.status).toBeGreaterThanOrEqual(400);
    expect(registered.status).toBeLessThan(500);
    await fetch(`http://127.0.0.1:${port}/wp-login.php`);
    // afterResponse 在响应发送后才排队执行：等两条请求的操作日志都落下再断言。
    const operations = () =>
      records.filter((record) => record.attributes["log.kind"] === "operation");
    await until("两条请求的操作日志没有落下", () => operations().length >= 2, {
      timeoutMs: 1_000,
      intervalMs: 25,
    });
    expect(operations()).toHaveLength(2);

    const warnings = records.filter((record) => record.severityText === "WARN");
    expect(warnings.map((record) => record.body)).toEqual(["客户端完整性校验未通过"]);
    // 扫描探测降为 debug，既不告警也不进信息级。
    const scan = operations().find((record) =>
      String(record.attributes["operation.action"]).includes("UNROUTED")
    );
    expect(scan?.severityText).toBe("DEBUG");
  } finally {
    await stop();
  }
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
    await until("HTTP 操作数没有与请求数对齐", () => httpActionsOf().length >= paths.length, {
      timeoutMs: 1_000,
      intervalMs: 25,
    });
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
