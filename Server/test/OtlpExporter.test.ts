import { expect, test } from "bun:test";
import { OtlpExporter, toUnixNanoString } from "../src/infrastructure/OtlpExporter";
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


