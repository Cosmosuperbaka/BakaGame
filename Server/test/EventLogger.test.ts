import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as Sentry from "@sentry/bun";
import * as Release from "../src/infrastructure/Release";
import { EventLogger, describeError, redactData } from "../src/infrastructure/EventLogger";
import type { OtelLogRecord } from "../src/infrastructure/logging/OtelLog";
import { _resetServerSentryForTest, initServerSentry } from "../src/infrastructure/Sentry";
import { OtlpExporter } from "../src/infrastructure/OtlpExporter";
import { requestBodyText } from "./RequestFixtures";

let exporter: OtlpExporter | undefined;
let release: ReturnType<typeof spyOn>;

beforeEach(() => {
  release = spyOn(Release, "resolveServerRelease").mockReturnValue("V0.0.0（fixture）");
});
afterEach(async () => {
  await exporter?.shutdown();
  exporter = undefined;
  _resetServerSentryForTest();
  release.mockRestore();
});

const memorySink = () => {
  const records: OtelLogRecord[] = [];
  return { records, sink: { write: (record: OtelLogRecord) => records.push(record) } };
};

test("控制台 / 文件 / OTLP / Sentry 共用脱敏且保留错误 cause 诊断", async () => {
  const bodies: string[] = [];
  const output: string[] = [];
  const { records, sink } = memorySink();
  const init = spyOn(Sentry, "init").mockImplementation(() => undefined);
  const logs = spyOn(Sentry.logger, "error").mockImplementation(() => undefined);
  const captures = spyOn(Sentry, "captureException").mockImplementation(() => "");
  let extras: Record<string, unknown> | undefined;
  const scope = {
    setTag: () => scope,
    setExtras: (value: Record<string, unknown>) => {
      extras = value;
      return scope;
    },
  };
  const scoped = spyOn(Sentry, "withScope").mockImplementation(((fn: any) => fn(scope)) as any);
  try {
    initServerSentry({ sentryDsn: "https://dummy@o000000.ingest.sentry.io/100001" } as any);
    exporter = new OtlpExporter({
      endpoint: "https://collector.example.com",
      fetcher: async (_input: string | URL | Request, options?: RequestInit) => {
        bodies.push(requestBodyText(options));
        return new Response("{}");
      },
    });
    const error = new Error("operation failed", { cause: new Error("database failure") });
    error.cause = { ...describeError(error.cause), password: "dummy-cause-password" };
    const context = {
      roomId: "room-safe",
      cookie: "dummy-cookie-long",
      sessionToken: "dummy-token-long",
      error,
      metadata: { password: "dummy-nested-password" },
      sample: '{"cookie":"dummy-raw-secret"',
    };
    new EventLogger(
      (message) => output.push(message),
      () => 1700000000000,
      exporter,
      undefined,
      { sinks: [sink] }
    ).error("operation failed", context);
    await exporter.flush();
    for (const channel of [output, bodies, logs.mock.calls, extras, records]) {
      const text = JSON.stringify(channel);
      for (const secret of [
        "dummy-cookie-long",
        "dummy-token-long",
        "dummy-cause-password",
        "dummy-nested-password",
        "dummy-raw-secret",
      ])
        expect(text).not.toContain(secret);
      expect(text).toContain("room-safe");
    }
    // 控制台按设计只留首帧异常，完整 cause 链只进结构化出口。
    for (const channel of [bodies, extras, records]) {
      expect(JSON.stringify(channel)).toContain("database failure");
    }
    expect(captures).toHaveBeenCalledWith(error);
    expect(JSON.stringify(redactData(context))).toContain("[OMITTED_RAW_PAYLOAD]");
  } finally {
    init.mockRestore();
    logs.mockRestore();
    captures.mockRestore();
    scoped.mockRestore();
  }
});

test("localInfo 只落控制台，验证码明文不进文件、OTLP 与 Sentry", async () => {
  const output: string[] = [];
  const bodies: string[] = [];
  const { records, sink } = memorySink();
  const init = spyOn(Sentry, "init").mockImplementation(() => undefined);
  const info = spyOn(Sentry.logger, "info").mockImplementation(() => undefined);
  const captures = spyOn(Sentry, "captureMessage").mockImplementation(() => "");
  try {
    initServerSentry({ sentryDsn: "https://dummy@o000000.ingest.sentry.io/100001" } as any);
    exporter = new OtlpExporter({
      endpoint: "https://collector.example.com",
      fetcher: async (_input: string | URL | Request, options?: RequestInit) => {
        bodies.push(requestBodyText(options));
        return new Response("{}");
      },
    });
    new EventLogger(
      (message) => output.push(message),
      () => 1700000000000,
      exporter,
      undefined,
      { sinks: [sink] }
    ).localInfo("开发环境登录验证码 | to=dev@example.com code=888888");
    await exporter.flush();

    expect(output).toHaveLength(1);
    expect(output[0]).toContain("888888");
    expect(records).toHaveLength(0);
    expect(exporter.buffer).toHaveLength(0);
    expect(bodies).toEqual([]);
    expect(info).not.toHaveBeenCalled();
    expect(captures).not.toHaveBeenCalled();
  } finally {
    init.mockRestore();
    info.mockRestore();
    captures.mockRestore();
  }
});

