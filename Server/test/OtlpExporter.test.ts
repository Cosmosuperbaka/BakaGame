import { expect, test } from "bun:test";
import { OtlpExporter, toUnixNanoString, type OtlpFetcher } from "../src/infrastructure/OtlpExporter";
import { EventLogger } from "../src/infrastructure/EventLogger";
import { createApp } from "../src/transport/App";
import { RoomService } from "../src/application/RoomService";
import { WordBankRepository } from "../src/infrastructure/WordBankRepository";
import type { AppEnv } from "../src/config/Env";

test("OtlpExporter 未配置 endpoint 时处于静默禁用状态", async () => {
  const exporter = new OtlpExporter();
  expect(exporter.isEnabled).toBe(false);

  // enqueue 不抛出错误
  exporter.enqueue({
    timestamp: Date.now(),
    level: "INFO",
    message: "测试消息",
  });
  await exporter.flush();
  await exporter.shutdown();
});

test("OtlpExporter 正确封装 OTLP JSON 并批量导出至观测网关", async () => {
  let capturedBody: unknown = null;
  let capturedHeaders: Record<string, string> = {};

  // 使用 Bun 原生微服务模拟 Grafana Cloud OTLP 网关
  const mockGateway = Bun.serve({
    port: 0,
    fetch(req) {
      capturedHeaders = {
        authorization: req.headers.get("authorization") ?? "",
        "content-type": req.headers.get("content-type") ?? "",
      };
      return req.json().then((json) => {
        capturedBody = json;
        return new Response(JSON.stringify({ partialSuccess: {} }), { status: 200 });
      });
    },
  });

  const endpoint = `http://127.0.0.1:${mockGateway.port}/otlp/v1/logs`;
  const exporter = new OtlpExporter({
    endpoint,
    headers: {
      Authorization: "Basic dGVzdC11c2VyOnRlc3QtcGFzc3dvcmQ=",
    },
    serviceName: "test-game-server",
  });

  expect(exporter.isEnabled).toBe(true);

  const timestamp = 1700000000000;
  exporter.enqueue({
    timestamp,
    level: "ERROR",
    message: "房间处理异常",
    traceId: "test-trace-123",
    attributes: {
      roomId: "room-abc",
    },
  });

  await exporter.flush();
  await exporter.shutdown();
  mockGateway.stop(true);

  expect(capturedHeaders.authorization).toBe("Basic dGVzdC11c2VyOnRlc3QtcGFzc3dvcmQ=");
  expect(capturedHeaders["content-type"]).toBe("application/json");

  const body = capturedBody as {
    resourceLogs: Array<{
      resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
      scopeLogs: Array<{
        logRecords: Array<{
          timeUnixNano: string;
          severityText: string;
          severityNumber: number;
          body: { stringValue: string };
          attributes: Array<{ key: string; value: { stringValue: string } }>;
        }>;
      }>;
    }>;
  };

  expect(body.resourceLogs[0].resource.attributes[0].value.stringValue).toBe("test-game-server");
  const record = body.resourceLogs[0].scopeLogs[0].logRecords[0];
  expect(record.severityText).toBe("ERROR");
  expect(record.severityNumber).toBe(17);
  expect(record.body.stringValue).toBe("房间处理异常");
  expect(record.timeUnixNano).toBe(String(BigInt(timestamp) * 1_000_000n));

  const attrMap = Object.fromEntries(record.attributes.map((a) => [a.key, a.value.stringValue]));
  expect(attrMap.trace_id).toBe("test-trace-123");
  expect(attrMap.roomId).toBe("room-abc");
});

