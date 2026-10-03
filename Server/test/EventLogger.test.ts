import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as Sentry from "@sentry/bun";
import * as Release from "../src/infrastructure/Release";
import { EventLogger, describeError, redactData } from "../src/infrastructure/EventLogger";
import { _resetServerSentryForTest, initServerSentry } from "../src/infrastructure/Sentry";
import { OtlpExporter } from "../src/infrastructure/OtlpExporter";

let exporter: OtlpExporter | undefined;
let release: ReturnType<typeof spyOn>;
// 日志出口测试不依赖本机 Git 开销；发布证据由独立 Release 测试负责。
beforeEach(() => { release = spyOn(Release, "resolveServerRelease").mockReturnValue("V0.0.0（fixture）"); });
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
  const scope = { setTag: () => scope, setExtras: (value: Record<string, unknown>) => { extras = value; return scope; } };
  const scoped = spyOn(Sentry, "withScope").mockImplementation(((fn: any) => fn(scope)) as any);
  try {
    initServerSentry({ sentryDsn: "https://dummy@o000000.ingest.sentry.io/100001" } as any);
    exporter = new OtlpExporter({ endpoint: "https://collector.example.com", fetcher: async (_input: string | URL | Request, options?: RequestInit) => {
      bodies.push(String(options?.body)); return new Response("{}");
    } });
    const error = new Error("operation failed", { cause: new Error("database failure") });
    error.cause = { ...(describeError(error.cause)), password: "dummy-cause-password" };
    const context = { roomId: "room-safe", cookie: "dummy-cookie-long", sessionToken: "dummy-token-long", error,
      metadata: { password: "dummy-nested-password" }, sample: '{"cookie":"dummy-raw-secret"' };
    new EventLogger((message) => output.push(message), () => 1700000000000, exporter).error("operation failed", context);
    await exporter.flush();
    for (const sink of [output, bodies, logs.mock.calls, extras]) {
      const text = JSON.stringify(sink);
      for (const secret of ["dummy-cookie-long", "dummy-token-long", "dummy-cause-password", "dummy-nested-password", "dummy-raw-secret"])
        expect(text).not.toContain(secret);
      expect(text).toContain("room-safe");
      expect(text).toContain("database failure");
    }
    expect(captures).toHaveBeenCalledWith(error);
    expect(JSON.stringify(redactData(context))).toContain("[OMITTED_RAW_PAYLOAD]");
  } finally { init.mockRestore(); logs.mockRestore(); captures.mockRestore(); scoped.mockRestore(); }
});

test("OBS005 操作日志 stdout traceId 与 OTLP trace.id、Sentry属性同值", async () => {
  const output: string[] = [];
  const bodies: string[] = [];
  const init = spyOn(Sentry, "init").mockImplementation(() => undefined);
  const spans = spyOn(Sentry, "startSpan").mockImplementation(() => undefined as never);
  const count = spyOn(Sentry.metrics, "count").mockImplementation(() => undefined);
  const distribution = spyOn(Sentry.metrics, "distribution").mockImplementation(() => undefined);
  const stdout = spyOn(console, "info").mockImplementation((message: string) => { output.push(message); });
  try {
    initServerSentry({
      clientUrl: "http://localhost:5173", serverUrl: "http://127.0.0.1:1", serverListenHost: "127.0.0.1", serverPort: 1,
      wordBankPath: ":memory:", bangumiApiUrl: "http://127.0.0.1:9", bangumiImageUrl: "", sentryDsn: "https://fixture@o000000.ingest.sentry.io/100001",
    });
    exporter = new OtlpExporter({ endpoint: "http://127.0.0.1:9", fetcher: async (_input: string | URL | Request, options?: RequestInit) => {
      bodies.push(String(options?.body)); return new Response("{}");
    } });
    const logger = new EventLogger(undefined, () => 1700000000000, exporter);
    const traceIds = ["4bf92f3577b34da6a3ce929d0e0e4736", "f83c9b4a5b0248aa98d1563fa91a0212"];
    for (const [index, traceId] of traceIds.entries()) {
      logger.logOperation({ status: 200, durationMs: 12, identifier: `fixture-${index}`, action: index ? "WS room.requestSync" : "HTTP GET /readyz", traceId });
    }
    logger.logOperation({ status: 200, durationMs: 0, action: "fixture without trace" });
    await exporter.flush();
    type Span = { traceId: string; attributes: Array<{ key: string; value: { stringValue?: string } }> };
    const payload = JSON.parse(bodies[0]) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Span[] }> }> };
    const wireSpans = payload.resourceSpans[0].scopeSpans[0].spans;
    expect(output).toHaveLength(3);
    for (const [index, traceId] of traceIds.entries()) {
      const stdoutContext = JSON.parse(output[index].split(" | ").at(-1)!) as { traceId: string };
      expect(stdoutContext.traceId).toBe(traceId);
      expect(wireSpans[index].traceId).toBe(traceId);
      expect(wireSpans[index].attributes.find(attribute => attribute.key === "trace.id")?.value.stringValue).toBe(traceId);
      expect(spans.mock.calls[index][0].attributes?.["trace.id"]).toBe(traceId);
    }
    expect(output[2]).not.toContain("traceId");
    expect(spans.mock.calls[2][0].attributes).not.toHaveProperty("trace.id");
  } finally {
    stdout.mockRestore(); distribution.mockRestore(); count.mockRestore(); spans.mockRestore(); init.mockRestore();
  }
});
