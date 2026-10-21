import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as Sentry from "@sentry/bun";
import * as Release from "../src/infrastructure/Release";
import { EventLogger, describeError, redactData } from "../src/infrastructure/EventLogger";
import { _resetServerSentryForTest, initServerSentry } from "../src/infrastructure/Sentry";
import { OtlpExporter } from "../src/infrastructure/OtlpExporter";
import { requestBodyText } from "./RequestFixtures";

let exporter: OtlpExporter | undefined;
let release: ReturnType<typeof spyOn>;
// 日志出口测试不依赖本机 Git 开销；发布证据由独立 Release 测试负责。
beforeEach(() => {
  release = spyOn(Release, "resolveServerRelease").mockReturnValue("V0.0.0（fixture）");
});
afterEach(async () => {
  await exporter?.shutdown();
  exporter = undefined;
  _resetServerSentryForTest();
  release.mockRestore();
});

test("console / OTLP / Sentry 出口共用脱敏且保留错误 cause 诊断", async () => {
  const bodies: string[] = [];
  const output: string[] = [];
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
      exporter
    ).error("operation failed", context);
    await exporter.flush();
    for (const sink of [output, bodies, logs.mock.calls, extras]) {
      const text = JSON.stringify(sink);
      for (const secret of [
        "dummy-cookie-long",
        "dummy-token-long",
        "dummy-cause-password",
        "dummy-nested-password",
        "dummy-raw-secret",
      ])
        expect(text).not.toContain(secret);
      expect(text).toContain("room-safe");
      expect(text).toContain("database failure");
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

test("localInfo 只落 stdout，验证码明文不进 OTLP 与 Sentry", async () => {
  const output: string[] = [];
  const bodies: string[] = [];
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
      exporter
    ).localInfo("开发环境登录验证码 | to=dev@example.com code=888888");
    await exporter.flush();

    expect(output).toHaveLength(1);
    expect(output[0]).toContain("888888");
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

test("OBS005 操作日志 stdout traceId 与 OTLP trace.id、Sentry属性同值", async () => {
  const output: string[] = [];
  const bodies: string[] = [];
  const init = spyOn(Sentry, "init").mockImplementation(() => undefined);
  const spans = spyOn(Sentry, "startSpan").mockImplementation(() => undefined as never);
  const count = spyOn(Sentry.metrics, "count").mockImplementation(() => undefined);
  const distribution = spyOn(Sentry.metrics, "distribution").mockImplementation(() => undefined);
  const stdout = spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
    output.push(chunk);
    return true;
  }) as never);
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
    const logger = new EventLogger(undefined, () => 1700000000000, exporter);
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
    type Span = {
      traceId: string;
      attributes: Array<{ key: string; value: { stringValue?: string } }>;
    };
    const payload = JSON.parse(bodies[0]) as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Span[] }> }>;
    };
    const wireSpans = payload.resourceSpans[0].scopeSpans[0].spans;
    expect(output).toHaveLength(3);
    for (const [index, traceId] of traceIds.entries()) {
      const stdoutLine = JSON.parse(output[index]) as {
        context?: { traceId?: string };
      };
      expect(stdoutLine.context?.traceId).toBe(traceId);
      expect(wireSpans[index].traceId).toBe(traceId);
      expect(
        wireSpans[index].attributes.find((attribute) => attribute.key === "trace.id")?.value
          .stringValue
      ).toBe(traceId);
      expect(spans.mock.calls[index][0].attributes?.["trace.id"]).toBe(traceId);
    }
    expect(JSON.parse(output[2]!).context?.traceId).toBeUndefined();
    expect(spans.mock.calls[2][0].attributes).not.toHaveProperty("trace.id");
  } finally {
    stdout.mockRestore();
    distribution.mockRestore();
    count.mockRestore();
    spans.mockRestore();
    init.mockRestore();
  }
});