test("POST /api/monitoring/telemetry 接收前端打点，完成脱敏并记录至日志体系", async () => {
  const loggedLines: string[] = [];
  const logger = new EventLogger((line) => loggedLines.push(line));

  const env: AppEnv = {
    clientUrl: "http://localhost:5173",
    serverUrl: "http://127.0.0.1",
    serverListenHost: "127.0.0.1",
    serverPort: 4899,
    wordBankPath: ":memory:",
  };

  const roomService = new RoomService({
    wordBankRepository: new WordBankRepository(":memory:"),
    eventLogger: logger,
  });

  const { app } = createApp({
    env,
    whoIsFakerService: roomService,
    logger,
  });

  const res = await app.handle(
    new Request("http://localhost/api/monitoring/telemetry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-trace-id": "client-trace-999",
      },
      body: JSON.stringify({
        level: "error",
        message: "前端音频加载超时",
        metadata: {
          audioUrl: "https://music.163.com/song.mp3",
          cookie: "MUSIC_U=secret1234567890",
          password: "plain-user-password",
        },
      }),
    }),
  );

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });

  const clientLog = loggedLines.find((l) => l.includes("[CLIENT] 前端音频加载超时"));
  expect(clientLog).toBeTruthy();
  expect(clientLog).toContain("client-trace-999");
  expect(clientLog).toContain("***[REDACTED]");
  expect(clientLog).not.toContain("plain-user-password");
});

test("OtlpExporter 缓冲队列达到 500 条上限时自动丢弃最旧日志", async () => {
  const exporter = new OtlpExporter({
    endpoint: "http://127.0.0.1:9999/v1/logs",
  });

  for (let i = 0; i < 550; i++) {
    exporter.enqueue({
      timestamp: 1700000000000 + i,
      level: "INFO",
      message: `日志条目 ${i}`,
    });
  }

  const buffer = exporter.buffer as unknown[];
  expect(buffer.length).toBeLessThanOrEqual(500);
});

test("CORS 支持 POST 预检与 x-trace-id 头，并放行局域网私网 IP", async () => {
  const env: AppEnv = {
    clientUrl: "http://localhost:5173",
    serverUrl: "http://127.0.0.1:4850",
    serverListenHost: "127.0.0.1",
    serverPort: 4850,
    wordBankPath: ":memory:",
  };
  const { app } = createApp({
    env,
    whoIsFakerService: new RoomService({
      eventLogger: new EventLogger(),
      wordBankRepository: new WordBankRepository(":memory:"),
    }),
    logger: new EventLogger(),
  });

  // 1. 跨域预检 POST 请求与自定义 x-trace-id
  const preflightRes = await app.handle(
    new Request("http://localhost/api/monitoring/telemetry", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type, x-trace-id",
      },
    }),
  );
  expect(preflightRes.headers.get("access-control-allow-methods")).toContain("POST");
  expect(preflightRes.headers.get("access-control-allow-headers")).toContain("x-trace-id");

  // 2. 局域网私有网段（192.168.x.x）跨端访问放行
  const lanRes = await app.handle(
    new Request("http://localhost/api/monitoring/telemetry", {
      method: "OPTIONS",
      headers: {
        Origin: "http://192.168.1.100:5173",
        "Access-Control-Request-Method": "POST",
      },
    }),
  );
  expect(lanRes.headers.get("access-control-allow-origin")).toBe("http://192.168.1.100:5173");
});

test("OtlpExporter 正确将 Traces (Spans) 发送至 /v1/traces 并携带三元组 Resource", async () => {
  let capturedTraceBody: unknown = null;
  const mockTraceGateway = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.url.includes("/v1/traces")) {
        capturedTraceBody = await req.json();
        return new Response(JSON.stringify({ partialSuccess: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    },
  });

  const exporter = new OtlpExporter({
    endpoint: `http://127.0.0.1:${mockTraceGateway.port}/otlp`,
    headers: { Authorization: "Basic dGVzdA==" },
    serviceName: "Bakagame-Server",
    serviceNamespace: "Bakagame",
    deploymentEnvironment: "production",
  });

  exporter.enqueueSpan({
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    name: "server.startup",
    startTime: 1700000000000,
    endTime: 1700000000050,
    status: "OK",
    attributes: { "server.status": "ready" },
  });

  await exporter.flushSpans();
  await exporter.shutdown();
  mockTraceGateway.stop(true);

  expect(capturedTraceBody).toBeTruthy();
  const body = capturedTraceBody as {
    resourceSpans: Array<{
      resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
      scopeSpans: Array<{
        spans: Array<{
          traceId: string;
          spanId: string;
          name: string;
          status: { code: number };
        }>;
      }>;
    }>;
  };

  const attrs = Object.fromEntries(
    body.resourceSpans[0].resource.attributes.map((a) => [a.key, a.value.stringValue]),
  );
  expect(attrs["service.name"]).toBe("Bakagame-Server");
  expect(attrs["service.namespace"]).toBe("Bakagame");
  expect(attrs["deployment.environment"]).toBe("production");

  const span = body.resourceSpans[0].scopeSpans[0].spans[0];
  expect(span.name).toBe("server.startup");
  expect(span.status.code).toBe(1);
  expect(span.traceId.length).toBe(32);
  expect(span.spanId.length).toBe(16);
});

