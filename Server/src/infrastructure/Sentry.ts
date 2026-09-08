import * as Sentry from "@sentry/bun";
import type { AppEnv } from "../config/Env";

let isInitialized = false;

export const isServerSentryEnabled = (): boolean => isInitialized;

export const _resetServerSentryForTest = (): void => {
  isInitialized = false;
};

export const resolveServerRelease = (): string | undefined => {
  const envRelease = process.env.SENTRY_RELEASE || Bun.env.SENTRY_RELEASE;
  if (envRelease && envRelease.trim()) {
    return envRelease.trim();
  }
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]);
    if (proc.exitCode === 0) {
      const hash = proc.stdout.toString().trim();
      if (hash) {
        return hash;
      }
    }
  } catch {
    // 降级：无 git 环境或非 git 目录
  }
  return undefined;
};

export const initServerSentry = (env: AppEnv): void => {
  if (!env.sentryDsn) {
    return;
  }

  const release = resolveServerRelease();

  Sentry.init({
    dsn: env.sentryDsn,
    environment: env.otelDeploymentEnvironment || process.env.NODE_ENV || "production",
    release,
    tracesSampleRate: 0.1,
    // 忽略预期的客户端断开连接错误
    ignoreErrors: [
      "WebSocket is not open",
      "Connection reset by peer",
    ],
  });

  isInitialized = true;
};

export const flushServerSentry = async (timeoutMs = 2000): Promise<boolean> => {
  if (!isInitialized) return true;
  try {
    return await Sentry.flush(timeoutMs);
  } catch {
    return false;
  }
};

export const closeServerSentry = async (timeoutMs = 2000): Promise<boolean> => {
  if (!isInitialized) return true;
  try {
    const result = await Sentry.close(timeoutMs);
    isInitialized = false;
    return result;
  } catch {
    isInitialized = false;
    return false;
  }
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
