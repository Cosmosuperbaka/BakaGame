import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as Sentry from "@sentry/bun";
import * as Release from "../src/infrastructure/Release";
import { EventLogger, describeError, redactData } from "../src/infrastructure/EventLogger";
import type { OtelLogRecord } from "../src/infrastructure/logging/OtelLog";
import { _resetServerSentryForTest, initServerSentry } from "../src/infrastructure/Sentry";
import { OtlpExporter } from "../src/infrastructure/OtlpExporter";
import { requestBodyText } from "./RequestFixtures";
import type { AppEnv } from "../src/config/Env";
import { DEFAULT_DEPLOYMENT_ENVIRONMENT } from "../src/config/env/Observability";
import { createServerLogger } from "../src/infrastructure/logging/LoggerRuntime";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    for (const channel of [output, bodies, extras, records]) {
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

/**
 * 「状态类别 → 级别」口径：调用方的错记信息级（仍进文件，失败是排障线索），
 * 服务端的错记错误级，WARN 只留给显式的安全事件，操作日志本身不产生告警。
 */
test.each([
  [200, "INFO"],
  [400, "INFO"],
  [401, "INFO"],
  [403, "INFO"],
  [404, "INFO"],
  [429, "INFO"],
  [500, "ERROR"],
  [502, "ERROR"],
  [503, "ERROR"],
] as const)("操作日志级别口径：状态 %i 记为 %s", (status, expected) => {
  const output: string[] = [];
  const { records, sink } = memorySink();
  const logger = new EventLogger(
    (message) => output.push(message),
    () => 1_000,
    undefined,
    undefined,
    { sinks: [sink] }
  );
  logger.logOperation({ action: "WS room.join", status, durationMs: 5 });
  if (status < 400) {
    expect(records).toHaveLength(0);
    return;
  }
  // 失败进文件；只有服务端的错才上控制台，调用方的错不吵人。
  expect(records).toHaveLength(1);
  expect(records[0]!.severityText).toBe(expected);
  expect(output).toHaveLength(expected === "ERROR" ? 1 : 0);
});

test("客户端自报的追踪号形状不合格时不进日志记录，合格的原样保留", () => {
  const { records, sink } = memorySink();
  const logger = new EventLogger(
    () => undefined,
    () => 1_000,
    undefined,
    "DEBUG",
    {
      sinks: [sink],
    }
  );
  const good = "4bf92f3577b34da6a3ce929d0e0e4736";
  logger.logOperation({ action: "WS room.join", status: 400, traceId: good });
  logger.logOperation({ action: "WS room.join", status: 400, traceId: "x".repeat(300) });
  logger.warn("系统日志也一样", { traceId: "<script>alert(1)</script>" });
  expect(records[0]!.traceId).toBe(good);
  expect(records[1]!.traceId).toBeUndefined();
  expect(records[2]!.traceId).toBeUndefined();
  expect(JSON.stringify(records)).not.toContain("script");
  expect(JSON.stringify(records)).not.toContain("xxxxxxxx");
});

test("装配的日志资源在省略部署环境时用统一缺省值", () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-logger-env-"));
  try {
    const logger = createServerLogger({ logDirectory: directory } as AppEnv);
    logger.warn("环境缺省值核对");
    void logger.close();
    const [file] = readdirSync(directory);
    const text = readFileSync(join(directory, file!), "utf8");
    expect(text).toContain(
      `"deployment.environment","value":{"stringValue":"${DEFAULT_DEPLOYMENT_ENVIRONMENT}"}`
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("领域事件都有中文标签与检索范围，不落回「事件 xxx」兜底", async () => {
  const { records, sink } = memorySink();
  const logger = new EventLogger(
    () => undefined,
    () => 1_000,
    undefined,
    undefined,
    {
      sinks: [sink],
    }
  );
  const emitted = [
    "game.blank_guess_entered",
    "game.blank_guess_reviewed",
    "room.host_transferred",
    "song.auth.cookieRejected",
    "song.auth.poolSharing",
    "song.auto.exhausted",
    "song.auto.failed",
    "song.auto.pool",
    "song.game.round_finished",
    "song.game.started",
    "song.player.disconnected",
    "song.room.created",
    "song.room.joined",
  ];
  for (const type of emitted) await logger.write({ type, createdAt: 1_000 });
  for (const [index, type] of emitted.entries()) {
    expect(records[index]!.body, type).not.toStartWith("事件 ");
    expect(records[index]!.attributes["log.scope"], type).not.toBe("系统");
  }
});

test("显式 scope 优先于正文关键词推断", () => {
  const { records, sink } = memorySink();
  const logger = new EventLogger(
    () => undefined,
    () => 1_000,
    undefined,
    undefined,
    {
      sinks: [sink],
    }
  );
  logger.warn("客户端完整性校验未通过", { scope: "安全" });
  expect(records[0]!.attributes["log.scope"]).toBe("安全");
});

test("突发告警按键节流：窗口内只记一条，窗口过后带上被压制的条数再记", () => {
  const { records, sink } = memorySink();
  let now = 1_000;
  const logger = new EventLogger(
    () => undefined,
    () => now,
    undefined,
    undefined,
    {
      sinks: [sink],
    }
  );
  const burst = () => logger.warnThrottled("完整性|register", 60_000, "客户端完整性校验未通过");
  burst();
  now += 10_000;
  burst();
  burst();
  // 不同的键互不影响。
  logger.warnThrottled("完整性|attest", 60_000, "客户端完整性校验未通过");
  expect(records).toHaveLength(2);
  expect(records[0]!.attributes.suppressed).toBeUndefined();

  now += 60_000;
  burst();
  expect(records).toHaveLength(3);
  expect(records[2]!.attributes.suppressed).toBe(2);
  expect(records[2]!.severityText).toBe("WARN");
});

test("节流键表有上限：被挤出的键下次出现时重新记一条，内存不随键数无限增长", () => {
  const { records, sink } = memorySink();
  const logger = new EventLogger(
    () => undefined,
    () => 1_000,
    undefined,
    undefined,
    {
      sinks: [sink],
    }
  );
  logger.warnThrottled("首个键", 60_000, "告警");
  for (let index = 0; index < 400; index += 1) logger.warnThrottled(`键 ${index}`, 60_000, "告警");
  const before = records.length;
  logger.warnThrottled("首个键", 60_000, "告警");
  expect(records.length).toBe(before + 1);
});

test("玩家掉线与房间正常关闭不产生告警级事件日志", async () => {
  const { records, sink } = memorySink();
  const logger = new EventLogger(
    () => undefined,
    () => 1_000,
    undefined,
    undefined,
    {
      sinks: [sink],
    }
  );
  await logger.write({ type: "player.disconnect", createdAt: 1_000, roomId: "r1" });
  await logger.write({ type: "room.closed", createdAt: 1_000, payload: { reason: "empty" } });
  expect(records.map((record) => record.severityText)).toEqual(["INFO", "INFO"]);
});

test("LOG_LEVEL=debug 时成功操作与 info 档一样进入 OTLP，本地文件按详细度独立过滤", async () => {
  const bodies: string[] = [];
  exporter = new OtlpExporter({
    endpoint: "https://collector.example.com",
    fetcher: async (_input: string | URL | Request, options?: RequestInit) => {
      bodies.push(requestBodyText(options));
      return new Response("{}");
    },
  });
  for (const level of ["INFO", "DEBUG"] as const) {
    bodies.length = 0;
    const logger = new EventLogger(
      () => undefined,
      () => 1_000,
      exporter,
      level
    );
    logger.logOperation({ action: "WS room.join", status: 200, durationMs: 5 });
    await exporter.flush();
    const logBodies = bodies.filter((body) => body.includes("实时命令完成"));
    expect(logBodies, `level=${level}`).toHaveLength(1);
  }
});

test("ERROR 系统日志只走异常事件一条路，不再同时写一条 Sentry log", () => {
  const init = spyOn(Sentry, "init").mockImplementation(() => undefined);
  const errorLog = spyOn(Sentry.logger, "error").mockImplementation(() => undefined);
  const captures = spyOn(Sentry, "captureException").mockImplementation(() => "");
  const scoped = spyOn(Sentry, "withScope").mockImplementation(((fn: (scope: unknown) => unknown) =>
    fn({ setTag: () => scoped, setExtras: () => scoped } as never)) as never);
  try {
    initServerSentry({ sentryDsn: "https://dummy@o000000.ingest.sentry.io/100001" } as never);
    const error = new Error("boom");
    new EventLogger(
      () => undefined,
      () => 1_000
    ).error("失败了", { error });
    expect(captures).toHaveBeenCalledTimes(1);
    expect(errorLog).not.toHaveBeenCalled();
  } finally {
    init.mockRestore();
    errorLog.mockRestore();
    captures.mockRestore();
    scoped.mockRestore();
  }
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
test("默认输出下一条 logger 记录恰好产出一条 Sentry 出口，且不写 console", () => {
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
    // 错误级只走异常事件（captureMessage/captureException）一条路，不再多写一条 log。
    expect(errorLog).not.toHaveBeenCalled();
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
