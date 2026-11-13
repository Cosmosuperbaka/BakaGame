// 只引类型：SDK 本体（含 Replay 与 Tracing，约占入口脚本三成）留在 SentryRuntime，空闲时才下载。
import type * as Sentry from "@sentry/react";
import { currentCommit } from "virtual:build-info";
// 展示版本号构建期从 changelog.json 解析，遥测初始化不背整份日志。
import appVersion from "virtual:app-version";
import { resolveServerUrl } from "@/lib/ServerEndpoint";
import { bakaChannel, bakaClientType } from "@/lib/BakaChannel";
import { formatReleaseName } from "@/lib/ReleaseName";

export type ClientLogLevel = "info" | "warning" | "error";

/** 调用方实际会用到的跨度能力；SDK 还没加载时由惰性实现顶替，调用方不必区分。 */
export type ClientSpan = Pick<Sentry.Span, "spanContext" | "setAttribute" | "setStatus">;

/** 传输相关类型别名：@sentry/react 未直接导出 `Transport`，从 SDK 运行时符号派生。 */
export type ClientSentryTransport = ReturnType<typeof Sentry.makeFetchTransport>;
export type ClientSentryTransportOptions = Parameters<typeof Sentry.makeFetchTransport>[0];

/**
 * SDK 出口接缝：客户端所有对外遥测调用（事件、日志、指标、Span、传输）都必须
 * 经过这里。测试注入假 driver 后不触达真实 SDK，因此夹具天然零出口，
 * 不依赖「恰好未初始化」这类偶然守卫。
 */
export interface SentrySdkDriver {
  init: (options: Sentry.BrowserOptions) => void;
  captureException: (error: unknown) => string;
  withScope: (callback: (scope: Sentry.Scope) => void) => void;
  log: (
    level: ClientLogLevel,
    message: string,
    attributes?: Record<string, string | number | boolean | null>
  ) => void;
  metricCount: (
    name: string,
    value: number,
    attributes?: Record<string, string | number | boolean>
  ) => void;
  metricDistribution: (
    name: string,
    value: number,
    attributes?: Record<string, string | number | boolean>
  ) => void;
  startSpan: <T>(
    name: string,
    attributes: Record<string, string | number | boolean> | undefined,
    callback: (span: Sentry.Span) => Promise<T> | T
  ) => Promise<T>;
  makeTransport: (options: ClientSentryTransportOptions) => ClientSentryTransport;
}

/**
 * 遥测出口自身故障的本地信号：客户端全部事件都经同源隧道上报，隧道一旦 5xx 或
 * 网络失败，事件只会静默丢失——「无事件」会被误读为「无故障」。出口故障无法
 * 再经同一条出口上报，因此以节流 console.warn 留本地可见信号（壳日志可抓取），
 * 恢复前请勿把零事件当作健康证明。
 */
const TELEMETRY_EGRESS_NOTICE_INTERVAL_MS = 60_000;
let lastEgressFailureNoticeAt = 0;

export const notifyClientTelemetryEgressFailure = (reason: string): void => {
  const now = Date.now();
  if (now - lastEgressFailureNoticeAt < TELEMETRY_EGRESS_NOTICE_INTERVAL_MS) return;
  lastEgressFailureNoticeAt = now;
  console.warn(
    `[Sentry] 遥测出口故障（${reason}）：客户端事件正在丢失，「无事件」不等于「无故障」。`
  );
};

/** 包一层传输：隧道 HTTP ≥400 或请求本身失败时发出可见信号，其余行为原样透传。 */
export const wrapTelemetryTransport = (
  base: ClientSentryTransport,
  onFailure: (reason: string) => void
): ClientSentryTransport => ({
  send: async (request: Parameters<ClientSentryTransport["send"]>[0]) => {
    try {
      const response = await base.send(request);
      const status = (response as { statusCode?: number } | undefined)?.statusCode;
      if (typeof status === "number" && status >= 400) {
        onFailure(`隧道返回 HTTP ${status}`);
      }
      return response;
    } catch (error) {
      onFailure(error instanceof Error ? error.message : String(error));
      throw error;
    }
  },
  flush: (timeout?: number) => base.flush(timeout),
});

