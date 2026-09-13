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

  it("异常过滤名单覆盖全部浏览器引擎的模块加载失败文案与扩展注入噪声", () => {
    const mockInit = vi.fn();
    const mockDriver: SentrySdkDriver = {
      init: mockInit,
      captureException: vi.fn(),
      captureMessage: vi.fn(),
      withScope: vi.fn(),
    };

    initClientSentry({ dsn: "https://mockkey@o000000.ingest.sentry.io/100001" }, mockDriver);

    const ignoreErrors = (mockInit.mock.calls[0]?.[0] as { ignoreErrors: Array<string | RegExp> })
      .ignoreErrors;
    const isFiltered = (candidate: string) =>
      ignoreErrors.some((entry) =>
        typeof entry === "string" ? candidate.includes(entry) : entry.test(candidate),
      );

    expect(isFiltered("TypeError: Failed to fetch dynamically imported module: /assets/main.js")).toBe(true);
    expect(isFiltered("TypeError: Loading chunk 42 failed.")).toBe(true);
    expect(isFiltered("TypeError: Importing a module script failed.")).toBe(true);
    expect(isFiltered("Load failed (game.baka.website)")).toBe(true);
    expect(isFiltered("TypeError: NetworkError when attempting to fetch resource.")).toBe(true);
    expect(
      isFiltered(
        "NotFoundError: Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
      ),
    ).toBe(true);
  });

  it("模块脚本解析失败在事件组装阶段被丢弃，业务异常不受影响", () => {
    const mockInit = vi.fn();
    const mockDriver: SentrySdkDriver = {
      init: mockInit,
      captureException: vi.fn(),
      captureMessage: vi.fn(),
      withScope: vi.fn(),
    };

    initClientSentry({ dsn: "https://mockkey@o000000.ingest.sentry.io/100001" }, mockDriver);

    const beforeSend = (
      mockInit.mock.calls[0]?.[0] as { beforeSend: (event: unknown) => unknown }
    ).beforeSend;

    const parseFailure = {
      exception: {
        values: [
          {
            type: "SyntaxError",
            value: "Unexpected token '{'",
            stacktrace: { frames: [{ function: "promiseReactionJob" }, { function: "parseModule" }] },
          },
        ],
      },
    };
    expect(beforeSend(parseFailure)).toBeNull();

    const logicFailure = {
      exception: {
        values: [
          {
            type: "TypeError",
            value: "Cannot read properties of undefined (reading 'id')",
            stacktrace: { frames: [{ function: "GameRow" }] },
          },
        ],
      },
    };
    expect(beforeSend(logicFailure)).toBe(logicFailure);

    // 同为 SyntaxError 但没有 parseModule 帧，说明不是模块脚本解析失败，必须保留
    const jsonFailure = {
      exception: {
        values: [
          {
            type: "SyntaxError",
            value: "Unexpected token '{'",
            stacktrace: { frames: [{ function: "parseChangelog" }] },
          },
        ],
      },
    };
    expect(beforeSend(jsonFailure)).toBe(jsonFailure);
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
