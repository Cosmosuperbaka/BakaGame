import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureClientException,
  captureClientLog,
  initClientSentry,
  isClientSentryEnabled,
  resetClientSentryForTest,
  withClientSpan,
  type ClientSentryTransport,
  type SentrySdkDriver,
} from "./Sentry";

const DSN = "https://mockkey@o000000.ingest.sentry.io/100001";

const createDriver = () => {
  const captured: unknown[] = [];
  const tags: Array<[string, string]> = [];
  const driver: SentrySdkDriver = {
    init: vi.fn(),
    captureException: vi.fn((error: unknown) => {
      captured.push(error);
      return "id";
    }),
    withScope: vi.fn((callback) =>
      callback({ setTag: (k: string, v: string) => tags.push([k, v]), setExtras: vi.fn() } as never)
    ),
    log: vi.fn(),
    metricCount: vi.fn(),
    metricDistribution: vi.fn(),
    startSpan: vi.fn(async (_name, _attributes, callback) => callback({} as never)),
    makeTransport: vi.fn(
      () => ({ send: vi.fn(), flush: vi.fn() }) as unknown as ClientSentryTransport
    ),
  };
  return { driver, captured, tags };
};

// 派发的是演示用错误事件：不拦下的话测试框架会把它当成真实的未捕获错误。
const swallow = (event: Event) => event.preventDefault();

const fireWindowError = (error: Error) => {
  window.addEventListener("error", swallow);
  window.dispatchEvent(
    new ErrorEvent("error", { error, message: error.message, cancelable: true })
  );
  window.removeEventListener("error", swallow);
};

const fireRejection = (reason: unknown) => {
  const event = new Event("unhandledrejection");
  Object.defineProperty(event, "reason", { value: reason });
  window.dispatchEvent(event);
};

describe("遥测 SDK 懒加载", () => {
  beforeEach(() => {
    resetClientSentryForTest();
  });
  afterEach(() => {
    resetClientSentryForTest();
    vi.restoreAllMocks();
  });

  it("加载完成前发生的未捕获错误与未处理拒绝，加载后补报", async () => {
    const { driver, captured, tags } = createDriver();
    let resolveLoad!: (value: SentrySdkDriver) => void;
    const loader = vi.fn(() => new Promise<SentrySdkDriver>((resolve) => (resolveLoad = resolve)));

    initClientSentry({ dsn: DSN }, loader);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));

    const early = new Error("加载前的脚本错误");
    const rejected = new Error("加载前的未处理拒绝");
    fireWindowError(early);
    fireRejection(rejected);
    expect(driver.captureException).not.toHaveBeenCalled();

    resolveLoad(driver);
    await vi.waitFor(() => expect(captured).toEqual([early, rejected]));
    expect(driver.init).toHaveBeenCalledTimes(1);
    expect(tags).toContainEqual(["early_error", "true"]);

    // 加载完成后缓存监听已卸掉：之后的错误由 SDK 自己的处理器负责，这里不再重复收。
    fireWindowError(new Error("加载后"));
    expect(captured).toHaveLength(2);
  });

  it("加载期间的异常、日志上报排队，加载后补发；跨度回调照常执行", async () => {
    const { driver } = createDriver();
    let resolveLoad!: (value: SentrySdkDriver) => void;
    const loader = vi.fn(() => new Promise<SentrySdkDriver>((resolve) => (resolveLoad = resolve)));
    initClientSentry({ dsn: DSN }, loader);
    expect(isClientSentryEnabled()).toBe(true);

    const error = new Error("加载期间的业务异常");
    captureClientException(error);
    captureClientLog("加载期间的日志", "warning");
    await expect(withClientSpan("WS x", (span) => span.spanContext().traceId)).resolves.toBe(
      "0".repeat(32)
    );
    expect(driver.log).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(loader).toHaveBeenCalled());
    resolveLoad(driver);
    await vi.waitFor(() => expect(driver.captureException).toHaveBeenCalledWith(error));
    expect(driver.log).toHaveBeenCalledWith("warning", "加载期间的日志", undefined);
  });

  it("没有配置上报地址时不加载任何上报代码，也不缓存错误", async () => {
    const loader = vi.fn();
    initClientSentry({ dsn: "" }, loader);
    fireWindowError(new Error("没人接收"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(loader).not.toHaveBeenCalled();
    expect(isClientSentryEnabled()).toBe(false);
  });

  it("加载失败时应用照常运行、只告警一次且不反复重试", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loader = vi.fn(() => Promise.reject(new Error("网络中断")));
    initClientSentry({ dsn: DSN }, loader);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(String(warn.mock.calls[0]?.[0])).toContain("SDK 加载失败");

    expect(() => captureClientException(new Error("失败后的异常"))).not.toThrow();
    await expect(withClientSpan("WS y", () => 42)).resolves.toBe(42);
    initClientSentry({ dsn: DSN }, loader);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(loader).toHaveBeenCalledTimes(1);
    expect(isClientSentryEnabled()).toBe(false);
  });
});