/** 加载默认 driver（真实 SDK）；失败时由调用方降级，不在这里重试。 */
const loadDefaultDriver = (): Promise<SentrySdkDriver> =>
  import("./SentryRuntime").then((runtime) => runtime.createSentryDriver());

type SentryState = "off" | "loading" | "ready" | "failed";
let state: SentryState = "off";
let activeDriver: SentrySdkDriver | undefined;

/** SDK 加载期间排队的出口调用上限：超出的丢弃，加载期很短，不值得无界缓存。 */
const MAX_PENDING_CALLS = 100;
/** 加载完成前发生的未捕获错误的缓存上限。 */
const MAX_EARLY_ERRORS = 20;
let pendingCalls: Array<(driver: SentrySdkDriver) => void> = [];
let earlyErrors: unknown[] = [];
let stopEarlyErrorBuffer: (() => void) | undefined;

/** 已初始化或正在加载：出口调用会被接受（加载期间排队）。 */
export const isClientSentryEnabled = (): boolean => state === "loading" || state === "ready";

const dispatch = (call: (driver: SentrySdkDriver) => void): void => {
  if (state === "ready" && activeDriver) call(activeDriver);
  else if (state === "loading" && pendingCalls.length < MAX_PENDING_CALLS) pendingCalls.push(call);
};

export interface SentryOptions {
  dsn?: string;
  serverUrl?: string;
  tracesSampleRate?: number;
  replaysSessionSampleRate?: number;
  replaysOnErrorSampleRate?: number;
}

/**
 * 模块脚本解析失败只可能来自资源投递异常：浏览器拉到的响应体并非合法 JS
 * （边缘节点返回的畸形或占位响应），而不是构建产物本身 —— 产物一旦有语法错误，
 * 构建期就会直接失败。该情形无法用 ignoreErrors 剔除（该配置只匹配异常文案，
 * 而 "Unexpected token '{'" 与 JSON 解析错误文案同形），因此按栈帧精确判定：
 * 只有浏览器内建 parseModule 帧才说明是模块脚本解析失败。
 */
const isModuleScriptParseFailure = (event: Sentry.Event): boolean =>
  (event.exception?.values ?? []).some(
    (value) =>
      value.type === "SyntaxError" &&
      (value.stacktrace?.frames ?? []).some((frame) => frame.function === "parseModule")
  );

/**
 * 国产手机浏览器会向页面注入广告 SDK，其加载失败以「带 code 与 message 的普通对象」
 * 形式变成未处理拒绝，与应用代码无关，且没有堆栈可归因，上报侧直接丢弃。
 */
export function isInjectedBrowserAdRejection(reason: unknown): boolean {
  if (typeof reason !== "object" || reason === null || reason instanceof Error) return false;
  const { code, message } = reason as { code?: unknown; message?: unknown };
  return typeof code === "number" && typeof message === "string" && /^Ad loaded/i.test(message);
}

/** 与事件侧 ignoreErrors 同类的良性文案；日志通道按同一边界过滤，避免比事件侧更吵或更钝。 */
const BENIGN_CLIENT_NOISE_TEXT =
  /(ResizeObserver loop|removeChild' on 'Node'|Transition was (aborted|skipped)|play\(\) request was interrupted)/i;

/**
 * 把 window 级未捕获错误与未处理拒绝先缓存起来：SDK 的全局处理器要等它加载完才装上，
 * 这段空窗里的错误不能丢，加载后补报。
 */
const startEarlyErrorBuffer = (): void => {
  const onError = (event: ErrorEvent): void => {
    if (earlyErrors.length < MAX_EARLY_ERRORS) earlyErrors.push(event.error ?? event.message);
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    if (earlyErrors.length < MAX_EARLY_ERRORS) earlyErrors.push(event.reason);
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  stopEarlyErrorBuffer = () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    stopEarlyErrorBuffer = undefined;
  };
};

/** 页面载入完成后、浏览器空闲时再开始下载 SDK，不与首屏资源抢带宽与主线程。 */
const whenIdle = (task: () => void): void => {
  const run = (): void => {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(task, { timeout: 3000 });
    } else {
      window.setTimeout(task, 1);
    }
  };
  if (document.readyState === "complete") run();
  else window.addEventListener("load", run, { once: true });
};