test("POST /api/monitoring/telemetry 拦截超长/深度嵌套/过多键的恶意载荷并防身份伪造", async () => {
  const loggedLines: string[] = [];
  const logger = new EventLogger((line) => loggedLines.push(line));

  const env: AppEnv = {
    clientUrl: "http://localhost:5173",
    serverUrl: "http://127.0.0.1",
    serverListenHost: "127.0.0.1",
    serverPort: 4899,
    wordBankPath: ":memory:",
  };

  const roomService = new RoomService({
    wordBankRepository: new WordBankRepository(":memory:"),
    eventLogger: logger,
  });

  const { app } = createApp({
    env,
    whoIsFakerService: roomService,
    logger,
  });

  // 1. 尝试伪造内部连接标识与注入换行
  const normalRes = await app.handle(
    new Request("http://localhost/api/monitoring/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        level: "info",
        message: "正常打点\r\n[BAKA] 伪造的日志行",
        metadata: {
          connectionId: "fake-admin-conn",
          ip: "10.0.0.1",
          customField: "safe_value\nwith_newline",
        },
      }),
    }),
  );
  expect(normalRes.status).toBe(200);

  const clientLog = loggedLines.find((l) => l.includes("正常打点"));
  expect(clientLog).toBeTruthy();
  // 确认日志单行未被拆分成多行，换行已被清洗为空格
  expect(clientLog).not.toContain("\n[BAKA]");
  expect(clientLog).not.toContain("\r");
  // 确认 identifier 依然保持 safe 默认（system），未被 fake-admin-conn 篡改
  expect(clientLog).toContain("         system | SYS [CLIENT] 正常打点  [BAKA] 伪造的日志行");
  expect(clientLog).not.toContain("fake-admin-conn |");

  // 2. 尝试传入过多键（超过 16 个）
  const tooManyKeys: Record<string, string> = {};
  for (let i = 0; i < 20; i++) {
    tooManyKeys[`key_${i}`] = "val";
  }
  const rejectKeysRes = await app.handle(
    new Request("http://localhost/api/monitoring/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "超多键上报",
        metadata: tooManyKeys,
      }),
    }),
  );
  expect(rejectKeysRes.status).toBe(422);

  // 3. 尝试传入嵌套对象
  const rejectNestedRes = await app.handle(
    new Request("http://localhost/api/monitoring/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "嵌套对象上报",
        metadata: {
          nested: { deeply: "nested" },
        },
      }),
    }),
  );
  expect(rejectNestedRes.status).toBe(422);
});

test("toUnixNanoString 兼容整型与高精度浮点毫秒并防止 BigInt RangeError", () => {
  // 1. 整数毫秒
  expect(toUnixNanoString(1700000000000)).toBe("1700000000000000000");

  // 2. 浮点毫秒 (如 Date.now() - performance.now() 产生的非整数时间戳)
  const floatMs = 1725553948737.4182;
  const nanoStr = toUnixNanoString(floatMs);
  expect(nanoStr.startsWith("1725553948737418")).toBe(true);
  expect(() => BigInt(nanoStr)).not.toThrow();

  // 3. 边界值：NaN, 负数, Infinity 回退到当前时间纳秒且不崩溃
  expect(() => toUnixNanoString(Number.NaN)).not.toThrow();
  expect(() => toUnixNanoString(-100)).not.toThrow();
  expect(() => toUnixNanoString(Infinity)).not.toThrow();
});

