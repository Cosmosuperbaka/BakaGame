import * as Sentry from "@sentry/react";
import commitHistory from "virtual:commit-history";
// 展示版本号构建期从 changelog.json 解析，遥测初始化不背整份日志。
import appVersion from "virtual:app-version";
import { resolveServerUrl } from "@/lib/ServerEndpoint";
import { bakaChannel, bakaClientType } from "@/lib/BakaChannel";
import { isSelfHealedModuleLoadError } from "@/lib/LazyImport";

export type ClientLogLevel = "info" | "warning" | "error";

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
  captureMessage: (message: string, level?: Sentry.SeverityLevel) => string;
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

const defaultDriver: SentrySdkDriver = {
  init: (opts) => Sentry.init(opts),
  captureException: (err) => Sentry.captureException(err),
  captureMessage: (msg, lvl) => Sentry.captureMessage(msg, lvl),
  withScope: (cb) => Sentry.withScope(cb),
  log: (level, message, attributes) => {
    const attrs = attributes as never;
    if (level === "error") Sentry.logger.error(message, attrs);
    else if (level === "warning") Sentry.logger.warn(message, attrs);
    else Sentry.logger.info(message, attrs);
  },
  metricCount: (name, value, attributes) => Sentry.metrics.count(name, value, { attributes }),
  metricDistribution: (name, value, attributes) =>
    Sentry.metrics.distribution(name, value, { unit: "millisecond", attributes }),
  startSpan: async (name, attributes, callback) =>
    Sentry.startSpan({ name, op: "bakagame.client", attributes }, callback),
  makeTransport: (options) =>
    wrapTelemetryTransport(Sentry.makeFetchTransport(options), notifyClientTelemetryEgressFailure),
};

let activeDriver: SentrySdkDriver = defaultDriver;
let isInitialized = false;

export const isClientSentryEnabled = (): boolean => isInitialized;

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

/** 与事件侧 ignoreErrors 同类的良性文案；日志通道按同一边界过滤，避免比事件侧更吵或更钝。 */
const BENIGN_CLIENT_NOISE_TEXT =
  /(Failed to fetch dynamically imported module|error loading dynamically imported module|Loading chunk [\d]+ failed|Importing a module script failed|ResizeObserver loop|removeChild' on 'Node'|Transition was (aborted|skipped)|play\(\) request was interrupted)/i;

export const initClientSentry = (
  options?: SentryOptions,
  driver: SentrySdkDriver = defaultDriver
): void => {
  if (isInitialized) return;

  const dsn = options?.dsn ?? import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;

  activeDriver = driver;

  // Sentry 隧道同样走同源相对路径：既避免跨域，也不再需要被 AdBlock 拦的第三方域名。
  const tunnel = resolveServerUrl("/api/monitoring/sentry", options?.serverUrl);

  // 壳与网页必须可区分（F77）：标签只取自壳在页面加载前注入的只读身份
  // __BAKA_CHANNEL__（clientType / clientVersion 与服务端 ClientChannel 握手比对的
  // 是同一权威字段），网页环境探测不到该对象即记为 web。不硬编码任何现网标识。
  const channel = bakaChannel();

  activeDriver.init({
    dsn,
    tunnel,
    environment: import.meta.env.MODE,
    release:
      commitHistory.currentCommit !== "dev"
        ? `V${appVersion || "0.0.0"}（${commitHistory.currentCommit}）`
        : undefined,
    // 壳版本与网页发布号是两套命名空间，混进 release 会互相污染；壳身份版本放 dist。
    dist: channel ? `${channel.clientType}@${channel.clientVersion}` : undefined,
    initialScope: {
      tags: { surface: bakaClientType() },
    },
    tracesSampleRate: options?.tracesSampleRate ?? 0.1,
    replaysSessionSampleRate: options?.replaysSessionSampleRate ?? 0.1,
    replaysOnErrorSampleRate: options?.replaysOnErrorSampleRate ?? 1,
    enableLogs: true,
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }),
      Sentry.consoleLoggingIntegration({ levels: ["error", "warn"] }),
    ],
    ignoreErrors: [
      "ResizeObserver loop limit exceeded",
      "ResizeObserver loop completed with undelivered notifications",
      "The play() request was interrupted by a new load request.",
      "The play() request was interrupted by a call to pause().",
      // 名单只收「模块/分块加载失败」这一类别的文案——这些字样只可能由 import()
      // 或分块加载本身抛出，错误类别与文案绑定：Chromium "Failed to fetch
      // dynamically imported module"、Firefox "error loading dynamically imported
      // module"、WebKit "Importing a module script failed"、webpack
      // "Loading chunk N failed"。
      // 注意：Firefox/Safari 的通用网络失败文案（"NetworkError when attempting to
      // fetch resource." / "Load failed"）**不收进名单**——它们同样由普通 API fetch
      // 失败抛出，入名单会让弱网、CORS 与边缘故障在这两个引擎整体失明，而同类故障
      // 在 Chromium（"Failed to fetch"，从未入名单）依旧可见，跨引擎结局不对称。
      // 真正经 retryLazyImport 自愈重载恢复的动态导入失败会在错误对象上留下标记，
      // 由下方 beforeSend 按标记丢弃（见 LazyImport.ts）。
      /Failed to fetch dynamically imported module/i,
      /error loading dynamically imported module/i,
      /Loading chunk [\d]+ failed/i,
      /Importing a module script failed/i,
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
      // 已被 retryLazyImport 自愈重载吸收的模块加载失败不再上报（页面即将重载，非用户可见缺陷）。
      if (isSelfHealedModuleLoadError(hint?.originalException)) return null;
      return event;
    },
    beforeSendLog: (log) => (BENIGN_CLIENT_NOISE_TEXT.test(String(log.message)) ? null : log),
    transport: (transportOptions) => activeDriver.makeTransport(transportOptions),
  });

  isInitialized = true;
};

