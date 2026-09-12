import * as Sentry from "@sentry/bun";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppEnv } from "../config/Env";

let isInitialized = false;

export const SERVER_HEARTBEAT_MONITOR_SLUG = "bakagame-server-heartbeat";

// 该 Cron Monitor 的排程为每 5 分钟一次、判定裕度（checkin_margin）为 2 分钟，
// 即只有在 [T, T+2min] 窗口内收到 check-in 才判定为按时。
// 上报间隔必须不大于判定裕度，否则必然跨过窗口间隙被误报为 missed check-in：
// 1 分钟间隔可为每个窗口预留 2 次重试余量，覆盖上游抖动与调度延迟。
export const SERVER_HEARTBEAT_INTERVAL_MS = 60_000;

export const isServerSentryEnabled = (): boolean => isInitialized;

export const _resetServerSentryForTest = (): void => {
  isInitialized = false;
};

const PROJECT_VERSION_FALLBACK = "1.3.2";

const resolveLatestProjectVersion = (): string => {
  try {
    const changelogPath = resolve(import.meta.dir, "../../../Client/src/data/changelog.json");
    const changelog = JSON.parse(readFileSync(changelogPath, "utf8")) as {
      entries?: Array<{ version?: unknown }>;
    };
    const versions = (changelog.entries ?? [])
    .map((entry) => entry.version)
    .filter((version): version is string => typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version));
    if (versions.length === 0) return PROJECT_VERSION_FALLBACK;
    return versions.sort((a, b) => {
    const left = a.split(".").map(Number);
    const right = b.split(".").map(Number);
    for (let index = 0; index < 3; index += 1) {
      if (left[index] !== right[index]) return right[index] - left[index];
    }
    return 0;
    })[0] ?? PROJECT_VERSION_FALLBACK;
  } catch {
    return PROJECT_VERSION_FALLBACK;
  }
};

export const resolveServerRelease = (): string | undefined => {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]);
    if (proc.exitCode === 0) {
      const hash = proc.stdout.toString().trim();
      if (hash) {
        return `V${resolveLatestProjectVersion()}（${hash}）`;
      }
    }
  } catch {
    // 降级：无 git 环境或非 git 目录
  }
  return undefined;
};

const resolveSampleRate = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
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
    tracesSampleRate: resolveSampleRate(Bun.env.SENTRY_TRACES_SAMPLE_RATE, 0.2),
    integrations: [
      Sentry.httpIntegration(),
      Sentry.httpServerIntegration(),
      Sentry.bunRuntimeMetricsIntegration(),
      Sentry.consoleLoggingIntegration({ levels: ["error", "warn"] }),
    ],
    enableLogs: true,
    // 忽略预期的客户端断开连接错误与同源反代网络波动
    ignoreErrors: [
      "WebSocket is not open",
      "Connection reset by peer",
      "Sentry tunnel upstream unavailable",
      "Sentry tunnel upstream timeout",
      "Internal Sentry tunnel error",
    ],
  });

  isInitialized = true;
};

type SentryLogLevel = "info" | "warning" | "error";

const toSentryAttributes = (context?: Record<string, unknown>): Record<string, unknown> | undefined => {
  if (!context) return undefined;
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) =>
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean",
    ),
  );
};

export const captureServerLog = (
  message: string,
  level: SentryLogLevel = "info",
  context?: Record<string, unknown>,
): void => {
  if (!isInitialized) return;
  const attributes = toSentryAttributes(context);
  const logger = Sentry.logger;
  if (level === "error") logger.error(message, attributes as never);
  else if (level === "warning") logger.warn(message, attributes as never);
  else logger.info(message, attributes as never);
};

export const recordServerMetric = (
  name: string,
  value: number,
  attributes?: Record<string, string | number | boolean>,
): void => {
  if (!isInitialized || !Number.isFinite(value)) return;
  Sentry.metrics.distribution(name, value, { unit: "millisecond", attributes });
};

export const gaugeServerMetric = (
  name: string,
  value: number,
  attributes?: Record<string, string | number | boolean>,
): void => {
  if (!isInitialized || !Number.isFinite(value)) return;
  Sentry.metrics.gauge(name, value, { attributes });
};

export const countServerMetric = (
  name: string,
  value = 1,
  attributes?: Record<string, string | number | boolean>,
): void => {
  if (!isInitialized || !Number.isFinite(value)) return;
  Sentry.metrics.count(name, value, { attributes });
};

/** 向 Sentry Cron Monitor 报告服务仍在运行。 */
export const captureServerCheckIn = (): void => {
  if (!isInitialized) return;
  Sentry.captureCheckIn({
    monitorSlug: SERVER_HEARTBEAT_MONITOR_SLUG,
    status: "ok",
  });
};

export const captureServerOperation = ({
  name,
  durationMs,
  status,
  attributes,
  startTime,
}: {
  name: string;
  durationMs: number;
  status: number;
  attributes?: Record<string, string | number | boolean>;
  startTime?: number;
}): void => {
  if (!isInitialized) return;
  const startedAt = startTime ?? Date.now() - Math.max(0, durationMs);
  Sentry.startSpan(
    {
      name,
      op: "bakagame.operation",
      startTime: new Date(startedAt),
      attributes: {
        ...attributes,
        "http.status_code": status,
        "operation.duration_ms": durationMs,
      },
    },
    (span) => {
      span.setStatus({ code: status >= 400 ? 2 : 1 });
    },
  );
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
