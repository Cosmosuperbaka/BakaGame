import { expect, spyOn, test } from "bun:test";

import { WhoIsFakerService } from "../src/application/WhoIsFakerService";
import type { AppEnv } from "../src/config/Env";
import { EventLogger } from "../src/infrastructure/EventLogger";
import { UNROUTED_HTTP_ACTION } from "../src/transport/HttpOperation";
import { createTestApp } from "./AppFixtures";

/**
 * 全局中间件（追踪号、安全头、跨域、错误信封、响应头补齐、操作日志）对每一类路由都要生效。
 * 框架的插件内钩子默认只作用于插件自身：中间件挪进插件后，作用域写错会让它悄悄对一部分路由失效，
 * 单看某一条路由的用例发现不了，所以这里按「路由类别 × 中间件」逐格断言。
 */

const env: AppEnv = {
  clientUrl: "http://localhost:5173",
  serverUrl: "http://127.0.0.1",
  serverListenHost: "127.0.0.1",
  serverPort: 0,
  bangumiApiUrl: "https://api.bgm.tv",
  bangumiImageUrl: "",
};

const ALLOWED_ORIGIN = "http://localhost:5173";
const WS_PATHS = [
  "/api/ws",
  "/api/whoisfaker/ws",
  "/api/songuessr/ws",
  "/api/cee/ws",
  "/api/status/ws",
] as const;

const startServer = (options: { isShuttingDown?: () => boolean; logger?: EventLogger } = {}) => {
  const logger = options.logger ?? new EventLogger(() => undefined);
  const { app } = createTestApp({
    env,
    logger,
    isShuttingDown: options.isShuttingDown,
    games: { faker: new WhoIsFakerService({ eventLogger: logger }) },
  });
  const started = app.listen({ hostname: "127.0.0.1", port: 0 });
  const port = started.server?.port;
  if (!port) throw new Error("未能获取测试端口");
  return {
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    stop: () => started.stop(true),
  };
};

const UPGRADE_HEADERS = {
  upgrade: "websocket",
  connection: "Upgrade",
  "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  "sec-websocket-version": "13",
};

type ErrorEnvelope = { error: { code: string; message: string; traceId: string } };

/** 每个响应都必须带的：追踪号头、安全头、暴露给浏览器的头清单。 */
const expectGlobalHeaders = (response: Response, label: string) => {
  expect(response.headers.get("x-trace-id"), `${label} 追踪号`).toBeTruthy();
  expect(response.headers.get("x-content-type-options"), `${label} nosniff`).toBe("nosniff");
  expect(response.headers.get("x-frame-options"), `${label} frame`).toBe("DENY");
  expect(response.headers.get("referrer-policy"), `${label} referrer`).toBe("no-referrer");
  expect(response.headers.get("content-security-policy"), `${label} csp`).toContain(
    "frame-ancestors 'none'"
  );
  expect(response.headers.get("access-control-expose-headers"), `${label} 跨域暴露头`).toContain(
    "x-trace-id"
  );
};

const expectEnvelope = async (response: Response, status: number, code: string, label: string) => {
  expect(response.status, `${label} 状态`).toBe(status);
  const body = (await response.json()) as ErrorEnvelope;
  expect(Object.keys(body), `${label} 信封只有 error`).toEqual(["error"]);
  expect(Object.keys(body.error).sort(), `${label} 信封字段`).toEqual([
    "code",
    "message",
    "traceId",
  ]);
  expect(body.error.code, `${label} 错误码`).toBe(code);
  expect(body.error.traceId, `${label} 信封追踪号与响应头一致`).toBe(
    response.headers.get("x-trace-id")!
  );
};

test("普通 HTTP 路由：追踪号透传、安全头、跨域头齐全", async () => {
  const server = startServer();
  try {
    const response = await fetch(server.url("/livez"), {
      headers: { origin: ALLOWED_ORIGIN, "x-trace-id": "5d2f6c1e-7a3b-4c9d-8e0f-1a2b3c4d5e01" },
    });
    expect(response.status).toBe(200);
    expectGlobalHeaders(response, "livez");
    expect(response.headers.get("x-trace-id")).toBe("5d2f6c1e-7a3b-4c9d-8e0f-1a2b3c4d5e01");
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
  } finally {
    await server.stop();
  }
});

test("RPC 路由：第三方 handler 自建的响应也被补上追踪号与安全头", async () => {
  const server = startServer();
  try {
    const response = await fetch(server.url("/api/rpc/account/me"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-trace-id": "5d2f6c1e-7a3b-4c9d-8e0f-1a2b3c4d5e02",
      },
      body: "{}",
    });
    // 未配置账号系统：路由自己回 503，响应不经过 set.headers，靠全局补头才带得上追踪号。
    expect(response.status).toBe(503);
    expectGlobalHeaders(response, "rpc");
    expect(response.headers.get("x-trace-id")).toBe("5d2f6c1e-7a3b-4c9d-8e0f-1a2b3c4d5e02");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  } finally {
    await server.stop();
  }
});

test("404：未注册路径落统一错误信封，追踪号与安全头仍在", async () => {
  const server = startServer();
  try {
    const response = await fetch(server.url("/no-such-route"), {
      headers: { origin: ALLOWED_ORIGIN },
    });
    expectGlobalHeaders(response, "404");
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    await expectEnvelope(response, 404, "NOT_FOUND", "404");
  } finally {
    await server.stop();
  }
});