const replayEarlyErrors = (driver: SentrySdkDriver): void => {
  const errors = earlyErrors;
  earlyErrors = [];
  for (const error of errors) {
    driver.withScope((scope) => {
      scope.setTag("early_error", "true");
      driver.captureException(error);
    });
  }
};

const buildInitOptions = (
  dsn: string,
  options: SentryOptions | undefined,
  driver: SentrySdkDriver
): Sentry.BrowserOptions => {
  // Sentry 隧道同样走同源相对路径：既避免跨域，也不再需要被 AdBlock 拦的第三方域名。
  const tunnel = resolveServerUrl("/api/monitoring/sentry", options?.serverUrl);

  // 壳与网页必须可区分（F77）：标签只取自壳在页面加载前注入的只读身份
  // __BAKA_CHANNEL__（clientType / clientVersion 与服务端 ClientChannel 握手比对的
  // 是同一权威字段），网页环境探测不到该对象即记为 web。不硬编码任何现网标识。
  const channel = bakaChannel();

  return {
    dsn,
    tunnel,
    environment: import.meta.env.MODE,
    release: currentCommit !== "dev" ? formatReleaseName(appVersion, currentCommit) : undefined,
    // 壳版本与网页发布号是两套命名空间，混进 release 会互相污染；壳身份版本放 dist。
    dist: channel ? `${channel.clientType}@${channel.clientVersion}` : undefined,
    initialScope: {
      tags: { surface: bakaClientType() },
    },
    tracesSampleRate: options?.tracesSampleRate ?? 0.1,
    replaysSessionSampleRate: options?.replaysSessionSampleRate ?? 0.1,
    replaysOnErrorSampleRate: options?.replaysOnErrorSampleRate ?? 1,
    enableLogs: true,
    // integrations（Tracing / Replay / 控制台日志）由 SentryRuntime 在加载 SDK 时装配，这里不碰 SDK。
    ignoreErrors: [
      "ResizeObserver loop limit exceeded",
      "ResizeObserver loop completed with undelivered notifications",
      "The play() request was interrupted by a new load request.",
      "The play() request was interrupted by a call to pause().",
      // 分块加载失败不在名单里：能自愈的（会话首次）由 `ChunkRecovery` 取消预加载失败事件后
      // 重载，错误根本不会抛出；自愈之后仍失败的是玩家真正看得见的故障，必须照报。
      // Firefox/Safari 的通用网络失败文案（"NetworkError when attempting to fetch
      // resource." / "Load failed"）同样不收进名单：它们也由普通 API fetch 失败抛出，
      // 入名单会让弱网、CORS 与边缘故障在这两个引擎整体失明。
      // 浏览器翻译插件等第三方扩展会直接改写 DOM，破坏 React 的父子节点不变量。
      // 该异常完全由外部注入引起，重载即恢复，与应用代码无关。
      /Failed to execute 'removeChild' on 'Node'/i,
      // Chromium 在标签页隐藏、导航打断或新旧过渡交叠时会中止 View Transition。
      // 导航本身照常完成，属浏览器级良性中断，不是页面缺陷。
      "Transition was aborted because of invalid state",
      /Transition was skipped/i,
    ],
    beforeSend: (event, hint) => {
      if (isModuleScriptParseFailure(event)) return null;
      if (isInjectedBrowserAdRejection(hint?.originalException)) return null;
      return event;
    },
    beforeSendLog: (log) => (BENIGN_CLIENT_NOISE_TEXT.test(String(log.message)) ? null : log),
    transport: (transportOptions) => driver.makeTransport(transportOptions),
  };
};

