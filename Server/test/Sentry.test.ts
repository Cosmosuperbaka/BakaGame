import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import * as Sentry from "@sentry/bun";
import type { AppEnv } from "../src/config/Env";
import {
  _resetServerSentryForTest,
  captureServerException,
  captureServerCheckIn,
  captureServerMessage,
  closeServerSentry,
  flushServerSentry,
  initServerSentry,
  isServerSentryEnabled,
  resolveServerRelease,
  captureServerLog,
  redactData,
  describeError,
  SERVER_HEARTBEAT_INTERVAL_MS,
  SERVER_HEARTBEAT_MONITOR_SLUG,
} from "../src/infrastructure/Sentry";

// release 解析不依赖本机 Git/子进程权限；所有 SDK init 已由各例 mock。
let gitSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  gitSpy = spyOn(Bun, "spawnSync").mockImplementation((() => ({
    exitCode: 0, stdout: Buffer.from("abcdef1\n"), stderr: Buffer.alloc(0), success: true,
  })) as any);
});
afterEach(() => { gitSpy.mockRestore(); });

const createMockEnv = (overrides?: Partial<AppEnv>): AppEnv => ({
  clientUrl: "http://localhost:5173",
  serverUrl: "http://localhost:3000",
  serverListenHost: "0.0.0.0",
  serverPort: 3000,
  wordBankPath: "data/words.json",
  bangumiApiUrl: "https://api.bgm.tv",
  bangumiImageUrl: "",
  sentryDsn: "https://mockkey@o000000.ingest.sentry.io/100001",
  sentryAllowedProjectIds: ["100001"],
  ...overrides,
});

