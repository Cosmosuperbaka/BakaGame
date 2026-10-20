import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SentryTypes from "@sentry/react";
import {
  initClientSentry,
  captureClientException,
  captureClientMessage,
  captureClientLog,
  countClientMetric,
  recordClientMetric,
  withClientSpan,
  isClientSentryEnabled,
  notifyClientTelemetryEgressFailure,
  wrapTelemetryTransport,
  resetClientSentryForTest,
  type ClientSentryTransport,
  type SentrySdkDriver,
} from "./Sentry";
import type { BakaChannelIdentity } from "./BakaChannel";

/** 覆盖全部 SDK 出口的假 driver：夹具绝不触达真实 Sentry 模块，天然零外发。 */
const createMockDriver = () => {
  const driver: SentrySdkDriver = {
    init: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    withScope: vi.fn(),
    log: vi.fn(),
    metricCount: vi.fn(),
    metricDistribution: vi.fn(),
    startSpan: vi.fn(async (_name, _attributes, callback) =>
      callback({ setStatus: vi.fn(), setAttribute: vi.fn() } as unknown as SentryTypes.Span)
    ),
    makeTransport: vi.fn(
      () => ({ send: vi.fn(), flush: vi.fn() }) as unknown as ClientSentryTransport
    ),
  };
  return driver;
};

type CapturedInitOptions = {
  dsn?: string;
  tunnel?: string;
  dist?: string;
  initialScope?: { tags?: Record<string, string> };
  tracesSampleRate?: number;
  ignoreErrors: Array<string | RegExp>;
  beforeSend: (event: unknown, hint?: { originalException?: unknown }) => unknown;
  beforeSendLog: (log: { message: string }) => unknown;
  transport?: (options: unknown) => unknown;
  profilesSampleRate?: number;
  integrations?: Array<{ name?: string }>;
};

const capturedOptions = (initFn: unknown): CapturedInitOptions =>
  (initFn as { mock: { calls: Array<[CapturedInitOptions]> } }).mock
    .calls[0]?.[0] as CapturedInitOptions;