test("OtlpExporter 容错处理浮点时间戳的 Span 与 Log，杜绝 unhandledRejection", async () => {
  let capturedTrace: any = null;
  const mockServer = Bun.serve({
    port: 0,
    fetch(req) {
      return req.json().then((body) => {
        capturedTrace = body;
        return new Response(JSON.stringify({}), { status: 200 });
      });
    },
  });

  const exporter = new OtlpExporter({
    endpoint: `http://127.0.0.1:${mockServer.port}/otlp`,
  });

  // 模拟从 EventLogger.logOperation 传入的浮点 startTime
  const now = 1725553948738;
  const durationMs = 0.5818;
  exporter.enqueueSpan({
    name: "WS room.join",
    startTime: now - durationMs, // 1725553948737.4182 (浮点数)
    endTime: now,
    status: "OK",
  });

  exporter.enqueue({
    timestamp: now + 0.123, // 浮点 timestamp
    level: "INFO",
    message: "浮点打点",
  });

  // 必须平稳 flush，不抛出 RangeError: Not an integer
  await expect(exporter.flush()).resolves.toBeUndefined();
  await exporter.shutdown();
  mockServer.stop(true);

  expect(capturedTrace).toBeTruthy();
  const span = capturedTrace.resourceSpans[0].scopeSpans[0].spans[0];
  expect(span.name).toBe("WS room.join");
  expect(span.startTimeUnixNano.startsWith("1725553948737418")).toBe(true);
  expect(span.endTimeUnixNano).toBe("1725553948738000000");
});

test("EventLogger.logOperation 正确接收并透传 traceId 至 enqueueSpan 及其 attributes", () => {
  let capturedSpan: any = null;
  const mockExporter = {
    isEnabled: true,
    enqueueSpan: (span: any) => {
      capturedSpan = span;
    },
    enqueue: () => {},
  } as unknown as OtlpExporter;

  const logger = new EventLogger(() => {}, () => 1700000000000, mockExporter);
  const testTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";

  logger.logOperation({
    status: 200,
    durationMs: 50,
    identifier: "test-conn-1",
    action: "WS game.vote",
    traceId: testTraceId,
  });

  expect(capturedSpan).toBeTruthy();
  expect(capturedSpan.traceId).toBe(testTraceId);
  expect(capturedSpan.name).toBe("WS game.vote");
  expect(capturedSpan.attributes["trace.id"]).toBe(testTraceId);
  expect(capturedSpan.attributes["http.status_code"]).toBe(200);
});

test("App.ts HTTP 路由在 onAfterHandle 与 onError 中贯穿 traceId", async () => {
  const operations: Array<{ action: string; traceId?: string }> = [];
  const mockLogger = {
    logOperation: (entry: { action: string; traceId?: string }) => {
      operations.push({ action: entry.action, traceId: entry.traceId });
    },
    error: () => {},
    warn: () => {},
    info: () => {},
    write: async () => {},
  } as unknown as EventLogger;

  const env: AppEnv = {
    clientUrl: "http://localhost:5173",
    serverUrl: "http://127.0.0.1",
    serverListenHost: "127.0.0.1",
    serverPort: 4899,
    wordBankPath: ":memory:",
  };

  const roomService = new RoomService({
    wordBankRepository: new WordBankRepository(":memory:"),
    eventLogger: mockLogger,
  });

  const { app } = createApp({
    env,
    whoIsFakerService: roomService,
    logger: mockLogger,
  });

  // 1. 成功请求
  const resSuccess = await app.handle(
    new Request("http://localhost/livez", {
      headers: { "x-trace-id": "custom-trace-success-123" },
    }),
  );
  expect(resSuccess.status).toBe(200);
  const successOp = operations.find((o) => o.action.includes("/livez"));
  expect(successOp).toBeTruthy();
  expect(successOp?.traceId).toBe("custom-trace-success-123");

  // 2. 404 请求
  const resNotFound = await app.handle(
    new Request("http://localhost/non-existent-path", {
      headers: { "x-trace-id": "custom-trace-404-456" },
    }),
  );
  expect(resNotFound.status).toBe(404);
  const notFoundOp = operations.find((o) => o.action.includes("/non-existent-path"));
  expect(notFoundOp).toBeTruthy();
  expect(notFoundOp?.traceId).toBe("custom-trace-404-456");
});