export const captureClientException = (error: unknown, context?: Record<string, unknown>): void => {
  if (!isInitialized) return;

  activeDriver.withScope((scope) => {
    if (context) {
      if (context.traceId && typeof context.traceId === "string") {
        scope.setTag("traceId", context.traceId);
      }
      scope.setExtras(context);
    }
    activeDriver.captureException(error);
  });
};

export const captureClientMessage = (
  message: string,
  level: Sentry.SeverityLevel = "info",
  context?: Record<string, unknown>
): void => {
  if (!isInitialized) return;

  activeDriver.withScope((scope) => {
    if (context) {
      if (context.traceId && typeof context.traceId === "string") {
        scope.setTag("traceId", context.traceId);
      }
      scope.setExtras(context);
    }
    activeDriver.captureMessage(message, level);
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
  if (!isInitialized) return;
  activeDriver.log(level, message, toClientAttributes(context));
};

export const countClientMetric = (
  name: string,
  value = 1,
  attributes?: Record<string, string | number | boolean>
): void => {
  if (!isInitialized || !Number.isFinite(value)) return;
  activeDriver.metricCount(name, value, attributes);
};

export const recordClientMetric = (
  name: string,
  value: number,
  attributes?: Record<string, string | number | boolean>
): void => {
  if (!isInitialized || !Number.isFinite(value)) return;
  activeDriver.metricDistribution(name, value, attributes);
};

export const withClientSpan = async <T>(
  name: string,
  callback: (span: Sentry.Span) => Promise<T> | T,
  attributes?: Record<string, string | number | boolean>
): Promise<T> => {
  return activeDriver.startSpan(name, attributes, callback);
};

/** 单测重置辅助函数，消除测试间的状态污染 */
export const resetClientSentryForTest = (): void => {
  isInitialized = false;
  activeDriver = defaultDriver;
  lastEgressFailureNoticeAt = 0;
};