/**
 * 初始化遥测。没有配置上报地址时什么都不加载。传入 driver 表示同步初始化（测试注入假 driver）；
 * 默认则在页面空闲时才下载真实 SDK：加载期间出口调用排队、未捕获错误缓存，加载完成后补发；
 * 加载失败不重试，应用照常运行，只留一条本机可见告警。
 */
export const initClientSentry = (
  options?: SentryOptions,
  source: SentrySdkDriver | (() => Promise<SentrySdkDriver>) = loadDefaultDriver
): void => {
  if (state !== "off") return;

  const dsn = options?.dsn ?? import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;

  if (typeof source !== "function") {
    source.init(buildInitOptions(dsn, options, source));
    activeDriver = source;
    state = "ready";
    return;
  }

  state = "loading";
  startEarlyErrorBuffer();
  whenIdle(() => {
    source().then(
      (driver) => {
        driver.init(buildInitOptions(dsn, options, driver));
        activeDriver = driver;
        state = "ready";
        stopEarlyErrorBuffer?.();
        replayEarlyErrors(driver);
        const calls = pendingCalls;
        pendingCalls = [];
        for (const call of calls) call(driver);
      },
      (error: unknown) => {
        state = "failed";
        stopEarlyErrorBuffer?.();
        earlyErrors = [];
        pendingCalls = [];
        notifyClientTelemetryEgressFailure(
          `SDK 加载失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    );
  });
};

export const captureClientException = (error: unknown, context?: Record<string, unknown>): void => {
  dispatch((driver) => {
    driver.withScope((scope) => {
      if (context) {
        if (context.traceId && typeof context.traceId === "string") {
          scope.setTag("traceId", context.traceId);
        }
        scope.setExtras(context);
      }
      driver.captureException(error);
    });
  });
};

const toClientAttributes = (
  context?: Record<string, unknown>
): Record<string, string | number | boolean | null> | undefined => {
  if (!context) return undefined;
  return Object.fromEntries(
    Object.entries(context).filter(
      ([, value]) =>
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
    )
  ) as Record<string, string | number | boolean | null>;
};

export const captureClientLog = (
  message: string,
  level: ClientLogLevel = "info",
  context?: Record<string, unknown>
): void => {
  dispatch((driver) => driver.log(level, message, toClientAttributes(context)));
};

export const countClientMetric = (
  name: string,
  value = 1,
  attributes?: Record<string, string | number | boolean>
): void => {
  if (!Number.isFinite(value)) return;
  dispatch((driver) => driver.metricCount(name, value, attributes));
};

export const recordClientMetric = (
  name: string,
  value: number,
  attributes?: Record<string, string | number | boolean>
): void => {
  if (!Number.isFinite(value)) return;
  dispatch((driver) => driver.metricDistribution(name, value, attributes));
};

/** SDK 未就绪（未配置、加载中、加载失败）时顶替跨度：追踪号全零，调用方会自造标识。 */
const inertSpan: ClientSpan = {
  spanContext: () => ({ traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 }),
  setAttribute: () => inertSpan as never,
  setStatus: () => inertSpan as never,
};

export const withClientSpan = async <T>(
  name: string,
  callback: (span: ClientSpan) => Promise<T> | T,
  attributes?: Record<string, string | number | boolean>
): Promise<T> => {
  if (state === "ready" && activeDriver) return activeDriver.startSpan(name, attributes, callback);
  return callback(inertSpan);
};

/** 单测重置辅助函数，消除测试间的状态污染 */
export const resetClientSentryForTest = (): void => {
  stopEarlyErrorBuffer?.();
  state = "off";
  activeDriver = undefined;
  pendingCalls = [];
  earlyErrors = [];
  lastEgressFailureNoticeAt = 0;
};