describe("Client Sentry 客户端接入与异常转发", () => {
  beforeEach(() => {
    resetClientSentryForTest();
    delete window.__BAKA_CHANNEL__;
  });

  afterEach(() => {
    delete window.__BAKA_CHANNEL__;
  });

  it("无 DSN 时静默跳过初始化", () => {
    initClientSentry({ dsn: "" });
    expect(isClientSentryEnabled()).toBe(false);
  });

  it("支持通过 options 传入自定义 DSN 与 serverUrl 规范初始化", () => {
    const mockDriver = createMockDriver();

    initClientSentry(
      {
        dsn: "https://mockkey@o000000.ingest.sentry.io/100001",
        serverUrl: "http://localhost:4850/",
        tracesSampleRate: 0.2,
      },
      mockDriver
    );

    expect(isClientSentryEnabled()).toBe(true);
    expect(mockDriver.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://mockkey@o000000.ingest.sentry.io/100001",
        tunnel: "http://localhost:4850/api/monitoring/sentry",
        tracesSampleRate: 0.2,
      })
    );
  });

  it("噪声豁免名单只收模块/分块加载类别文案，普通 API fetch 失败不再被吞", () => {
    const mockDriver = createMockDriver();
    initClientSentry({ dsn: "https://mockkey@o000000.ingest.sentry.io/100001" }, mockDriver);

    const ignoreErrors = capturedOptions(mockDriver.init).ignoreErrors;
    const isFiltered = (candidate: string) =>
      ignoreErrors.some((entry) =>
        typeof entry === "string" ? candidate.includes(entry) : entry.test(candidate)
      );

    // 模块/分块加载失败：文案与错误类别绑定，各引擎都要覆盖，维持豁免。
    expect(
      isFiltered("TypeError: Failed to fetch dynamically imported module: /assets/main.js")
    ).toBe(true);
    expect(isFiltered("TypeError: Loading chunk 42 failed.")).toBe(true);
    expect(isFiltered("TypeError: Importing a module script failed.")).toBe(true);
    expect(
      isFiltered('TypeError: error loading dynamically imported module for "/assets/x.js"')
    ).toBe(true);
    // 第三方扩展改写 DOM 与浏览器级良性中断维持豁免。
    expect(
      isFiltered(
        "NotFoundError: Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node."
      )
    ).toBe(true);
    expect(
      isFiltered("Error: InvalidStateError: Transition was aborted because of invalid state")
    ).toBe(true);
    expect(isFiltered("AbortError: Transition was skipped")).toBe(true);

    // 反例（F79）：Firefox/Safari 的通用网络失败文案同样由普通 API fetch 抛出，
    // 不得入名单——否则同类故障只在 Chromium 可见，跨引擎结局不对称。
    expect(isFiltered("Load failed (https://example.com/api/song)").valueOf()).toBe(false);
    expect(isFiltered("TypeError: NetworkError when attempting to fetch resource.")).toBe(false);
  });

  it("模块脚本解析失败与已自愈的模块加载在事件组装阶段被丢弃，业务异常不受影响", () => {
    const mockDriver = createMockDriver();
    initClientSentry({ dsn: "https://mockkey@o000000.ingest.sentry.io/100001" }, mockDriver);

    const { beforeSend } = capturedOptions(mockDriver.init);

    const parseFailure = {
      exception: {
        values: [
          {
            type: "SyntaxError",
            value: "Unexpected token '{'",
            stacktrace: {
              frames: [{ function: "promiseReactionJob" }, { function: "parseModule" }],
            },
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

    // retryLazyImport 触发自愈重载时打标记的事件丢弃；未自愈（门闩已耗尽）的必须保留。
    const selfHealed = new Error("Load failed");
    (selfHealed as Error & { bakagameSelfHealedModuleLoad?: true }).bakagameSelfHealedModuleLoad =
      true;
    expect(beforeSend(logicFailure, { originalException: selfHealed })).toBeNull();
    expect(beforeSend(logicFailure, { originalException: new Error("Load failed") })).toBe(
      logicFailure
    );
    expect(beforeSend(logicFailure, undefined)).toBe(logicFailure);
  });

  it("网页与壳客户端在事件上以 surface 标签与 dist 可区分（F77）", () => {
    // 网页环境：无壳注入身份 → surface=web，dist 缺省（不硬编码任何现网标识）。
    const webDriver = createMockDriver();
    initClientSentry({ dsn: "https://mockkey@o000000.ingest.sentry.io/100001" }, webDriver);
    const webOptions = capturedOptions(webDriver.init);
    expect(webOptions.initialScope?.tags?.surface).toBe("web");
    expect(webOptions.dist).toBeUndefined();
    resetClientSentryForTest();

    // 壳环境：标签与版本取自壳页面加载前注入的只读身份（与服务端握手的权威字段同源）。
    window.__BAKA_CHANNEL__ = {
      clientType: "mobile",
      platform: "android",
      clientVersion: "0.1.1",
    } satisfies BakaChannelIdentity;
    const shellDriver = createMockDriver();
    initClientSentry({ dsn: "https://mockkey@o000000.ingest.sentry.io/100001" }, shellDriver);
    const shellOptions = capturedOptions(shellDriver.init);
    expect(shellOptions.initialScope?.tags?.surface).toBe("mobile");
    expect(shellOptions.dist).toBe("mobile@0.1.1");
  });

  it("logger / metrics / startSpan 全部经 driver 接缝派发，未初始化时零出口（F80）", () => {
    const mockDriver = createMockDriver();

    // 未初始化：所有出口静默，不依赖真实 SDK 的偶然状态。
    captureClientLog("x", "warning");
    countClientMetric("m", 1);
    recordClientMetric("m", 1);
    expect(mockDriver.log).not.toHaveBeenCalled();
    expect(mockDriver.metricCount).not.toHaveBeenCalled();
    expect(mockDriver.metricDistribution).not.toHaveBeenCalled();

    initClientSentry({ dsn: "https://mockkey@o000000.ingest.sentry.io/100001" }, mockDriver);

    captureClientLog("云同步失败：偏好超出上限", "warning", { path: "/api/sync", noisy: {} });
    expect(mockDriver.log).toHaveBeenCalledWith("warning", "云同步失败：偏好超出上限", {
      path: "/api/sync",
    });

    countClientMetric("bakagame.websocket.commands", 5, { path: "/ws" });
    expect(mockDriver.metricCount).toHaveBeenCalledWith("bakagame.websocket.commands", 5, {
      path: "/ws",
    });
    countClientMetric("bakagame.websocket.commands", Number.NaN);
    expect(mockDriver.metricCount).toHaveBeenCalledTimes(1);

    recordClientMetric("bakagame.websocket.command.duration", 42, { command: "join" });
    expect(mockDriver.metricDistribution).toHaveBeenCalledWith(
      "bakagame.websocket.command.duration",
      42,
      { command: "join" }
    );

    // withClientSpan 经 driver.startSpan 派发并透传回调结果。
    const spanMarker = { marker: "ok" };
    return withClientSpan("WS test", async () => spanMarker, { op: "unit-test" }).then((result) => {
      expect(mockDriver.startSpan).toHaveBeenCalled();
      expect(result).toBe(spanMarker);
    });
  });

  it("日志出口按与事件侧一致的噪声边界过滤（beforeSendLog）", () => {
    const mockDriver = createMockDriver();
    initClientSentry({ dsn: "https://mockkey@o000000.ingest.sentry.io/100001" }, mockDriver);

    const { beforeSendLog } = capturedOptions(mockDriver.init);
    expect(
      beforeSendLog({ message: "Failed to fetch dynamically imported module: /assets/app.js" })
    ).toBeNull();
    expect(beforeSendLog({ message: "WebSocket 命令失败" })).toEqual({
      message: "WebSocket 命令失败",
    });
  });

  it("隧道出口自身故障产生本地可见信号，且按窗口节流（F76）", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const failures: string[] = [];
    const fakeEnvelope = [{ sentAt: Date.now() }, []] as never;
    const failingBase = {
      send: vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
      flush: vi.fn(),
    } as unknown as ClientSentryTransport;
    const failingTransport = wrapTelemetryTransport(failingBase, (reason) => {
      failures.push(reason);
    });
    await expect(failingTransport.send(fakeEnvelope)).rejects.toBeInstanceOf(TypeError);
    expect(failures).toEqual(["Failed to fetch"]);

    const badGatewayBase = {
      send: vi.fn().mockResolvedValue({ statusCode: 502 }),
      flush: vi.fn(),
    } as unknown as ClientSentryTransport;
    const badGatewayTransport = wrapTelemetryTransport(badGatewayBase, (reason) => {
      failures.push(reason);
    });
    await badGatewayTransport.send(fakeEnvelope);
    expect(failures).toContain("隧道返回 HTTP 502");

    const okBase = {
      send: vi.fn().mockResolvedValue({ statusCode: 200 }),
      flush: vi.fn(),
    } as unknown as ClientSentryTransport;
    const okFailures: string[] = [];
    await wrapTelemetryTransport(okBase, (reason) => okFailures.push(reason)).send(fakeEnvelope);
    expect(okFailures).toHaveLength(0);

    // 真实信号本身：节流窗口内只告警一次，复位后可再告警。
    notifyClientTelemetryEgressFailure("隧道返回 HTTP 504");
    notifyClientTelemetryEgressFailure("隧道返回 HTTP 503");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("HTTP 504");
    resetClientSentryForTest();
    notifyClientTelemetryEgressFailure("隧道返回 HTTP 503");
    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("初始化时把出口故障感知的 transport 经 driver.makeTransport 接入", () => {
    const mockDriver = createMockDriver();
    initClientSentry({ dsn: "https://mockkey@o000000.ingest.sentry.io/100001" }, mockDriver);
    const { transport } = capturedOptions(mockDriver.init);
    expect(typeof transport).toBe("function");
    expect(mockDriver.makeTransport).not.toHaveBeenCalled();
    transport?.({ url: "http://localhost:4850/api/monitoring/sentry" });
    expect(mockDriver.makeTransport).toHaveBeenCalledTimes(1);
  });

  it("captureClientException 与 captureClientMessage 在初始化后正常派发", () => {
    const mockDriver = createMockDriver();
    const mockCaptureException = mockDriver.captureException as ReturnType<typeof vi.fn>;
    const mockCaptureMessage = mockDriver.captureMessage as ReturnType<typeof vi.fn>;
    const mockWithScope = mockDriver.withScope as ReturnType<typeof vi.fn>;
    mockWithScope.mockImplementation((cb) => {
      cb({ setTag: vi.fn(), setExtras: vi.fn() });
    });

    initClientSentry(
      {
        dsn: "https://mockkey@o000000.ingest.sentry.io/100001",
      },
      mockDriver
    );

    captureClientException(new Error("渲染崩溃测试"), { traceId: "test-trace-1" });
    expect(mockWithScope).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);

    captureClientMessage("手动上报告警", "warning", { traceId: "test-trace-2" });
    expect(mockWithScope).toHaveBeenCalledTimes(2);
    expect(mockCaptureMessage).toHaveBeenCalledWith("手动上报告警", "warning");
  });

  it("严格禁止注册性能剖析集成与采样率，避免触发浏览器策略违规", () => {
    const mockDriver = createMockDriver();
    initClientSentry({ dsn: "https://mockkey@o000000.ingest.sentry.io/100001" }, mockDriver);

    const initOptions = capturedOptions(mockDriver.init);
    expect(initOptions.profilesSampleRate).toBeUndefined();
    const integrationNames = (initOptions.integrations ?? []).map((i) => i.name ?? "");
    expect(integrationNames).not.toContain("BrowserProfiling");
    expect(integrationNames.some((name) => name.toLowerCase().includes("profil"))).toBe(false);
  });
});