test("路由自己抛业务错误与回错误体：信封形状与追踪号一致", async () => {
  const server = startServer();
  try {
    // 站内播放跳转：房间不在时路由自己回 404 信封并关闭缓存，全局头照样补上。
    const audio = await fetch(server.url("/api/songuessr/audio/1234/ticket"), {
      redirect: "manual",
    });
    expectGlobalHeaders(audio, "audio-404");
    expect(audio.headers.get("cache-control")).toBe("no-store");
    await expectEnvelope(audio, 404, "AUDIO_NOT_FOUND", "audio-404");
  } finally {
    await server.stop();
  }
});

test("被限流的请求：429 信封、限流头、重试头与全局头同时在", async () => {
  const server = startServer();
  try {
    let last: Response | undefined;
    // 站内播放跳转的单来源额度是每窗口 240 次：打满后第一次被拒。
    for (let attempt = 0; attempt < 250; attempt += 1) {
      last = await fetch(server.url("/api/songuessr/audio/1234/ticket"), { redirect: "manual" });
      if (last.status === 429) break;
      await last.arrayBuffer();
    }
    expect(last?.status).toBe(429);
    const limited = last!;
    expectGlobalHeaders(limited, "429");
    expect(limited.headers.get("x-ratelimit-limit")).toBe("240");
    expect(limited.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(limited.headers.get("cache-control")).toBe("no-store");
    await expectEnvelope(limited, 429, "RATE_LIMITED", "429");
  } finally {
    await server.stop();
  }
});

for (const path of WS_PATHS) {
  test(`实时升级请求 ${path}：来源被拒与握手头不合法的回包带全局头与信封`, async () => {
    const server = startServer();
    try {
      const hostile = await fetch(server.url(path), {
        headers: {
          ...UPGRADE_HEADERS,
          origin: "https://evil.example",
          "x-trace-id": "5d2f6c1e-7a3b-4c9d-8e0f-1a2b3c4d5e03",
        },
      });
      expectGlobalHeaders(hostile, `${path} 来源被拒`);
      expect(hostile.headers.get("x-trace-id")).toBe("5d2f6c1e-7a3b-4c9d-8e0f-1a2b3c4d5e03");
      await expectEnvelope(hostile, 403, "FORBIDDEN_ORIGIN", `${path} 来源被拒`);

      const malformed = await fetch(server.url(path), {
        headers: { upgrade: "websocket", connection: "Upgrade", origin: ALLOWED_ORIGIN },
      });
      expectGlobalHeaders(malformed, `${path} 握手头不合法`);
      await expectEnvelope(malformed, 400, "INVALID_HANDSHAKE", `${path} 握手头不合法`);
    } finally {
      await server.stop();
    }
  });

  test(`实时升级请求 ${path}：停机中回 503 信封，同样带全局头`, async () => {
    const server = startServer({ isShuttingDown: () => true });
    try {
      const response = await fetch(server.url(path), {
        headers: { ...UPGRADE_HEADERS, origin: ALLOWED_ORIGIN },
      });
      expectGlobalHeaders(response, `${path} 停机`);
      expect(response.status).toBe(503);
    } finally {
      await server.stop();
    }
  });
}

test("预检请求：跨域插件对每一类路由都应答", async () => {
  const server = startServer();
  try {
    for (const path of [
      "/livez",
      "/api/rpc/account/me",
      "/api/songuessr/audio/1234/ticket",
      "/no-such-route",
    ]) {
      const response = await fetch(server.url(path), {
        method: "OPTIONS",
        headers: { origin: ALLOWED_ORIGIN, "access-control-request-method": "GET" },
      });
      expect(response.headers.get("access-control-allow-origin"), path).toBe(ALLOWED_ORIGIN);
    }
  } finally {
    await server.stop();
  }
});

test("操作日志：每一类 HTTP 路由都记一条，未注册路径落固定桶", async () => {
  // onAfterResponse 只在真实监听下触发，必须经 server 验证。
  const logger = new EventLogger(() => undefined);
  const operations = spyOn(logger, "logOperation").mockImplementation(() => undefined);
  const server = startServer({ logger });
  try {
    const cases: Array<[string, RequestInit | undefined, string, number]> = [
      ["/livez", undefined, "HTTP GET /livez", 200],
      ["/api/rpc/account/me", { method: "POST", body: "{}" }, "HTTP POST /api/rpc/*", 503],
      [
        "/api/songuessr/audio/1234/ticket",
        { redirect: "manual" },
        "HTTP GET /api/songuessr/audio/:roomId/:ticket",
        404,
      ],
      ["/no-such-route", undefined, UNROUTED_HTTP_ACTION, 404],
    ];
    for (const [path, init] of cases) await (await fetch(server.url(path), init)).arrayBuffer();
    for (let attempt = 0; attempt < 40 && operations.mock.calls.length < cases.length; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 25));
    const recorded = operations.mock.calls.map(([entry]) => `${entry.action} ${entry.status}`);
    for (const [, , action, status] of cases) expect(recorded).toContain(`${action} ${status}`);
    for (const [entry] of operations.mock.calls) {
      expect(entry.traceId).toBeTruthy();
      expect(entry.identifier).toBeTruthy();
      expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    }
  } finally {
    await server.stop();
  }
});