test("OBS005 操作记录 traceId 与 OTLP span、Sentry 属性同值，成功操作不上控制台", async () => {
  const output: string[] = [];
  const bodies: string[] = [];
  const { records, sink } = memorySink();
  const init = spyOn(Sentry, "init").mockImplementation(() => undefined);
  const spans = spyOn(Sentry, "startSpan").mockImplementation(() => undefined as never);
  const count = spyOn(Sentry.metrics, "count").mockImplementation(() => undefined);
  const distribution = spyOn(Sentry.metrics, "distribution").mockImplementation(() => undefined);
  try {
    initServerSentry({
      clientUrl: "http://localhost:5173",
      serverUrl: "http://127.0.0.1:1",
      serverListenHost: "127.0.0.1",
      serverPort: 1,
      bangumiApiUrl: "http://127.0.0.1:9",
      bangumiImageUrl: "",
      sentryDsn: "https://fixture@o000000.ingest.sentry.io/100001",
    });
    exporter = new OtlpExporter({
      endpoint: "http://127.0.0.1:9",
      fetcher: async (_input: string | URL | Request, options?: RequestInit) => {
        bodies.push(requestBodyText(options));
        return new Response("{}");
      },
    });
    const logger = new EventLogger(
      (message) => output.push(message),
      () => 1700000000000,
      exporter,
      undefined,
      { sinks: [sink], operationLogging: "all" }
    );
    const traceIds = ["4bf92f3577b34da6a3ce929d0e0e4736", "f83c9b4a5b0248aa98d1563fa91a0212"];
    for (const [index, traceId] of traceIds.entries()) {
      logger.logOperation({
        status: 200,
        durationMs: 12,
        identifier: `fixture-${index}`,
        action: index ? "WS room.requestSync" : "HTTP GET /readyz",
        traceId,
      });
    }
    logger.logOperation({ status: 200, durationMs: 0, action: "fixture without trace" });
    await exporter.flush();

    expect(output).toEqual([]);
    expect(records).toHaveLength(3);
    const spanPayloads = bodies
      .map(
        (body) =>
          JSON.parse(body) as {
            resourceSpans?: Array<{
              scopeSpans: Array<{
                spans: Array<{
                  traceId: string;
                  attributes: Array<{ key: string; value: { stringValue?: string } }>;
                }>;
              }>;
            }>;
          }
      )
      .filter((payload) => payload.resourceSpans);
    const wireSpans = spanPayloads[0]!.resourceSpans![0].scopeSpans[0].spans;
    for (const [index, traceId] of traceIds.entries()) {
      expect(records[index].traceId).toBe(traceId);
      expect(wireSpans[index].traceId).toBe(traceId);
      expect(
        wireSpans[index].attributes.find((attribute) => attribute.key === "trace.id")?.value
          .stringValue
      ).toBe(traceId);
      expect(spans.mock.calls[index][0].attributes?.["trace.id"]).toBe(traceId);
    }
    expect(records[2]!.traceId).toBeUndefined();
    expect(spans.mock.calls[2][0].attributes).not.toHaveProperty("trace.id");
  } finally {
    distribution.mockRestore();
    count.mockRestore();
    spans.mockRestore();
    init.mockRestore();
  }
});

test("成功操作默认不落盘，慢操作与失败操作进入文件与控制台", () => {
  const output: string[] = [];
  const { records, sink } = memorySink();
  let now = 1_000;
  const logger = new EventLogger(
    (message) => output.push(message),
    () => now,
    undefined,
    undefined,
    { sinks: [sink] }
  );

  logger.logOperation({ action: "WS room.join", durationMs: 12 });
  expect(records).toHaveLength(0);
  expect(output).toHaveLength(0);

  now = 2_000;
  logger.logOperation({ action: "HTTP GET /api/status", durationMs: 1_500 });
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ severityText: "INFO", body: "接口请求较慢 GET /api/status" });
  expect(output).toHaveLength(1);
  expect(output[0]).toContain("接口请求较慢 GET /api/status");
  expect(output[0]).toContain("耗时=1.50s");

  now = 3_000;
  logger.logOperation({ action: "WS room.join", status: 500, level: "ERROR", durationMs: 30 });
  expect(records).toHaveLength(2);
  expect(records[1]).toMatchObject({ severityText: "ERROR", body: "实时命令失败 room.join" });
  expect(output).toHaveLength(2);
  expect(output[1]).toContain("实时命令失败 room.join");
});

