import * as Sentry from "@sentry/react";
import { DEFAULT_SERVER_URL } from "@/config/Constants";

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
    tracesSampleRate: options?.tracesSampleRate ?? 0.1,
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

/** 单测重置辅助函数，消除测试间的状态污染 */
export const resetClientSentryForTest = (): void => {
  isInitialized = false;
  activeDriver = defaultDriver;
};
