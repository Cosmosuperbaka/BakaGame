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
} from "../src/infrastructure/Sentry";

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
      process.env.SENTRY_RELEASE = "v2.0.0-rc1";
      const release = resolveServerRelease();
      expect(release).toMatch(/^V\d+\.\d+\.\d+（[0-9a-f]{7,}）$/);
      expect(release).not.toBe("v2.0.0-rc1");
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