test("POST /api/monitoring/telemetry 滑动窗口限流与采样控制", async () => {
  const { systemRoutes, TelemetryRateLimiter } = await import(
    "../src/transport/routes/System"
  );
  const loggedEntries: Array<{ level: string; msg: string; ctx: any }> = [];
  const mockLogger = {
    info: (msg: string, ctx: any) => loggedEntries.push({ level: "INFO", msg, ctx }),
    warn: (msg: string, ctx: any) => loggedEntries.push({ level: "WARN", msg, ctx }),
    error: (msg: string, ctx: any) => loggedEntries.push({ level: "ERROR", msg, ctx }),
  } as unknown as EventLogger;

  // 1. 测试限流（限制单 IP 最多 2 次）
  const rateLimiter = new TelemetryRateLimiter({ ipMaxRequests: 2, windowMs: 60_000 });
  const app = systemRoutes({
    logger: mockLogger,
    rateLimiter,
    sampleRate: 0.0, // 0 采样率，除 ERROR 外全丢弃
  });

  const headers = {
    "Content-Type": "application/json",
    "x-forwarded-for": "203.0.113.10",
  };

  const r1 = await app.handle(
    new Request("http://localhost/api/monitoring/telemetry", {
      method: "POST",
      headers,
      body: JSON.stringify({ level: "error", message: "重大错误" }),
    }),
  );
  expect(r1.status).toBe(200);

  const r2 = await app.handle(
    new Request("http://localhost/api/monitoring/telemetry", {
      method: "POST",
      headers,
      body: JSON.stringify({ level: "info", message: "普通打点" }),
    }),
  );
  expect(r2.status).toBe(200);

  // 第 3 次触发 429 限流
  const r3 = await app.handle(
    new Request("http://localhost/api/monitoring/telemetry", {
      method: "POST",
      headers,
      body: JSON.stringify({ level: "info", message: "频繁打点" }),
    }),
  );
  expect(r3.status).toBe(429);
  const r3Json = (await r3.json()) as { error?: string };
  expect(r3Json.error).toBe("Too Many Requests");

  // 2. 验证采样控制：sampleRate=0.0 时 ERROR 依然 100% 记录，而 INFO 被丢弃
  expect(loggedEntries.some((e) => e.level === "ERROR" && e.msg.includes("重大错误"))).toBe(true);
  expect(loggedEntries.some((e) => e.level === "INFO" && e.msg.includes("普通打点"))).toBe(false);
});

test("OtlpExporter 遇到 503 响应不会清空丢弃日志，保留在缓冲区并在重试成功后排空", async () => {
  let simulatedStatus = 503;
  let callCount = 0;
  let virtualTime = 1700000000000;

  const mockFetcher: OtlpFetcher = async () => {
    callCount++;
    if (simulatedStatus === 503) {
      return new Response("Service Unavailable", { status: 503 });
    }
    return new Response(JSON.stringify({ partialSuccess: {} }), { status: 200 });
  };

  const exporter = new OtlpExporter({
    endpoint: "http://127.0.0.1:9999/v1/logs",
    fetcher: mockFetcher,
    now: () => virtualTime,
  });

  exporter.enqueue({
    timestamp: virtualTime,
    level: "ERROR",
    message: "关键系统错误",
  });

  expect(exporter.buffer.length).toBe(1);

  // 1. 第一次导出：上游返回 503 失败
  const flushResult1 = await exporter.flushLogs();
  expect(flushResult1).toBe(false);
  expect(callCount).toBe(1);
  // 核心断言：彻底修复 {"calls":1,"buffer":0} 丢数据缺陷，数据保留在缓冲区中
  expect(exporter.buffer.length).toBe(1);
  expect(exporter.buffer[0].message).toBe("关键系统错误");

  let stats = exporter.getStats();
  expect(stats.totalAttempts).toBe(1);
  expect(stats.failureCount).toBe(1);
  expect(stats.successCount).toBe(0);
  expect(stats.consecutiveFailures).toBe(1);
  expect(stats.droppedCount).toBe(0);

  // 2. 在退避窗口内（1000ms）再次触发，应直接跳过网络调用并返回 false
  virtualTime += 500;
  const inBackoffResult = await exporter.flushLogs();
  expect(inBackoffResult).toBe(false);
  expect(callCount).toBe(1); // 未发起额外网络请求
  expect(exporter.buffer.length).toBe(1);

  // 3. 跨过退避窗口，上游服务恢复（200 OK）
  virtualTime += 600; // 500 + 600 = 1100ms > 1000ms
  simulatedStatus = 200;
  const flushResult2 = await exporter.flushLogs();
  expect(flushResult2).toBe(true);
  expect(callCount).toBe(2);
  expect(exporter.buffer.length).toBe(0); // 成功排空

  stats = exporter.getStats();
  expect(stats.totalAttempts).toBe(2);
  expect(stats.successCount).toBe(1);
  expect(stats.failureCount).toBe(1);
  expect(stats.consecutiveFailures).toBe(0); // 连续失败清零
  expect(stats.droppedCount).toBe(0);

  await exporter.shutdown();
});

