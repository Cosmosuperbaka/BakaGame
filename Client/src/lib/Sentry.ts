import * as Sentry from "@sentry/react";
import commitHistory from "virtual:commit-history";
import changelog from "@/data/changelog.json";
import { resolveLatestVersion } from "@/lib/Changelog";
import { resolveServerUrl } from "@/lib/ServerEndpoint";

export interface SentrySdkDriver {
  init: (options: Sentry.BrowserOptions) => void;
  captureException: (error: unknown) => string;
  captureMessage: (message: string, level?: Sentry.SeverityLevel) => string;
  withScope: (callback: (scope: Sentry.Scope) => void) => void;
}

const defaultDriver: SentrySdkDriver = {
  init: (opts) => Sentry.init(opts),
  captureException: (err) => Sentry.captureException(err),
  captureMessage: (msg, lvl) => Sentry.captureMessage(msg, lvl),
  withScope: (cb) => Sentry.withScope(cb),
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
      (value.stacktrace?.frames ?? []).some((frame) => frame.function === "parseModule"),
  );

export const initClientSentry = (
  options?: SentryOptions,
  driver: SentrySdkDriver = defaultDriver,
): void => {
  if (isInitialized) return;

  const dsn = options?.dsn ?? import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;

  activeDriver = driver;

  // Sentry 隧道同样走同源相对路径：既避免跨域，也不再需要被 AdBlock 拦的第三方域名。
  const tunnel = resolveServerUrl("/api/monitoring/sentry", options?.serverUrl);

  activeDriver.init({
    dsn,
    tunnel,
    environment: import.meta.env.MODE,
    release: commitHistory.currentCommit !== "dev"
      ? `V${resolveLatestVersion(changelog.entries) ?? "0.0.0"}（${commitHistory.currentCommit}）`
      : undefined,
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
      "NetworkError when attempting to fetch resource.",
      "The play() request was interrupted by a new load request.",
      "The play() request was interrupted by a call to pause().",
      // 各浏览器引擎对网络与模块加载失败的文案完全不同，必须逐一覆盖：
      // Firefox 报 "NetworkError when attempting to fetch resource."，Safari 报 "Load failed"，
      // Chromium 报 "Failed to fetch dynamically imported module" / "Loading chunk N failed"，
      // WebKit 报 "Importing a module script failed"。这些都属于部署切换或弱网抖动，
      // 已由 retryLazyImport 自动重载恢复，无需重复上报。
      /^Load failed\b/i,
      /Failed to fetch dynamically imported module/i,
      /error loading dynamically imported module/i,
      /Loading chunk [\d]+ failed/i,
      /Importing a module script failed/i,
      // 浏览器翻译插件等第三方扩展会直接改写 DOM，破坏 React 的父子节点不变量。
      // 该异常完全由外部注入引起，重载即恢复，与应用代码无关。
      /Failed to execute 'removeChild' on 'Node'/i,
    ],
    beforeSend: (event) => (isModuleScriptParseFailure(event) ? null : event),
  });

  isInitialized = true;
};

export const captureClientException = (
  error: unknown,
  context?: Record<string, unknown>,
): void => {
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
  context?: Record<string, unknown>,
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

type ClientLogLevel = "info" | "warning" | "error";

const toClientAttributes = (
  context?: Record<string, unknown>,
): Record<string, string | number | boolean | null> | undefined => {
  if (!context) return undefined;
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) =>
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean",
    ),
  ) as Record<string, string | number | boolean | null>;
};

export const captureClientLog = (
  message: string,
  level: ClientLogLevel = "info",
  context?: Record<string, unknown>,
): void => {
  if (!isInitialized) return;
  const attributes = toClientAttributes(context);
  if (level === "error") Sentry.logger.error(message, attributes as never);
  else if (level === "warning") Sentry.logger.warn(message, attributes as never);
  else Sentry.logger.info(message, attributes as never);
};

export const countClientMetric = (
  name: string,
  value = 1,
  attributes?: Record<string, string | number | boolean>,
): void => {
  if (!isInitialized || !Number.isFinite(value)) return;
  Sentry.metrics.count(name, value, { attributes });
};

export const recordClientMetric = (
  name: string,
  value: number,
  attributes?: Record<string, string | number | boolean>,
): void => {
  if (!isInitialized || !Number.isFinite(value)) return;
  Sentry.metrics.distribution(name, value, { unit: "millisecond", attributes });
};

export const withClientSpan = async <T>(
  name: string,
  callback: (span: Sentry.Span) => Promise<T> | T,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> => {
  return Sentry.startSpan({ name, op: "bakagame.client", attributes }, callback);
};

/** 单测重置辅助函数，消除测试间的状态污染 */
export const resetClientSentryForTest = (): void => {
  isInitialized = false;
  activeDriver = defaultDriver;
};
