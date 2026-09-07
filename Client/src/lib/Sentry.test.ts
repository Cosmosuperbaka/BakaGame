import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  initClientSentry,
  captureClientException,
  captureClientMessage,
  isClientSentryEnabled,
  resetClientSentryForTest,
  type SentrySdkDriver,
} from "./Sentry";

describe("Client Sentry 客户端接入与异常转发", () => {
  beforeEach(() => {
    resetClientSentryForTest();
  });

  it("无 DSN 时静默跳过初始化", () => {
    initClientSentry({ dsn: "" });
    expect(isClientSentryEnabled()).toBe(false);
  });

  it("支持通过 options 传入自定义 DSN 与 serverUrl 规范初始化", () => {
    const mockInit = vi.fn();
    const mockDriver: SentrySdkDriver = {
      init: mockInit,
      captureException: vi.fn(),
      captureMessage: vi.fn(),
      withScope: vi.fn(),
    };

    initClientSentry(
      {
        dsn: "https://mockkey@o000000.ingest.sentry.io/100001",
        serverUrl: "http://localhost:4850/",
        tracesSampleRate: 0.2,
      },
      mockDriver,
    );

    expect(isClientSentryEnabled()).toBe(true);
    expect(mockInit).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://mockkey@o000000.ingest.sentry.io/100001",
        tunnel: "http://localhost:4850/api/monitoring/sentry",
        tracesSampleRate: 0.2,
      }),
    );
  });

  it("captureClientException 与 captureClientMessage 在初始化后正常派发", () => {
    const mockCaptureException = vi.fn();
    const mockCaptureMessage = vi.fn();
    const mockWithScope = vi.fn().mockImplementation((cb) => {
      const mockScope = {
        setTag: vi.fn(),
        setExtras: vi.fn(),
      };
      cb(mockScope);
    });

    const mockDriver: SentrySdkDriver = {
      init: vi.fn(),
      captureException: mockCaptureException,
      captureMessage: mockCaptureMessage,
      withScope: mockWithScope,
    };

    initClientSentry(
      {
        dsn: "https://mockkey@o000000.ingest.sentry.io/100001",
      },
      mockDriver,
    );

    captureClientException(new Error("渲染崩溃测试"), { traceId: "test-trace-1" });
    expect(mockWithScope).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);

    captureClientMessage("手动上报告警", "warning", { traceId: "test-trace-2" });
    expect(mockWithScope).toHaveBeenCalledTimes(2);
    expect(mockCaptureMessage).toHaveBeenCalledWith("手动上报告警", "warning");
  });
});