test("同类操作日志每秒只输出一条代表，告警不参与合并", () => {
  const output: string[] = [];
  let now = 1_000;
  const logger = new EventLogger(
    (message) => output.push(message),
    () => now
  );

  logger.logOperation({ action: "room.join", durationMs: 3 });
  logger.logOperation({ action: "room.join", durationMs: 4 });
  expect(output).toHaveLength(1);

  now = 2_000;
  logger.logOperation({ action: "room.join", durationMs: 5 });
  expect(output).toHaveLength(2);
  expect(JSON.parse(output[1]!).context?.merged).toBe(2);

  for (const index of [0, 1])
    logger.logOperation({
      action: "game.advancePhase",
      status: 500,
      level: "WARN",
      durationMs: index,
    });
  expect(
    output.filter((line) => JSON.parse(line).context?.status === 500)
  ).toHaveLength(2);
});

test("LOG_LEVEL 过滤 debug/info，错误仍按等级落盘", () => {
  const output: string[] = [];
  const logger = new EventLogger(
    (message) => output.push(message),
    () => 1_000,
    undefined,
    "WARN"
  );

  logger.debug("调试细节");
  logger.info("普通信息");
  logger.warn("需要注意", { traceId: "trace-1" });
  logger.error("失败了", { error: new TypeError("boom") });

  expect(output).toHaveLength(2);
  expect(JSON.parse(output[0]!)).toMatchObject({ level: "warn", msg: "需要注意" });
  const failed = JSON.parse(output[1]!) as {
    level: string;
    context: { error: { errorName: string; errorMessage: string; stack: string } };
  };
  expect(failed.level).toBe("error");
  expect(failed.context.error.errorName).toBe("TypeError");
  expect(failed.context.error.errorMessage).toBe("boom");
  expect(failed.context.error.stack).toContain("TypeError");
});

test("debug 等级下输出结构化单行 JSON，并脱敏敏感字段", () => {
  const output: string[] = [];
  const logger = new EventLogger(
    (message) => output.push(message),
    () => Date.UTC(2026, 3, 17, 8, 0, 0, 0),
    undefined,
    "DEBUG"
  );

  logger.debug("外部音源请求", {
    cookie: "dummy-cookie",
    password: "dummy-password",
    traceId: "trace-debug",
  });

  expect(output).toHaveLength(1);
  expect(output[0]).not.toContain("\n");
  const line = JSON.parse(output[0]!) as {
    time: string;
    level: string;
    msg: string;
    context: Record<string, string>;
  };
  expect(line).toMatchObject({
    time: "2026-04-17T08:00:00.000Z",
    level: "debug",
    msg: "外部音源请求",
  });
  expect(line.context.traceId).toBe("trace-debug");
  expect(JSON.stringify(line)).not.toContain("dummy-cookie");
  expect(JSON.stringify(line)).not.toContain("dummy-password");
});

/**
 * F06：默认 output 与 `captureServerLog` 双路并行时，每条 WARN/ERROR 在 Sentry 里计两次
 * （console 集成采集一次、显式上报一次）。既有各例都注入自定义 output，永远照不出这条重复，
 * 所以这一例专门用默认 output。断言的是不变量：**结构化记录不再触达 `console.*`**，
 * 于是 Sentry 侧只剩显式出口这一条真相源。
 */
test("默认 output 下一条 logger 记录恰好产出一条 Sentry log，且不写 console", () => {
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
    // 不传 output：走默认进程流出口，与生产装配（Index.ts）同一条路径。
    const logger = new EventLogger(undefined, () => 1700000000000);
    logger.info("遥测双路回归-信息");
    logger.warn("遥测双路回归-告警");
    logger.error("遥测双路回归-错误");

    expect(infoLog).toHaveBeenCalledTimes(1);
    expect(warnLog).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);
    // ERROR 另有且仅有一个 issue 出口（无 Error 本体时走 captureMessage）。
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
