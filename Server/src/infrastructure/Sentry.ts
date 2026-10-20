import * as Sentry from "@sentry/bun";
import type { ErrorEvent } from "@sentry/bun";
import type { AppEnv } from "../config/Env";
import { resolveServerRelease } from "./Release";

const SENSITIVE_KEYS = new Set([
  "cookie",
  "cookies",
  "sessiontoken",
  "token",
  "password",
  "authorization",
  "secret",
  // 一次性 WS 建连凭据：走 URL 查询串进握手，SDK 的自动 URL 采集会整串存成属性，
  // 因此它必须与 cookie 同级进入键表（见 F05）。`channelTicket` 是壳侧的同一个字段名。
  "ticket",
  "channelticket",
]);

/**
 * 顶级高危凭据：与口令同级，任何通道一律 100% 掩码。
 * 登录验证码是可重放的短期凭据，保留前缀就等于交出 300 秒内的登录能力，
 * 因此不适用 `cookie`/`sessionToken` 那条「保留前 4 位定位故障」的折中口径。
 * `ticket` 同理：30 秒 TTL 内可重放且直接绑定身份与来源 IP，出错事件常发生在消费之前，
 * 保留前缀没有任何排障价值（前 4 位认不出是哪次握手），只有泄露价值。
 */
const FULL_MASK_KEYS = new Set([
  "password",
  "logincode",
  "otp",
  "verifycode",
  "authcode",
  "captcha",
  "ticket",
  "channelticket",
]);

export const sanitizeLogText = (text: string, maxLength = 500): string => {
  // 目标就是剥离 C0 控制字符与 DEL：日志里残留 \r\n\t\x00 会撕裂行结构、伪造换行。
  return (
    redactLogText(text)
      // eslint-disable-next-line no-control-regex -- 目标就是剥离 C0 控制字符与 DEL
      .replace(/[\r\n\x00-\x1f\x7f]/g, " ")
      .slice(0, maxLength)
  );
};

// 文本只清理可识别的凭据赋值；不可解析的入站正文应在边界不记录。
export const redactLogText = (text: string): string =>
  text
    .replace(/\b(authorization\s*[:=]\s*)(?:Bearer|Basic)\s+[^\s,;}]+/gi, "$1***[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[a-zA-Z0-9+/=_-]{8,}/g, "$1 ***[REDACTED]")
    .replace(
      /((?:["']?(?:cookie|cookies|token|session[_-]?token|access[_-]?token|refresh[_-]?token|password|authorization|secret|login[_-]?code|verify[_-]?code|auth[_-]?code|otp|captcha|ticket|channel[_-]?ticket)["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;}]+)/gi,
      "$1***[REDACTED]"
    );

/** 敏感键表按归一后的形状索引：小写、去路径前缀、去分隔符。 */
const normalizePropertyKey = (key: string): string =>
  key.toLowerCase().split(".").at(-1)!.replace(/[_-]/g, "");

/**
 * 查询串形态的凭据键：`?ticket=…` 这类「键名在 URL 里、值紧跟到下一个分隔符」的写法
 * 不会被上面的赋值正则覆盖（前缀是 `?` 与 `&` 而不是 `:` 或 `=` 两侧的空格），
 * 因此单独按参数对清洗。URL 采集来自 SDK 自动埋点，不经过任何业务代码，只能在这里拦。
 */
const SENSITIVE_QUERY_KEYS = new Set([
  ...SENSITIVE_KEYS,
  ...FULL_MASK_KEYS,
  "accesstoken",
  "refreshtoken",
]);

