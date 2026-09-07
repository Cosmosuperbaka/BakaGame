import * as Sentry from "@sentry/bun";
import type { AppEnv } from "../config/Env";

let isInitialized = false;

export const isServerSentryEnabled = (): boolean => isInitialized;

export const initServerSentry = (env: AppEnv): void => {
  if (!env.sentryDsn) {
    return;
  }

  Sentry.init({
    dsn: env.sentryDsn,
    environment: env.otelDeploymentEnvironment || process.env.NODE_ENV || "production",
    tracesSampleRate: 0.1,
    // 忽略预期的客户端断开连接错误
    ignoreErrors: [
      "WebSocket is not open",
      "Connection reset by peer",
    ],
  });

  isInitialized = true;
};

export const captureServerException = (
  error: unknown,
  context?: Record<string, unknown>,
): void => {
  if (!isInitialized) return;

  Sentry.withScope((scope) => {
    if (context) {
      if (context.traceId && typeof context.traceId === "string") {
        scope.setTag("traceId", context.traceId);
      }
      if (context.connectionId && typeof context.connectionId === "string") {
        scope.setTag("connectionId", context.connectionId);
      }
      if (context.roomId && typeof context.roomId === "string") {
        scope.setTag("roomId", context.roomId);
      }
      scope.setExtras(context);
    }
    Sentry.captureException(error);
  });
};

export const captureServerMessage = (
  message: string,
  level: "info" | "warning" | "error" = "info",
  context?: Record<string, unknown>,
): void => {
  if (!isInitialized) return;

  Sentry.withScope((scope) => {
    if (context) {
      if (context.traceId && typeof context.traceId === "string") {
        scope.setTag("traceId", context.traceId);
      }
      if (context.connectionId && typeof context.connectionId === "string") {
        scope.setTag("connectionId", context.connectionId);
      }
      if (context.roomId && typeof context.roomId === "string") {
        scope.setTag("roomId", context.roomId);
      }
      scope.setExtras(context);
    }
    Sentry.captureMessage(message, level);
  });
};
