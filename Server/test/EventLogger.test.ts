import { afterEach, expect, spyOn, test } from "bun:test";
import * as Sentry from "@sentry/bun";
import { EventLogger, describeError, redactData } from "../src/infrastructure/EventLogger";
import { _resetServerSentryForTest, initServerSentry } from "../src/infrastructure/Sentry";
import { OtlpExporter } from "../src/infrastructure/OtlpExporter";

let exporter: OtlpExporter | undefined;
afterEach(async () => {
  await exporter?.shutdown();
  exporter = undefined;
  _resetServerSentryForTest();
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
