import { expect, test } from "bun:test";
import { OtlpExporter } from "../src/infrastructure/OtlpExporter";
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

  // @ts-expect-error 读取内部 buffer 长度
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
