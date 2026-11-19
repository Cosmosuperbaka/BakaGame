import { describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  browserTracingIntegration: vi.fn(() => ({ name: "BrowserTracing" })),
  replayIntegration: vi.fn(() => ({ name: "Replay" })),
  consoleLoggingIntegration: vi.fn(() => ({ name: "ConsoleLogs" })),
}));
vi.mock("@sentry/react", () => sdk);

import { createSentryDriver } from "./SentryRuntime";

describe("SentryRuntime 默认 driver", () => {
  it("初始化时装配 Tracing、Replay 与控制台日志，且不含性能剖析集成", () => {
    createSentryDriver().init({ dsn: "https://mockkey@o000000.ingest.sentry.io/100001" });
    const options = sdk.init.mock.calls[0]?.[0] as {
      dsn: string;
      integrations: Array<{ name: string }>;
    };
    expect(options.dsn).toContain("mockkey");
    expect(options.integrations.map((i) => i.name)).toEqual([
      "BrowserTracing",
      "Replay",
      "ConsoleLogs",
    ]);
    expect(options.integrations.some((i) => i.name.toLowerCase().includes("profil"))).toBe(false);
    expect(sdk.replayIntegration).toHaveBeenCalledWith({ maskAllText: true, blockAllMedia: true });
  });
});