const QUERY_PAIR_PATTERN = /([?&])([A-Za-z0-9_.%[\]-]+)=([^&;\s"'\\]*)/g;

/** 逐参数清洗 URL 或请求目标里的凭据值；非敏感参数原样保留（含 `&` 分隔结构）。 */
export const redactUrlQuery = (value: string): string =>
  value.replace(QUERY_PAIR_PATTERN, (pair, prefix: string, rawKey: string) =>
    SENSITIVE_QUERY_KEYS.has(normalizePropertyKey(decodeURIComponent(rawKey)))
      ? `${prefix}${rawKey}=***[REDACTED]`
      : pair
  );

const BEARER_TOKEN_KEYS = ["accesstoken", "refreshtoken"];

/**
 * 单个属性值的脱敏口径：`sample` 是原始上报正文整段丢弃；顶级凭据一律全掩码；
 * 其余敏感串保留前 4 位供定位故障；普通字段递归下去。
 */
const redactProperty = (key: string, value: unknown, recurse: () => unknown): unknown => {
  if (key === "sample" && typeof value === "string") return "[OMITTED_RAW_PAYLOAD]";
  const normalizedKey = normalizePropertyKey(key);
  if (FULL_MASK_KEYS.has(normalizedKey)) return "***[REDACTED]";
  if (!SENSITIVE_KEYS.has(normalizedKey) && !BEARER_TOKEN_KEYS.includes(normalizedKey))
    return recurse();
  return typeof value === "string" && value.length > 8
    ? `${value.slice(0, 4)}***[REDACTED]`
    : "***[REDACTED]";
};

/**
 * SDK 自动埋点产出的属性表是扁平标量（span `data`、metric `attributes`、解析后的查询串）。
 * 这里不用 `redactData`：它会按 32 个属性截断并压平嵌套，span 属性被静默丢掉比泄露更难查。
 * 字符串值先过查询串清洗再过文本脱敏，键名命中敏感表的按整条链口径掩码。
 */
const redactScalarAttributes = (attributes: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => {
      // 先按值清洗（查询串与文本链），再按键名定掩码强度；两者顺序不能颠倒，
      // 否则非敏感键会拿到未清洗的原值。
      const scrubbed = typeof value === "string" ? redactUrlQuery(redactLogText(value)) : value;
      return [
        key,
        scrubbed && typeof scrubbed === "object"
          ? redactData(scrubbed)
          : redactProperty(key, scrubbed, () => scrubbed),
      ];
    })
  );

/** Error 的诊断字段不可枚举；cause 与自有字段仍走统一脱敏。 */
const toPlainSource = (value: object): object =>
  value instanceof Error
    ? {
        errorName: value.name,
        errorMessage: value.message,
        stack: value.stack,
        ...("cause" in value ? { cause: value.cause } : {}),
        ...value,
      }
    : value;

export const redactData = (data: unknown, depth = 0, maxProperties = 32): unknown => {
  const ancestors = new WeakSet<object>();
  const visit = (value: unknown, level: number): unknown => {
    if (typeof value === "string") return redactLogText(value);
    if (value == null || typeof value !== "object") return value;
    if (ancestors.has(value)) return "[CIRCULAR]";
    if (level >= 5) return "[MAX_DEPTH_EXCEEDED]";
    ancestors.add(value);
    try {
      if (Array.isArray(value))
        return value.slice(0, maxProperties).map((item) => visit(item, level + 1));
      const entries = Object.entries(toPlainSource(value));
      const result: Record<string, unknown> = {};
      for (const [key, item] of entries.slice(0, maxProperties)) {
        Object.defineProperty(result, key, {
          value: redactProperty(key, item, () => visit(item, level + 1)),
          enumerable: true,
          configurable: true,
        });
      }
      if (entries.length > maxProperties)
        result._truncated = `[TRUNCATED_${entries.length - maxProperties}_PROPERTIES]`;
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
/** 当前遥测环境；未初始化时为空，供 check-in 判定是否属于生产实例。 */
let activeEnvironment: string | null = null;

export const SERVER_HEARTBEAT_MONITOR_SLUG = "bakagame-server-heartbeat";

// 该 Cron Monitor 的排程为每 5 分钟一次、判定裕度（checkin_margin）为 2 分钟，
// 即只有在 [T, T+2min] 窗口内收到 check-in 才判定为按时。
// 上报间隔必须不大于判定裕度，否则必然跨过窗口间隙被误报为 missed check-in：
// 1 分钟间隔可为每个窗口预留 2 次重试余量，覆盖上游抖动与调度延迟。
export const SERVER_HEARTBEAT_INTERVAL_MS = 60_000;

// Monitor 的排程与判定参数与上报间隔同居本模块，随 check-in 一并 upsert：
// Sentry 侧配置被改动或监控被删后由下一次上报纠正，不再依赖手工维护。
export const SERVER_HEARTBEAT_MONITOR_SCHEDULE = "*/5 * * * *";
export const SERVER_HEARTBEAT_MONITOR_TIMEZONE = "UTC";
export const SERVER_HEARTBEAT_MONITOR_CHECKIN_MARGIN_MIN = 2;
export const SERVER_HEARTBEAT_MONITOR_MAX_RUNTIME_MIN = 1;

export const isServerSentryEnabled = (): boolean => isInitialized;

export const _resetServerSentryForTest = (): void => {
  isInitialized = false;
  activeEnvironment = null;
};

const resolveSampleRate = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
};

/**
 * 事件根节点的可控字段：只脱敏值本身，不截断根节点，
 * 保留异常栈、SDK 元数据和协议结构。
 */
const redactEventFields = (event: ErrorEvent): void => {
  if (event.extra) event.extra = redactData(event.extra) as typeof event.extra;
  if (event.contexts) event.contexts = redactData(event.contexts) as typeof event.contexts;
  if (event.user) event.user = redactData(event.user) as typeof event.user;
  if (event.tags) event.tags = redactData(event.tags) as typeof event.tags;
  if (event.request) redactEventRequest(event);
  if (event.message) event.message = redactLogText(event.message);
};

/** 头部值恒为字符串：按键名复用同一条掩码链，返回值保持字符串形状。 */
const maskHeaderValue = (key: string, value: string): string =>
  redactProperty(key, value, () => value) as string;

/**
 * SDK 自动采集的 `request` 上下文：整串 URL 与查询串是独立字段，不走键表，
 * 一次性建连凭据 `ticket` 正是从这里被长期保存到第三方平台（F05）。
 * 头部按「键名匹配敏感键表」处理，因为 SDK 可能给对象也可能给键值对数组。
 */
const redactEventRequest = (event: ErrorEvent): void => {
  const request = event.request;
  if (!request) return;
  if (request.url) request.url = redactUrlQuery(redactLogText(request.url));
  if (typeof request.data === "string") request.data = redactLogText(request.data);
  else if (request.data) request.data = redactData(request.data) as typeof request.data;
  const query = request.query_string;
  if (typeof query === "string") request.query_string = redactUrlQuery(redactLogText(query));
  else if (query && typeof query === "object")
    request.query_string = redactScalarAttributes(
      query as Record<string, unknown>
    ) as typeof request.query_string;
  const headers = request.headers as Record<string, string> | [string, string][] | undefined;
  if (headers) {
    // SDK 的类型声明里 headers 恒为 Record，但 Node 侧某些集成会给出键值对数组：
    // 两种形状都按键名走同一条掩码链，统一回写成 Record。
    const pairs: [string, string][] = Array.isArray(headers)
      ? headers
      : Object.entries(headers).map(([key, value]) => [key, String(value)]);
    request.headers = Object.fromEntries(
      pairs.map(([key, value]) => [key, maskHeaderValue(key, value)])
    );
  }
};

/** 异常文本、栈帧里的变量表与文件名都走同一条脱敏链。 */
const redactEventExceptions = (event: ErrorEvent): void => {
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = redactLogText(exception.value);
    for (const frame of exception.stacktrace?.frames ?? []) {
      if (frame.vars) frame.vars = redactData(frame.vars) as typeof frame.vars;
      if (frame.filename) frame.filename = redactUrlQuery(redactLogText(frame.filename));
    }
  }
};

const redactEventBreadcrumbs = (event: ErrorEvent): void => {
  for (const breadcrumb of event.breadcrumbs ?? []) {
    if (breadcrumb.message) breadcrumb.message = redactLogText(breadcrumb.message);
    if (breadcrumb.data) breadcrumb.data = redactData(breadcrumb.data) as typeof breadcrumb.data;
  }
};

export const initServerSentry = (env: AppEnv): void => {
  if (!env.sentryDsn) {
    return;
  }

  const release = resolveServerRelease();
  if (!release)
    console.warn(
      "[Sentry] 发布证据缺失或无效，当前遥测不标注 release；请核对 build/release.json 或源码 Git/changelog"
    );

  activeEnvironment = env.otelDeploymentEnvironment ?? "development";

  Sentry.init({
    dsn: env.sentryDsn,
    environment: activeEnvironment,
    // SDK 对 undefined 会自动读取 SENTRY_RELEASE/CI 字符串；空值显式禁止伪造回退。
    release: release ?? "",
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
      redactEventFields(event);
      redactEventExceptions(event);
      redactEventBreadcrumbs(event);
      return event;
    },
    beforeSendLog(log) {
      return {
        ...log,
        message: redactLogText(log.message),
        attributes: redactData(log.attributes) as typeof log.attributes,
      };
    },
    // 自动埋点的 span 与 metric 同样带整串请求目标：查询串里的凭据必须在离开进程前洗掉。
    beforeSendSpan(span) {
      return {
        ...span,
        ...(span.description
          ? { description: redactUrlQuery(redactLogText(span.description)) }
          : {}),
        data: redactScalarAttributes(span.data as Record<string, unknown>) as typeof span.data,
      };
    },
    beforeSendMetric(metric) {
      if (!metric.attributes) return metric;
      return {
        ...metric,
        attributes: redactScalarAttributes(
          metric.attributes as Record<string, unknown>
        ) as typeof metric.attributes,
      };
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

const toSentryAttributes = (
  context?: Record<string, unknown>
): Record<string, unknown> | undefined => {
  if (!context) return undefined;
  return Object.fromEntries(
    Object.entries(redactData(context) as Record<string, unknown>).map(([key, value]) => [
      key,
      value !== null && typeof value === "object" ? JSON.stringify(value) : value,
    ])
  );
};

export const captureServerLog = (
  message: string,
  level: SentryLogLevel = "info",
  context?: Record<string, unknown>
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
  attributes?: Record<string, string | number | boolean>
): void => {
  if (!isInitialized || !Number.isFinite(value)) return;
  Sentry.metrics.distribution(name, value, { unit: "millisecond", attributes });
};

export const gaugeServerMetric = (
  name: string,
  value: number,
  attributes?: Record<string, string | number | boolean>
): void => {
  if (!isInitialized || !Number.isFinite(value)) return;
  Sentry.metrics.gauge(name, value, { attributes });
};

export const countServerMetric = (
  name: string,
  value = 1,
  attributes?: Record<string, string | number | boolean>
): void => {
  if (!isInitialized || !Number.isFinite(value)) return;
  Sentry.metrics.count(name, value, { attributes });
};

/** 向 Sentry Cron Monitor 报告服务仍在运行。 */
/**
 * 上报服务端心跳（Cron Monitor）。
 *
 * 只由生产实例上报：Sentry 的 Cron Monitor 按环境分别判定，本地 dev 实例一旦在线
 * 就会顶替生产心跳，把生产停机掩盖成「已按时」；dev 停跑后又按其环境持续误报
 * missed check-in。两者方向相反但同样致命，因此这里只放行 production。
 */
export const captureServerCheckIn = (): void => {
  if (!isInitialized) return;
  if (activeEnvironment !== "production") return;
  Sentry.captureCheckIn(
    {
      monitorSlug: SERVER_HEARTBEAT_MONITOR_SLUG,
      status: "ok",
    },
    {
      schedule: { type: "crontab", value: SERVER_HEARTBEAT_MONITOR_SCHEDULE },
      timezone: SERVER_HEARTBEAT_MONITOR_TIMEZONE,
      checkinMargin: SERVER_HEARTBEAT_MONITOR_CHECKIN_MARGIN_MIN,
      maxRuntime: SERVER_HEARTBEAT_MONITOR_MAX_RUNTIME_MIN,
    }
  );
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
    }
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

export const captureServerException = (error: unknown, context?: Record<string, unknown>): void => {
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

/**
 * 站内反馈同步为 Sentry User Feedback；只带账号 ID 与昵称，不带邮箱（邮箱即 QQ 号）。
 * 未启用 Sentry 时返回 `null`，反馈本身照常落库。
 */
export const captureServerFeedback = (feedback: {
  message: string;
  name: string;
  userId: string;
  url?: string;
  tags: Record<string, string>;
}): string | null => {
  if (!isInitialized) return null;
  return Sentry.withScope((scope) => {
    scope.setUser({ id: feedback.userId, username: feedback.name });
    return Sentry.captureFeedback(
      {
        message: feedback.message,
        name: feedback.name,
        source: "bakagame-site",
        ...(feedback.url ? { url: feedback.url } : {}),
        tags: feedback.tags,
      },
      undefined,
      scope
    );
  });
};

export const captureServerMessage = (
  message: string,
  level: "info" | "warning" | "error" = "info",
  context?: Record<string, unknown>
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
