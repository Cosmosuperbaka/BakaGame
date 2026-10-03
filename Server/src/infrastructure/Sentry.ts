import * as Sentry from "@sentry/bun";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppEnv } from "../config/Env";

const SENSITIVE_KEYS = new Set([
  "cookie",
  "cookies",
  "sessiontoken",
  "token",
  "password",
  "authorization",
  "secret",
]);

export const sanitizeLogText = (text: string, maxLength = 500): string => {
  return redactLogText(text).replace(/[\r\n\x00-\x1f\x7f]/g, " ").slice(0, maxLength);
};

// 文本只清理可识别的凭据赋值；不可解析的入站正文应在边界不记录。
export const redactLogText = (text: string): string => text
  .replace(/\b(authorization\s*[:=]\s*)(?:Bearer|Basic)\s+[^\s,;}]+/gi, "$1***[REDACTED]")
  .replace(/\b(Bearer|Basic)\s+[a-zA-Z0-9+/=_-]{8,}/g, "$1 ***[REDACTED]")
  .replace(
    /((?:["']?(?:cookie|cookies|token|session[_-]?token|access[_-]?token|refresh[_-]?token|password|authorization|secret)["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;}]+)/gi,
    "$1***[REDACTED]",
  );

export const redactData = (data: unknown, depth = 0, maxProperties = 32): unknown => {
  const ancestors = new WeakSet<object>();
  const visit = (value: unknown, level: number): unknown => {
    if (typeof value === "string") return redactLogText(value);
    if (value == null || typeof value !== "object") return value;
    if (ancestors.has(value)) return "[CIRCULAR]";
    if (level >= 5) return "[MAX_DEPTH_EXCEEDED]";
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return value.slice(0, maxProperties).map((item) => visit(item, level + 1));
      // Error 的诊断字段不可枚举；cause 与自有字段仍走统一脱敏。
      const source = value instanceof Error
        ? { errorName: value.name, errorMessage: value.message, stack: value.stack,
            ...("cause" in value ? { cause: value.cause } : {}), ...value }
        : value;
      const entries = Object.entries(source);
      const result: Record<string, unknown> = {};
      for (const [key, item] of entries.slice(0, maxProperties)) {
        const normalizedKey = key.toLowerCase().split(".").at(-1)!.replace(/[_-]/g, "");
        const sensitive = SENSITIVE_KEYS.has(normalizedKey) || ["accesstoken", "refreshtoken"].includes(normalizedKey);
        const safe = key === "sample" && typeof item === "string" ? "[OMITTED_RAW_PAYLOAD]" : sensitive
          ? normalizedKey !== "password" && typeof item === "string" && item.length > 8
            ? `${item.slice(0, 4)}***[REDACTED]` : "***[REDACTED]"
          : visit(item, level + 1);
        Object.defineProperty(result, key, { value: safe, enumerable: true, configurable: true });
      }
      if (entries.length > maxProperties) result._truncated = `[TRUNCATED_${entries.length - maxProperties}_PROPERTIES]`;
      return result;
    } finally {
      ancestors.delete(value);
    }
  };
  return visit(data, depth);
};

export const describeError = (error: unknown): Record<string, unknown> => {
  if (error instanceof Error) return redactData(error) as Record<string, unknown>;
  return { errorMessage: redactLogText(typeof error === "string" ? error : String(error)) };
};

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
    sendDefaultPii: false,
    beforeSend(event) {
      // 不截断事件根节点，保留异常栈、SDK 元数据和协议结构。
      if (event.extra) event.extra = redactData(event.extra) as typeof event.extra;
      if (event.contexts) event.contexts = redactData(event.contexts) as typeof event.contexts;
      if (event.user) event.user = redactData(event.user) as typeof event.user;
      if (event.tags) event.tags = redactData(event.tags) as typeof event.tags;
      if (event.request) event.request = redactData(event.request) as typeof event.request;
      if (event.message) event.message = redactLogText(event.message);
      for (const exception of event.exception?.values ?? []) {
        if (exception.value) exception.value = redactLogText(exception.value);
        for (const frame of exception.stacktrace?.frames ?? []) {
          if (frame.vars) frame.vars = redactData(frame.vars) as typeof frame.vars;
          if (frame.filename) frame.filename = redactLogText(frame.filename);
        }
      }
      for (const breadcrumb of event.breadcrumbs ?? []) {
        if (breadcrumb.message) breadcrumb.message = redactLogText(breadcrumb.message);
        if (breadcrumb.data) breadcrumb.data = redactData(breadcrumb.data) as typeof breadcrumb.data;
      }
      return event;
    },
    beforeSendLog(log) {
      return { ...log, message: redactLogText(log.message),
        attributes: redactData(log.attributes) as typeof log.attributes };
    },
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
  return Object.fromEntries(Object.entries(redactData(context) as Record<string, unknown>)
    .map(([key, value]) => [key, value !== null && typeof value === "object" ? JSON.stringify(value) : value]));
};

export const captureServerLog = (
  message: string,
  level: SentryLogLevel = "info",
  context?: Record<string, unknown>,
): void => {
  if (!isInitialized) return;
  message = redactLogText(message);
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
      scope.setExtras(redactData(context) as Record<string, unknown>);
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
      scope.setExtras(redactData(context) as Record<string, unknown>);
    }
    Sentry.captureMessage(redactLogText(message), level);
  });
};
