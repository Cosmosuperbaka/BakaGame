import * as Sentry from "@sentry/bun";
import type { ErrorEvent } from "@sentry/bun";
import type { AppEnv } from "../config/Env";
import { DEFAULT_SENTRY_TRACES_SAMPLE_RATE } from "../config/env/Observability";
import { AppError } from "../domain/Errors";
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

/**
 * 音频取流直链的键名（按归一后的形状索引）。
 *
 * 这类值是上游带签名的播放地址：查询串就是有效期内可重放的取流凭据，同一条记录还会
 * 同时写 stdout、进 OTLP 并可能入 Sentry，等于把凭据交给第三方观测平台。签名参数名
 * 随音源而变、认不出来就等于外发，所以不按参数名清洗而是整串查询一律不出口；
 * 但也不能整值掩码 —— host + path 正是判断「解灰命中的是哪个音源」的诊断依据。
 */
const AUDIO_URL_KEYS = new Set([
  "audiourl",
  "playurl",
  "streamurl",
  "songurl",
  "musicurl",
  "unblockurl",
  "outerurl",
]);

/** 音频文件形态的 URL 路径：出现在任意文本里（消息、错误文案）时同样按取流直链处理。 */
const MEDIA_PATH_PATTERN = /\.(?:mp3|m4a|aac|flac|wav|ogg|opus)$/i;
/**
 * 定位文本里的绝对 URL 及其查询串。字符类只排除空白与常见定界符（含中文标点），
 * 命中不了普通日志文本 —— 只有真正长成 `scheme://…?…` 的片段才会被检查。
 */
const ABSOLUTE_URL_PATTERN = /https?:\/\/[^\s"'`,;\\，；、。）)】]+/gi;
/** 占位标记刻意不含 `=`：重复清洗时不再被识别成查询串，保证幂等。 */
const REDACTED_QUERY = "***[REDACTED_QUERY]";

/**
 * 摘掉 URL 的查询串，保留 `origin/path?标记`。标记同时说明「此处原本带参、被本层摘掉」，
 * 排障时不会误以为上游返回的就是无参地址。
 */
export const stripUrlQuery = (value: string): string => {
  const cut = value.indexOf("?");
  if (cut < 0) return value;
  // 只有 `key=…` 形态的尾巴才算查询串：已替换过的标记与裸问号原样通过，避免二次糊掉。
  const query = value.slice(cut + 1);
  return /^[^#]*=/.test(query) ? `${value.slice(0, cut)}?${REDACTED_QUERY}` : value;
};

/** 文本内出现的媒体直链整串摘掉查询；非媒体路径的 URL（业务接口、分页参数）保持原样。 */
const redactMediaUrlText = (text: string): string =>
  text.replace(ABSOLUTE_URL_PATTERN, (match) => {
    const cut = match.indexOf("?");
    if (cut < 0 || !MEDIA_PATH_PATTERN.test(match.slice(0, cut))) return match;
    return stripUrlQuery(match);
  });

export const sanitizeLogText = (text: string, maxLength = 500): string => {
  // 目标就是剥离 C0 控制字符与 DEL：日志里残留 \r\n\t\x00 会撕裂行结构、伪造换行。
  return (
    redactLogText(text)
      // eslint-disable-next-line no-control-regex -- 目标就是剥离 C0 控制字符与 DEL
      .replace(/[\r\n\x00-\x1f\x7f]/g, " ")
      .slice(0, maxLength)
  );
};

// 文本只清理可识别的凭据赋值与媒体直链签名；不可解析的入站正文应在边界不记录。
export const redactLogText = (text: string): string =>
  redactMediaUrlText(
    text
      .replace(/\b(authorization\s*[:=]\s*)(?:Bearer|Basic)\s+[^\s,;}]+/gi, "$1***[REDACTED]")
      .replace(/\b(Bearer|Basic)\s+[a-zA-Z0-9+/=_-]{8,}/g, "$1 ***[REDACTED]")
      .replace(
        /((?:["']?(?:cookie|cookies|token|session[_-]?token|access[_-]?token|refresh[_-]?token|password|authorization|secret|login[_-]?code|verify[_-]?code|auth[_-]?code|otp|captcha|ticket|channel[_-]?ticket)["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;}]+)/gi,
        "$1***[REDACTED]"
      )
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
 * 音频直链只摘查询串；其余敏感串保留前 4 位供定位故障；普通字段递归下去。
 */
const redactProperty = (key: string, value: unknown, recurse: () => unknown): unknown => {
  if (key === "sample" && typeof value === "string") return "[OMITTED_RAW_PAYLOAD]";
  const normalizedKey = normalizePropertyKey(key);
  if (FULL_MASK_KEYS.has(normalizedKey)) return "***[REDACTED]";
  // 键名直接点名音频直链时不看路径形状：解灰音源的代理地址常常没有扩展名。
  if (AUDIO_URL_KEYS.has(normalizedKey) && typeof value === "string") return stripUrlQuery(value);
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

  // 缺省即安全失败：配了遥测凭据却没有显式注入环境标记，说明这台实例的环境是猜出来的。
  // 静默回落 development 会让生产心跳停报、事件与本地开发流量同池，且事后不可区分，
  // 因此拒绝启动（启动栈本身就是那条最响的告警）。mock env 不带该字段（undefined）时不拦截。
  if (env.deploymentMarkerExplicit === false) {
    throw new AppError(
      "CONFIG_ERROR",
      "已配置 SENTRY_DSN 但部署环境标记缺失：请显式注入 DEPLOYMENT_ENVIRONMENT" +
        "（production / development），拒绝以推测环境启动遥测"
    );
  }

  const release = resolveServerRelease();
  if (!release)
    process.stderr.write(
      `${JSON.stringify({
        time: new Date().toISOString(),
        level: "warn",
        msg: "发布证据缺失或无效，当前遥测不标注 release；请核对 build/release.json 或源码 Git/changelog",
      })}\n`
    );

  activeEnvironment = env.otelDeploymentEnvironment ?? "development";

  Sentry.init({
    dsn: env.sentryDsn,
    environment: activeEnvironment,
    // SDK 对 undefined 会自动读取 SENTRY_RELEASE/CI 字符串；空值显式禁止伪造回退。
    release: release ?? "",
    tracesSampleRate: env.sentryTracesSampleRate ?? DEFAULT_SENTRY_TRACES_SAMPLE_RATE,
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
    // 忽略名单只装「预期的客户端断开」这一类，且必须用可判别的精确文案。
    // 曾经的 "Connection reset by peer" 与三条隧道文案已移除：子串过滤会连网易云/Bangumi/DB
    // 的真实上游故障一并抹掉，更会把采集链路自身（隧道）的故障吞成「无事件」——
    // 「没有事件」绝不能被读成「没有故障」。隧道故障改由专用指标逐条计数加限频聚合 issue
    // 上报（见 transport/routes/SentryTunnel.ts 的 failureReporter），不再进本名单。
    ignoreErrors: ["WebSocket is not open"],
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