describe("Sentry (服务端异常监控托管与优雅排空)", () => {
  beforeEach(() => {
    _resetServerSentryForTest();
  });

  afterEach(() => {
    _resetServerSentryForTest();
  });

  describe("resolveServerRelease", () => {
    it("按项目版本与 Git 短提交生成发布标识", () => {
      const previous = process.env.SENTRY_RELEASE;
      try {
        process.env.SENTRY_RELEASE = "v2.0.0-rc1";
        const release = resolveServerRelease();
        expect(release).toMatch(/^V\d+\.\d+\.\d+（[0-9a-f]{7,}）$/);
        expect(release).not.toBe("v2.0.0-rc1");
      } finally {
        if (previous === undefined) delete process.env.SENTRY_RELEASE;
        else process.env.SENTRY_RELEASE = previous;
      }
    });
  });

  describe("initServerSentry & isServerSentryEnabled", () => {
    it("未配置 sentryDsn 时保持未启用状态", () => {
      const env = createMockEnv({ sentryDsn: undefined });
      initServerSentry(env);
      expect(isServerSentryEnabled()).toBe(false);
    });

    it("配置 sentryDsn 时成功调用 Sentry.init 并标记为已启用", () => {
      const initSpy = spyOn(Sentry, "init").mockImplementation((() => {}) as any);
      const env = createMockEnv({
        sentryDsn: "https://mock@o0.ingest.sentry.io/1",
        otelDeploymentEnvironment: "staging",
      });

      initServerSentry(env);
      expect(isServerSentryEnabled()).toBe(true);
      expect(initSpy).toHaveBeenCalled();
      const lastCall = initSpy.mock.calls[0]?.[0];
      expect(lastCall?.dsn).toBe("https://mock@o0.ingest.sentry.io/1");
      expect(lastCall?.environment).toBe("staging");
      expect(lastCall?.release).toBeDefined();

      initSpy.mockRestore();
    });
  });

  describe("未初始化状态的空操作防护", () => {
    it("未初始化时 captureServerException 静默跳过", () => {
      const captureSpy = spyOn(Sentry, "captureException").mockImplementation(() => "");
      captureServerException(new Error("Test error"));
      expect(captureSpy).not.toHaveBeenCalled();
      captureSpy.mockRestore();
    });

    it("未初始化时 captureServerMessage 静默跳过", () => {
      const captureSpy = spyOn(Sentry, "captureMessage").mockImplementation(() => "");
      captureServerMessage("Test message");
      expect(captureSpy).not.toHaveBeenCalled();
      captureSpy.mockRestore();
    });

    it("未初始化时 flushServerSentry 与 closeServerSentry 快速返回 true", async () => {
      expect(await flushServerSentry()).toBe(true);
      expect(await closeServerSentry()).toBe(true);
    });
  });

  it("已初始化时发送服务心跳检查", () => {
    const initSpy = spyOn(Sentry, "init").mockImplementation((() => {}) as any);
    initServerSentry(createMockEnv());
    initSpy.mockRestore();
    const checkInSpy = spyOn(Sentry, "captureCheckIn").mockImplementation(() => "check-in");

    captureServerCheckIn();

    expect(checkInSpy).toHaveBeenCalledWith({
      monitorSlug: "bakagame-server-heartbeat",
      status: "ok",
    });
    checkInSpy.mockRestore();
  });

  it("心跳上报间隔必须落在 Cron Monitor 的 2 分钟判定裕度内，杜绝窗口间隙误报", () => {
    // 排程为 */5 分钟、checkin_margin 为 2 分钟：间隔一旦大于裕度，
    // 必然跨过 [T, T+2min] 之外的间隙被判定为 missed check-in。
    const CHECKIN_MARGIN_MS = 2 * 60_000;
    expect(SERVER_HEARTBEAT_MONITOR_SLUG).toBe("bakagame-server-heartbeat");
    expect(SERVER_HEARTBEAT_INTERVAL_MS).toBeGreaterThan(0);
    expect(SERVER_HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(CHECKIN_MARGIN_MS);
  });

  describe("已初始化状态的上下文注入与异常上报", () => {
    beforeEach(() => {
      const initSpy = spyOn(Sentry, "init").mockImplementation((() => {}) as any);
      initServerSentry(createMockEnv());
      initSpy.mockRestore();
    });

    it("captureServerException 正确注入 traceId / connectionId / roomId tags 与 extras", () => {
      const tags: Record<string, string> = {};
      let extras: Record<string, unknown> | undefined;

      const mockScope = {
        setTag: (k: string, v: string) => {
          tags[k] = v;
          return mockScope;
        },
        setExtras: (ext: Record<string, unknown>) => {
          extras = ext;
          return mockScope;
        },
      };

      const withScopeSpy = spyOn(Sentry, "withScope").mockImplementation(((fn: (scope: unknown) => unknown) => {
        return fn(mockScope) as ReturnType<typeof Sentry.withScope>;
      }) as any);
      const captureSpy = spyOn(Sentry, "captureException").mockImplementation(() => "");

      const testError = new Error("Database connection timeout");
      const context = {
        traceId: "trace-abc-123",
        connectionId: "conn-xyz-456",
        roomId: "room-789",
        query: "SELECT 1",
      };

      captureServerException(testError, context);

      expect(withScopeSpy).toHaveBeenCalled();
      expect(captureSpy).toHaveBeenCalledWith(testError);
      expect(tags.traceId).toBe("trace-abc-123");
      expect(tags.connectionId).toBe("conn-xyz-456");
      expect(tags.roomId).toBe("room-789");
      expect(extras).toEqual(context);

      withScopeSpy.mockRestore();
      captureSpy.mockRestore();
    });

    it("captureServerException 在无 context 时安全上报", () => {
      const withScopeSpy = spyOn(Sentry, "withScope").mockImplementation(((fn: (scope: unknown) => unknown) => {
        const dummyScope = { setTag: () => dummyScope, setExtras: () => dummyScope };
        return fn(dummyScope) as ReturnType<typeof Sentry.withScope>;
      }) as any);
      const captureSpy = spyOn(Sentry, "captureException").mockImplementation(() => "");

      const err = new Error("Simple error");
      captureServerException(err);

      expect(captureSpy).toHaveBeenCalledWith(err);

      withScopeSpy.mockRestore();
      captureSpy.mockRestore();
    });

    it("captureServerMessage 正确注入 tags 并指定 level", () => {
      const tags: Record<string, string> = {};
      let extras: Record<string, unknown> | undefined;

      const mockScope = {
        setTag: (k: string, v: string) => {
          tags[k] = v;
          return mockScope;
        },
        setExtras: (ext: Record<string, unknown>) => {
          extras = ext;
          return mockScope;
        },
      };

      const withScopeSpy = spyOn(Sentry, "withScope").mockImplementation(((fn: (scope: unknown) => unknown) => {
        return fn(mockScope) as ReturnType<typeof Sentry.withScope>;
      }) as any);
      const captureSpy = spyOn(Sentry, "captureMessage").mockImplementation(() => "");

      captureServerMessage("High memory alert", "warning", {
        traceId: "tr-alert",
        memoryUsage: "92%",
      });

      expect(captureSpy).toHaveBeenCalledWith("High memory alert", "warning");
      expect(tags.traceId).toBe("tr-alert");
      expect(extras).toEqual({ traceId: "tr-alert", memoryUsage: "92%" });

      withScopeSpy.mockRestore();
      captureSpy.mockRestore();
    });
  });

  describe("flushServerSentry & closeServerSentry 优雅停机排空", () => {
    beforeEach(() => {
      const initSpy = spyOn(Sentry, "init").mockImplementation((() => {}) as any);
      initServerSentry(createMockEnv());
      initSpy.mockRestore();
    });

    it("flushServerSentry 成功排空缓冲事件", async () => {
      const flushSpy = spyOn(Sentry, "flush").mockResolvedValue(true);
      const result = await flushServerSentry(1500);
      expect(result).toBe(true);
      expect(flushSpy).toHaveBeenCalledWith(1500);
      flushSpy.mockRestore();
    });

    it("flushServerSentry 发生异常时平滑降级返回 false", async () => {
      const flushSpy = spyOn(Sentry, "flush").mockRejectedValue(new Error("Network down"));
      const result = await flushServerSentry(1500);
      expect(result).toBe(false);
      flushSpy.mockRestore();
    });

    it("closeServerSentry 成功关闭并重置初始化状态", async () => {
      const closeSpy = spyOn(Sentry, "close").mockResolvedValue(true);
      expect(isServerSentryEnabled()).toBe(true);

      const result = await closeServerSentry(2000);
      expect(result).toBe(true);
      expect(closeSpy).toHaveBeenCalledWith(2000);
      expect(isServerSentryEnabled()).toBe(false);

      closeSpy.mockRestore();
    });

    it("closeServerSentry 发生异常时安全置为未启用并返回 false", async () => {
      const closeSpy = spyOn(Sentry, "close").mockRejectedValue(new Error("Close timeout"));
      const result = await closeServerSentry(1000);
      expect(result).toBe(false);
      expect(isServerSentryEnabled()).toBe(false);
      closeSpy.mockRestore();
    });
  });
});


describe("服务端遥测统一脱敏出口", () => {
  afterEach(() => { _resetServerSentryForTest(); });

  it("递归保留 Error 诊断、共享引用与循环 cause，同时屏蔽原始 sample", () => {
    const error = new Error("upstream token=dummy-private-token");
    error.cause = error;
    const shared = { password: "dummy-password", roomId: "room-safe" };
    const cleaned = redactData({ error, left: shared, right: shared,
      sample: '{"cookie":"dummy-cookie"', url: "https://example.com/?token=dummy-query&song=1" }) as any;
    expect(cleaned.error.errorName).toBe("Error");
    expect(cleaned.error.stack).toContain("Error:");
    expect(cleaned.error.cause).toBe("[CIRCULAR]");
    expect(cleaned.left).toEqual(cleaned.right);
    expect(cleaned.left.roomId).toBe("room-safe");
    for (const secret of ["dummy-private-token", "dummy-password", "dummy-cookie", "dummy-query"])
      expect(JSON.stringify(cleaned)).not.toContain(secret);
    expect(cleaned.url).toContain("song=1");
    expect(describeError(error).cause).toBe("[CIRCULAR]");
  });

  it("原生 beforeSend / beforeSendLog 清理非 wrapper 事件且保留完整异常栈结构", async () => {
    let options: NonNullable<Parameters<typeof Sentry.init>[0]> | undefined;
    const init = spyOn(Sentry, "init").mockImplementation((input) => { options = input; return undefined; });
    try {
      initServerSentry(createMockEnv());
      const frames = Array.from({ length: 40 }, (_, i) => ({ function: `frame${i}`, lineno: i,
        filename: "https://example.com/module?password=dummy-query", vars: { sessionToken: "dummy-session-long" } }));
      const event: any = { event_id: "dummy-event", extra: { nested: { password: "dummy-password", cookie: "dummy-cookie-long" } },
        exception: { values: [{ type: "Error", value: "authorization: Bearer dummy-bearer-value", stacktrace: { frames } }] },
        breadcrumbs: [{ category: "http", data: { cookie: "dummy-cookie-long" }, message: "password=dummy-password" }] };
      const result = await options!.beforeSend!(event, {});
      expect((result as any).exception.values[0].stacktrace.frames).toHaveLength(40);
      expect((result as any).exception.values[0].stacktrace.frames[39].function).toBe("frame39");
      expect((result as any).event_id).toBe("dummy-event");
      for (const secret of ["dummy-password", "dummy-cookie-long", "dummy-session-long", "dummy-bearer-value", "dummy-query"])
        expect(JSON.stringify(result)).not.toContain(secret);
      const log = options!.beforeSendLog!({ level: "warn", message: "token=dummy-log-token", attributes: { nested: { password: "dummy-password" } } });
      expect(log!.level).toBe("warn");
      expect(JSON.stringify(log)).not.toContain("dummy-log-token");
      expect(JSON.stringify(log)).not.toContain("dummy-password");
    } finally { init.mockRestore(); }
  });

  it("wrapper 日志和 extras 在 SDK 调用前已清理；异常本体交由 beforeSend 保留分组", () => {
    const init = spyOn(Sentry, "init").mockImplementation(() => undefined);
    const logs = spyOn(Sentry.logger, "error").mockImplementation(() => undefined);
    let extras: Record<string, unknown> | undefined;
    const scope = { setTag: () => scope, setExtras: (input: Record<string, unknown>) => { extras = input; return scope; } };
    const scoped = spyOn(Sentry, "withScope").mockImplementation(((fn: any) => fn(scope)) as any);
    const exception = spyOn(Sentry, "captureException").mockImplementation(() => "");
    try {
      initServerSentry(createMockEnv());
      const context = { password: "dummy-password", nested: { cookie: "dummy-cookie-long" }, traceId: "trace-safe" };
      captureServerLog("password=dummy-password", "error", context);
      expect(JSON.stringify(logs.mock.calls)).not.toContain("dummy-password");
      const error = new Error("failure");
      captureServerException(error, context);
      expect(exception).toHaveBeenCalledWith(error);
      expect(JSON.stringify(extras)).not.toContain("dummy-cookie-long");
      expect(extras!.traceId).toBe("trace-safe");
    } finally { init.mockRestore(); logs.mockRestore(); scoped.mockRestore(); exception.mockRestore(); }
  });
});

it("无 Git 元数据时 release 缺失保持可见，不伪造 canonical revision", () => {
  const git = spyOn(Bun, "spawnSync").mockImplementation((() => { throw new Error("git unavailable"); }) as any);
  try { expect(resolveServerRelease()).toBeUndefined(); }
  finally { git.mockRestore(); }
});