test("OtlpExporter 在网络异常与请求超时下安全重新入队，杜绝数据丢失", async () => {
  let virtualTime = 1700000000000;
  let simulatedError: "network" | "timeout" | null = "network";

  const mockFetcher: OtlpFetcher = async () => {
    if (simulatedError === "network") {
      throw new Error("fetch failed: ECONNREFUSED");
    }
    if (simulatedError === "timeout") {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };

  const exporter = new OtlpExporter({
    endpoint: "http://127.0.0.1:9999/v1/logs",
    fetcher: mockFetcher,
    now: () => virtualTime,
  });

  exporter.enqueue({
    timestamp: virtualTime,
    level: "WARN",
    message: "网络抖动警告",
  });

  // 1. 网络异常触发重新入队
  const netResult = await exporter.flushLogs();
  expect(netResult).toBe(false);
  expect(exporter.buffer.length).toBe(1);
  expect(exporter.getStats().failureCount).toBe(1);
  expect(exporter.getStats().consecutiveFailures).toBe(1);

  // 2. 超时异常触发重新入队（推进时钟跨过 1000ms 退避）
  virtualTime += 1500;
  simulatedError = "timeout";
  const timeoutResult = await exporter.flushLogs();
  expect(timeoutResult).toBe(false);
  expect(exporter.buffer.length).toBe(1);
  expect(exporter.getStats().failureCount).toBe(2);
  expect(exporter.getStats().consecutiveFailures).toBe(2);

  // 3. 恢复正常并成功导出（连续失败 2 次退避为 2000ms，推进 2500ms）
  virtualTime += 2500;
  simulatedError = null;
  const okResult = await exporter.flushLogs();
  expect(okResult).toBe(true);
  expect(exporter.buffer.length).toBe(0);
  expect(exporter.getStats().successCount).toBe(1);
  expect(exporter.getStats().consecutiveFailures).toBe(0);

  await exporter.shutdown();
});

test("OtlpExporter 反复失败导致积压超过 500 条时淘汰最旧记录并累加 droppedCount", async () => {
  let virtualTime = 1700000000000;
  const mockFetcher: OtlpFetcher = async () => {
    return new Response("Service Unavailable", { status: 503 });
  };

  const exporter = new OtlpExporter({
    endpoint: "http://127.0.0.1:9999/v1/logs",
    fetcher: mockFetcher,
    now: () => virtualTime,
  });

  // 压入 550 条日志
  for (let i = 0; i < 550; i++) {
    exporter.enqueue({
      timestamp: virtualTime + i,
      level: "INFO",
      message: `日志条目 ${i}`,
    });
  }

  // 等待在途由于 50 条触发的自动 flush 失败并重新入队，触发淘汰
  await exporter.flushLogs();

  // 容量上限 500，溢出的 50 条被淘汰
  expect(exporter.buffer.length).toBe(500);
  expect(exporter.getStats().droppedCount).toBe(50);
  expect(exporter.buffer[0].message).toBe("日志条目 50");
  expect(exporter.buffer[499].message).toBe("日志条目 549");

  // 退避窗口期内继续压入 10 条，直接在 enqueue 触发淘汰
  for (let i = 550; i < 560; i++) {
    exporter.enqueue({
      timestamp: virtualTime + i,
      level: "INFO",
      message: `日志条目 ${i}`,
    });
  }

  expect(exporter.buffer.length).toBe(500);
  expect(exporter.getStats().droppedCount).toBe(60);
  expect(exporter.buffer[0].message).toBe("日志条目 60");
  expect(exporter.buffer[499].message).toBe("日志条目 559");

  await exporter.shutdown();
});

test("sendHeartbeatTrace 在未配置端点、503、网络异常下返回 false，仅在 200 时返回 true", async () => {
  // 1. 未配置端点
  const disabledExporter = new OtlpExporter();
  expect(await disabledExporter.sendHeartbeatTrace()).toBe(false);
  await disabledExporter.shutdown();

  // 2. 503 异常返回 false
  const failFetcher: OtlpFetcher = async () => new Response("503", { status: 503 });
  const failExporter = new OtlpExporter({
    endpoint: "http://127.0.0.1:9999/v1/traces",
    fetcher: failFetcher,
  });
  expect(await failExporter.sendHeartbeatTrace()).toBe(false);
  expect(failExporter.getStats().failureCount).toBe(1);
  await failExporter.shutdown();

  // 3. 网络异常返回 false
  const errFetcher: OtlpFetcher = async () => {
    throw new Error("Network is down");
  };
  const errExporter = new OtlpExporter({
    endpoint: "http://127.0.0.1:9999/v1/traces",
    fetcher: errFetcher,
  });
  expect(await errExporter.sendHeartbeatTrace()).toBe(false);
  expect(errExporter.getStats().failureCount).toBe(1);
  await errExporter.shutdown();

  // 4. 200 成功返回 true
  const okFetcher: OtlpFetcher = async () => new Response("{}", { status: 200 });
  const okExporter = new OtlpExporter({
    endpoint: "http://127.0.0.1:9999/v1/traces",
    fetcher: okFetcher,
  });
  expect(await okExporter.sendHeartbeatTrace()).toBe(true);
  expect(okExporter.getStats().successCount).toBe(1);
  expect(okExporter.getStats().consecutiveFailures).toBe(0);
  await okExporter.shutdown();
});

test("OtlpExporter 指数退避窗口（1s, 2s, 4s...最大 30s）计算与运行统计指标完整性", async () => {
  let virtualTime = 100000;
  let callCount = 0;

  const mockFetcher: OtlpFetcher = async () => {
    callCount++;
    return new Response("503", { status: 503 });
  };

  const exporter = new OtlpExporter({
    endpoint: "http://127.0.0.1:9999/v1/logs",
    fetcher: mockFetcher,
    now: () => virtualTime,
  });

  exporter.enqueue({ timestamp: virtualTime, level: "INFO", message: "m1" });

  // 失败 1: 退避 1000ms (1000 * 2^0)
  expect(await exporter.flushLogs()).toBe(false);
  expect(callCount).toBe(1);
  expect(exporter.getStats().consecutiveFailures).toBe(1);

  // 推进 500ms，在窗口内，被拦截
  virtualTime += 500;
  expect(await exporter.flushLogs()).toBe(false);
  expect(callCount).toBe(1);

  // 推进 600ms (累计 1100ms > 1000ms)，触发第 2 次失败，退避 2000ms (1000 * 2^1)
  virtualTime += 600;
  expect(await exporter.flushLogs()).toBe(false);
  expect(callCount).toBe(2);
  expect(exporter.getStats().consecutiveFailures).toBe(2);

  // 推进 1500ms，在 2000ms 窗口内，被拦截
  virtualTime += 1500;
  expect(await exporter.flushLogs()).toBe(false);
  expect(callCount).toBe(2);

  // 推进 600ms (累计 2100ms > 2000ms)，触发第 3 次失败，退避 4000ms (1000 * 2^2)
  virtualTime += 600;
  expect(await exporter.flushLogs()).toBe(false);
  expect(callCount).toBe(3);
  expect(exporter.getStats().consecutiveFailures).toBe(3);

  // 验证完整统计指标快照
  const stats = exporter.getStats();
  expect(stats.totalAttempts).toBe(3);
  expect(stats.failureCount).toBe(3);
  expect(stats.successCount).toBe(0);
  expect(stats.consecutiveFailures).toBe(3);
  expect(stats.droppedCount).toBe(0);

  await exporter.shutdown();
});



