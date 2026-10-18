import { expect, test } from "bun:test";

import { WhoIsFakerService } from "../src/application/WhoIsFakerService";
import type { AppEnv } from "../src/config/Env";
import type { CEEService } from "../src/application/CEEService";
import type { SonGuessrService } from "../src/application/SonGuessrService";
import { EventLogger } from "../src/infrastructure/EventLogger";
import { TelemetryRateLimiter, systemRoutes } from "../src/transport/routes/System";
import { createTestApp } from "./AppFixtures";

const env = {
  clientUrl: "http://localhost:5173",
  serverUrl: "http://localhost:4850",
  serverListenHost: "127.0.0.1",
  serverPort: 0,
  bangumiApiUrl: "https://api.bgm.tv",
  bangumiImageUrl: "",
} satisfies AppEnv;

const silentLogger = new EventLogger(() => {});

const appUnderTest = () =>
  createTestApp({
    env,
    logger: silentLogger,
    whoIsFakerService: new WhoIsFakerService({ eventLogger: silentLogger }),
  }).app;

test("HTTP 出口统一带安全响应头，明文直连不回 HSTS", async () => {
  const app = appUnderTest();
  const res = await app.handle(new Request("http://localhost/livez"));
  expect(res.status).toBe(200);
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(res.headers.get("permissions-policy")).toContain("camera=()");
  // 本机与容器内是明文 HTTP，TLS 由边缘终结：明文连接发 HSTS 浏览器会忽略，写死反而给未来的内部域名埋雷。
  expect(res.headers.get("strict-transport-security")).toBeNull();

  const viaTls = await app.handle(
    new Request("http://localhost/livez", { headers: { "x-forwarded-proto": "https" } })
  );
  expect(viaTls.headers.get("strict-transport-security")).toContain("max-age=31536000");
});

test("文档页只放宽 CSP，其余收紧项照旧", async () => {
  const app = appUnderTest();
  const res = await app.handle(new Request("http://localhost/openapi"));
  expect(res.status).toBe(200);
  // Swagger UI 要跑内联脚本与外部资源，`default-src 'none'` 会把页面打死。
  expect(res.headers.get("content-security-policy")).not.toContain("default-src");
  expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
});

const healthApp = (input: {
  counts: { roomCount: number; connectionCount: number; onlinePlayerCount: number };
  maintenanceToken?: string;
  probeRateLimiter?: TelemetryRateLimiter;
}) =>
  systemRoutes({
    whoIsFakerService: { getHealthSnapshot: () => input.counts } as unknown as WhoIsFakerService,
    sonGuessrService: {
      getHealthSnapshot: () => ({ roomCount: 0, connectionCount: 0, onlinePlayerCount: 0 }),
    } as unknown as SonGuessrService,
    ceeService: {
      getHealthSnapshot: () => ({ roomCount: 0, connectionCount: 0, onlinePlayerCount: 0 }),
    } as unknown as CEEService,
    logger: silentLogger,
    maintenanceToken: input.maintenanceToken,
    probeRateLimiter: input.probeRateLimiter,
  });

test("/health 匿名只给一位有效数字的量级，维护凭据才拿精确值", async () => {
  const app = healthApp({
    counts: { roomCount: 1234, connectionCount: 456, onlinePlayerCount: 87 },
    maintenanceToken: "tok",
  });

  const anon = await app.handle(
    new Request("http://localhost/health", { headers: { "x-real-ip": "203.0.113.20" } })
  );
  expect(anon.status).toBe(200);
  expect(await anon.json()).toEqual({
    status: "ok",
    roomCount: 1000,
    connectionCount: 500,
    onlinePlayerCount: 90,
  });

  const ops = await app.handle(
    new Request("http://localhost/health", {
      headers: { "x-real-ip": "203.0.113.21", authorization: "Bearer tok" },
    })
  );
  expect(await ops.json()).toEqual({
    status: "ok",
    roomCount: 1234,
    connectionCount: 456,
    onlinePlayerCount: 87,
  });
});

test("/health 按来源地址限流，超额回 429 与退避头（livez 与 readyz 不受额度影响）", async () => {
  const app = healthApp({
    counts: { roomCount: 1, connectionCount: 1, onlinePlayerCount: 1 },
    probeRateLimiter: new TelemetryRateLimiter({ windowMs: 60_000, ipMaxRequests: 2 }),
  });
  // 桶键只采信边缘写入的 `x-real-ip`：`X-Forwarded-For` 客户端可任意伪造，拿它当键等于让扫描者自造新桶。
  const headers = { "x-real-ip": "203.0.113.22" };

  for (let i = 0; i < 2; i += 1) {
    expect((await app.handle(new Request("http://localhost/health", { headers }))).status).toBe(
      200
    );
  }
  const limited = await app.handle(new Request("http://localhost/health", { headers }));
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).not.toBeNull();
  expect(limited.headers.get("x-ratelimit-remaining")).toBe("0");
  expect(((await limited.json()) as { error?: { code?: string } }).error?.code).toBe(
    "RATE_LIMITED"
  );

  // 另一个来源地址不受影响，探针本身也不能被一个扫描者挡死。
  expect(
    (
      await app.handle(
        new Request("http://localhost/health", { headers: { "x-real-ip": "203.0.113.23" } })
      )
    ).status
  ).toBe(200);
  // 存活与就绪是负载均衡的契约：不设额度，否则扫爆全局额度就会让 LB 误判摘流。
  expect((await app.handle(new Request("http://localhost/livez", { headers }))).status).toBe(200);
  expect((await app.handle(new Request("http://localhost/readyz", { headers }))).status).toBe(200);
});