test("LOG_LEVEL 过滤 debug/info，错误仍按等级落盘并保留异常栈", () => {
  const output: string[] = [];
  const { records, sink } = memorySink();
  const logger = new EventLogger(
    (message) => output.push(message),
    () => 1_000,
    undefined,
    "WARN",
    { sinks: [sink] }
  );

  logger.debug("调试细节");
  logger.info("普通信息");
  logger.warn("需要注意", { traceId: "trace-1" });
  logger.error("失败了", { error: new TypeError("boom") });

  expect(records).toHaveLength(2);
  expect(output).toHaveLength(2);
  expect(records[0]).toMatchObject({ severityText: "WARN", body: "需要注意" });
  expect(records[1]).toMatchObject({ severityText: "ERROR", body: "失败了" });
  expect(records[1].attributes["exception.type"]).toBe("TypeError");
  expect(records[1].attributes["exception.message"]).toBe("boom");
  expect(String(records[1].attributes["exception.stacktrace"])).toContain("TypeError");
  expect(output[1]).toContain("异常=TypeError: boom");
});

test("debug 等级下完整记录进入文件，控制台不输出，敏感字段已脱敏", () => {
  const output: string[] = [];
  const { records, sink } = memorySink();
  const logger = new EventLogger(
    (message) => output.push(message),
    () => Date.UTC(2026, 3, 17, 8, 0, 0, 0),
    undefined,
    "DEBUG",
    { sinks: [sink] }
  );

  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  logger.debug("外部音源请求", {
    cookie: "dummy-cookie",
    password: "dummy-password",
    traceId,
  });

  expect(output).toHaveLength(0);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    severityText: "DEBUG",
    body: "外部音源请求",
    traceId,
  });
  expect(JSON.stringify(records[0])).not.toContain("dummy-cookie");
  expect(JSON.stringify(records[0])).not.toContain("dummy-password");
});

/**
 * 结构化记录不再触达 `console.*`：Sentry 侧只剩显式出口这一条真相源，
 * WARN/ERROR 不会因为 console 集成被重复计数。
 */
test("默认输出下一条 logger 记录恰好产出一条 Sentry log，且不写 console", () => {
  const init = spyOn(Sentry, "init").mockImplementation(() => undefined);
  const errorLog = spyOn(Sentry.logger, "error").mockImplementation(() => undefined);
  const warnLog = spyOn(Sentry.logger, "warn").mockImplementation(() => undefined);
  const infoLog = spyOn(Sentry.logger, "info").mockImplementation(() => undefined);
  const captures = spyOn(Sentry, "captureException").mockImplementation(() => "");
  const messages = spyOn(Sentry, "captureMessage").mockImplementation(() => "");
  const scoped = spyOn(Sentry, "withScope").mockImplementation(((fn: (scope: unknown) => unknown) =>
    fn({ setTag: () => scoped, setExtras: () => scoped } as never)) as never);
  const consoleInfo = spyOn(console, "info").mockImplementation(() => undefined);
  const consoleWarn = spyOn(console, "warn").mockImplementation(() => undefined);
  const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
  const stdout = spyOn(process.stdout, "write").mockImplementation((() => true) as never);
  const stderr = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
  try {
    initServerSentry({
      sentryDsn: "https://dummy@o000000.ingest.sentry.io/100001",
    } as never);
    // 不传 output：走默认进程流出口，与生产装配同一条路径。
    const logger = new EventLogger(undefined, () => 1700000000000);
    logger.info("遥测双路回归-信息");
    logger.warn("遥测双路回归-告警");
    logger.error("遥测双路回归-错误");

    expect(infoLog).toHaveBeenCalledTimes(1);
    expect(warnLog).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(messages).toHaveBeenCalledTimes(1);
    expect(captures).not.toHaveBeenCalled();

    expect(consoleInfo).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledTimes(2);
  } finally {
    init.mockRestore();
    errorLog.mockRestore();
    warnLog.mockRestore();
    infoLog.mockRestore();
    captures.mockRestore();
    messages.mockRestore();
    scoped.mockRestore();
    consoleInfo.mockRestore();
    consoleWarn.mockRestore();
    consoleError.mockRestore();
    stdout.mockRestore();
    stderr.mockRestore();
  }
});
