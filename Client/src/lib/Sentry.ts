import * as Sentry from "@sentry/react";
import { DEFAULT_SERVER_URL } from "@/config/Constants";
import commitHistory from "virtual:commit-history";

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
  release?: string;
  serverUrl?: string;
  tracesSampleRate?: number;
  replaysSessionSampleRate?: number;
  replaysOnErrorSampleRate?: number;
  profilesSampleRate?: number;
}

export const initClientSentry = (
  options?: SentryOptions,
  driver: SentrySdkDriver = defaultDriver,
): void => {
  if (isInitialized) return;

  const dsn = options?.dsn ?? import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;

  activeDriver = driver;

  const rawUrl = options?.serverUrl ?? (import.meta.env.VITE_SERVER_URL || DEFAULT_SERVER_URL);
  const serverUrl = rawUrl.replace(/\/+$/, "");
  const tunnel = serverUrl ? `${serverUrl}/api/monitoring/sentry` : "/api/monitoring/sentry";

  activeDriver.init({
    dsn,
    tunnel,
    environment: import.meta.env.MODE,
    release:
      options?.release ??
      import.meta.env.VITE_SENTRY_RELEASE ??
      (commitHistory.currentCommit !== "dev" ? `bakagame-client@${commitHistory.currentCommit}` : undefined),
    tracesSampleRate: options?.tracesSampleRate ?? 0.1,
    replaysSessionSampleRate: options?.replaysSessionSampleRate ?? 0.1,
    replaysOnErrorSampleRate: options?.replaysOnErrorSampleRate ?? 1,
    profilesSampleRate: options?.profilesSampleRate ?? 0.1,
    enableLogs: true,
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }),
      Sentry.browserProfilingIntegration(),
      Sentry.consoleLoggingIntegration({ levels: ["error", "warn"] }),
    ],
    ignoreErrors: [
      "ResizeObserver loop limit exceeded",
      "ResizeObserver loop completed with undelivered notifications",
      "NetworkError when attempting to fetch resource.",
      "The play() request was interrupted by a new load request.",
      "The play() request was interrupted by a call to pause().",
    ],
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
