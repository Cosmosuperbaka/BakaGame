import { isLogLevelEnabled, resolveLogLevel, type StructuredLogLevel } from "./StructuredLog";
import { ConsoleLogSink, type LogOutputLike } from "./logging/ConsoleLog";
import { createOtelLogRecord, type LogSink, type OtelLogRecord } from "./logging/OtelLog";
import { acceptTraceId } from "./logging/TraceId";
import type { OtlpExporter } from "./OtlpExporter";
import {
  redactData,
  redactLogText,
  sanitizeLogText,
  captureServerException,
  captureServerLog,
  captureServerMessage,
  captureServerOperation,
  countServerMetric,
  isServerSentryEnabled,
  recordServerMetric,
} from "./Sentry";
import { isRecord } from "../shared/Json";

export interface LogEntry {
  type: string;
  createdAt: number;
  roomId?: string;
  playerId?: string;
  payload?: unknown;
}

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
export type EventLogLevel = Exclude<LogLevel, "DEBUG">;

export type OperationLogging = "errors" | "all";

const LOWER_LEVEL: Record<LogLevel, StructuredLogLevel> = {
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
};

const SENTRY_LEVEL: Record<EventLogLevel, "info" | "warning" | "error"> = {
  INFO: "info",
  WARN: "warning",
  ERROR: "error",
};

const EVENT_LABELS: Record<string, string> = {
  "chat.sent": "聊天消息已发送",
  "game.blank_guess_entered": "白板已进入猜词",
  "game.blank_guess_reviewed": "白板猜词已评审",
  "game.blank_guess_submitted": "白板已提交猜词",
  "game.description_submitted": "描述已提交",
  "game.disconnect_resolved": "掉线玩家已处理",
  "game.finished": "对局已结束",
  "game.night_action_submitted": "夜晚操作已提交",
  "game.night_resolved": "夜晚结算完成",
  "game.phase_changed": "游戏阶段已切换",
  "game.questioner_assigned": "出题人已指定",
  "game.started": "对局已开始",
  "game.vote_resolved": "投票结果已结算",
  "game.vote_submitted": "投票已提交",
  "game.words_submitted": "词语已提交",
  "player.disconnect": "玩家已掉线",
  "player.kicked": "玩家已被踢出",
  "player.leave": "玩家已离开房间",
  "player.membership_changed": "玩家身份已切换",
  "player.ready_changed": "玩家准备状态已更新",
  "player.renamed": "玩家已改名",
  "room.closed": "房间已关闭",
  "room.create": "收到创建房间请求",
  "room.created": "房间已创建",
  "room.host_transferred": "房主已转让",
  "room.join": "收到加入房间请求",
  "room.joined": "玩家已加入房间",
  "room.reconnect": "收到房间重连请求",
  "room.reconnected": "玩家已重连房间",
  "room.settings_changed": "房间设置已更新",
  "room.updateSettings": "收到房间设置更新请求",
  "song.auth.cookieRejected": "猜歌账号凭据被拒绝",
  "song.auth.poolSharing": "猜歌账号曲库共享已切换",
  "song.auto.exhausted": "猜歌自动出题候选已耗尽",
  "song.auto.failed": "猜歌自动出题失败",
  "song.auto.pool": "猜歌自动出题候选池已确定",
  "song.game.round_finished": "猜歌回合已结束",
  "song.game.started": "猜歌对局已开始",
  "song.player.disconnected": "猜歌玩家已掉线",
  "song.room.created": "猜歌房间已创建",
  "song.room.joined": "玩家已加入猜歌房间",
};

/** 控制台只展示这几类领域事件；其余事件仍完整进入结构化日志。 */
const CONSOLE_EVENT_TYPES = new Set([
  "room.created",
  "room.closed",
  "game.started",
  "game.finished",
]);

/** 节流键表的容量：键由调用点给定、本应有限，仍要有硬上限，挤出最早的键。 */
const MAX_THROTTLE_KEYS = 256;

export interface EventLoggerOptions {
  console?: ConsoleLogSink;
  sinks?: LogSink[];
  /** 慢操作进入结构化日志并出现在控制台；缺省 1000ms。 */
  slowOperationMs?: number;
  /** 结构化日志中的操作范围：缺省只记失败与慢操作，`all` 记录全部。 */
  operationLogging?: OperationLogging;
}

/**
 * 操作结果 → 日志级别的唯一口径：
 * - 调用方的错（所有 4xx：口令错、房间不存在、限流、扫描探测）是预期流量，记信息级；
 *   失败仍进结构化文件当排障线索，但不上控制台、不占告警配额；
 * - 服务端的错（5xx 与未预期异常）记错误级；
 * - 告警级留给需要人看的安全事件，由发现点显式记一条 warn，操作日志不再重复记一次。
 */
export const levelForStatus = (status: number): Exclude<LogLevel, "DEBUG" | "WARN"> =>
  status >= 500 ? "ERROR" : "INFO";

const getEventLevel = (entry: LogEntry): EventLogLevel => {
  switch (entry.type) {
    case "room.closed":
      return isRecord(entry.payload) && entry.payload.reason === "empty" ? "INFO" : "WARN";
    default:
      return "INFO";
  }
};

/** 领域事件按类型前缀归属检索范围；新领域的事件加一行，不靠正文猜。 */
const EVENT_SCOPES: ReadonlyArray<readonly [prefix: string, scope: string]> = [
  ["room.", "房间"],
  ["game.", "对局"],
  ["player.", "玩家"],
  ["chat.", "聊天"],
  ["song.", "猜歌"],
];

const eventScope = (type: string): string =>
  EVENT_SCOPES.find(([prefix]) => type.startsWith(prefix))?.[1] ?? "系统";

/** 系统日志没有显式 scope 时按正文关键词归类，避免每条调用点都补参数。 */
const inferSystemScope = (message: string, context: Record<string, unknown>): string => {
  const explicit = context.scope;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim().slice(0, 6);
  if (/快照/.test(message)) return "快照";
  if (/数据库|落库/.test(message)) return "数据库";
  if (/音乐|网易|QQ/.test(message)) return "音乐";
  if (/Sentry|遥测|指标|心跳/.test(message)) return "遥测";
  if (/停机|启动/.test(message)) return "启停";
  if (/安全|鉴权|来源|证明/.test(message)) return "安全";
  if (/WebSocket|WS|连接|网络/.test(message)) return "实时";
  return "系统";
};

interface ExceptionDetails {
  name?: string;
  message?: string;
  stack?: string;
  cause?: unknown;
  display?: Record<string, unknown>;
}

const textField = (record: Record<string, unknown>, key: string): string | undefined =>
  typeof record[key] === "string" ? (record[key] as string) : undefined;

const exceptionDisplay = (name?: string, message?: string, stack?: string) => ({
  ...(name ? { errorName: name } : {}),
  ...(message ? { errorMessage: message } : {}),
  ...(stack ? { stack } : {}),
});

const errorCandidate = (candidate: unknown): ExceptionDetails | undefined => {
  if (!isRecord(candidate)) return undefined;
  const name = textField(candidate, "errorName") ?? textField(candidate, "name");
  const message = textField(candidate, "errorMessage") ?? textField(candidate, "message");
  const stack = textField(candidate, "stack");
  return {
    name,
    message,
    stack,
    cause: candidate.cause,
    display: exceptionDisplay(name, message, stack),
  };
};

const extractException = (context: Record<string, unknown>): ExceptionDetails => {
  const candidate = context.error;
  if (typeof candidate === "string") {
    return {
      name: "Error",
      message: candidate,
      display: exceptionDisplay("Error", candidate),
    };
  }
  const nested = errorCandidate(candidate);
  if (nested) return nested;

  const name = textField(context, "errorName");
  const message = textField(context, "errorMessage");
  const stack = textField(context, "stack");
  if (!name && !message && !stack) return {};
  return {
    name,
    message,
    stack,
    cause: context.cause,
    display: exceptionDisplay(name, message, stack),
  };
};

const splitException = (
  context: Record<string, unknown>
): { attributes: Record<string, unknown>; exception?: ExceptionDetails } => {
  const exception = extractException(context);
  const rest = { ...context };
  for (const key of ["error", "errorName", "errorMessage", "stack", "cause", "traceId", "scope"])
    delete rest[key];
  const attributes: Record<string, unknown> = { ...rest };
  if (exception.name) attributes["exception.type"] = exception.name;
  if (exception.message) attributes["exception.message"] = exception.message;
  if (exception.stack) attributes["exception.stacktrace"] = exception.stack;
  if (exception.cause !== undefined) attributes["exception.cause"] = exception.cause;
  return { attributes, exception };
};

/**
 * 控制台只显示人工挑选的短字段；其余元数据完整留在 OTel 文件里。
 * 不再把 context 里的任意标量键倒到控制台，避免地址、内部字段名这类噪声。
 */
const scalarFields = (
  context: Record<string, unknown>,
  preferred: readonly string[]
): Array<[string, unknown]> => {
  const fields: Array<[string, unknown]> = [];
  for (const key of preferred) {
    const value = context[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      fields.push([key, value]);
  }
  return fields;
};

/** 追踪号可能来自客户端自报（WS 信封、请求头）：形状不合格的不进任何出口。 */
const traceIdOf = (context: Record<string, unknown> | undefined): string | undefined =>
  typeof context?.traceId === "string" ? acceptTraceId(context.traceId) : undefined;

const operationTarget = (action: string): { isHttp: boolean; isWs: boolean; target: string } => {
  if (action.startsWith("HTTP ")) return { isHttp: true, isWs: false, target: action.slice(5) };
  if (action.startsWith("WS ")) return { isHttp: false, isWs: true, target: action.slice(3) };
  return { isHttp: false, isWs: false, target: action };
};

interface OperationEvent {
  status: number;
  durationMs: number;
  identifier: string;
  action: string;
  level: LogLevel;
  createdAt: number;
  traceId?: string;
}

interface OperationText {
  body: string;
  scope: string;
  replay: boolean;
}

const operationBody = (
  action: string,
  status: number,
  durationMs: number,
  slowOperationMs: number
): OperationText => {
  const { isHttp, isWs, target } = operationTarget(action);
  const replay = target.endsWith(" (replay)");
  const command = replay ? target.slice(0, -" (replay)".length) : target;
  const slow = durationMs >= slowOperationMs;
  if (isHttp) {
    const state = status >= 400 ? "接口请求失败" : slow ? "接口请求较慢" : "接口请求完成";
    return { body: `${state} ${command}`, scope: "接口", replay };
  }
  if (isWs) {
    const state = status >= 400 ? "实时命令失败" : slow ? "实时命令较慢" : "实时命令完成";
    return {
      body: `${state}${replay ? "（重放）" : ""} ${command}`,
      scope: "实时",
      replay,
    };
  }
  const state = status >= 400 ? "操作失败" : slow ? "操作较慢" : "操作完成";
  return { body: `${state} ${command}`, scope: "系统", replay };
};

const operationAttributes = ({
  action,
  status,
  durationMs,
  identifier,
  scope,
  replay,
}: {
  action: string;
  status: number;
  durationMs: number;
  identifier: string;
  scope: string;
  replay: boolean;
}): Record<string, unknown> => {
  const { isHttp, isWs, target } = operationTarget(action);
  const command = replay ? target.slice(0, -" (replay)".length) : target;
  const attributes: Record<string, unknown> = {
    "log.kind": "operation",
    "log.scope": scope,
    "operation.action": action,
    "operation.identifier": identifier,
    "operation.status": status,
    duration_ms: durationMs,
    ...(replay ? { "operation.replay": true } : {}),
  };
  if (isHttp) {
    const [method, ...path] = command.split(" ");
    attributes["http.request.method"] = method;
    attributes["url.path"] = path.join(" ") || "/";
    attributes["http.response.status_code"] = status;
  } else if (isWs) {
    attributes["messaging.operation.name"] = command;
  }
  return attributes;
};

export { redactData, describeError, sanitizeLogText } from "./Sentry";

export class EventLogger {
  private readonly console: ConsoleLogSink;
  private readonly sinks: LogSink[];
  private readonly otlpExporter?: OtlpExporter;
  private readonly minimumLevel: LogLevel;
  private readonly slowOperationMs: number;
  private readonly operationLogging: OperationLogging;
  private readonly now: () => number;
  /** 节流状态：键 → 上次放行时刻与其后被压制的条数；Map 的插入序即「最早放行」序。 */
  private readonly throttles = new Map<string, { at: number; suppressed: number }>();

  constructor(
    output?: LogOutputLike,
    now: () => number = () => Date.now(),
    otlpExporter?: OtlpExporter,
    level: LogLevel = resolveLogLevel().toUpperCase() as LogLevel,
    options: EventLoggerOptions = {}
  ) {
    this.now = now;
    this.console =
      options.console ?? new ConsoleLogSink(output === undefined ? {} : { output, color: false });
    this.sinks = options.sinks ?? [];
    this.otlpExporter = otlpExporter;
    this.minimumLevel = level;
    this.slowOperationMs = Math.max(1, options.slowOperationMs ?? 1_000);
    this.operationLogging = options.operationLogging ?? "errors";
  }

  get exporter(): OtlpExporter | undefined {
    return this.otlpExporter;
  }

  private isEnabled(level: LogLevel): boolean {
    return isLogLevelEnabled(LOWER_LEVEL[this.minimumLevel], LOWER_LEVEL[level]);
  }

  private dispatch(record: OtelLogRecord): void {
    for (const sink of this.sinks) {
      try {
        sink.write(record);
      } catch {
        // Sink 自身失败必须降级为静默丢弃；日志出口不能反过来打断业务。
      }
    }
  }

  private enqueueOtlp(record: OtelLogRecord, level: LogLevel): void {
    if (!this.otlpExporter?.isEnabled || level === "DEBUG") return;
    this.otlpExporter.enqueue(record);
  }

  private emitSystem(
    level: LogLevel,
    message: string,
    context: Record<string, unknown> | undefined,
    createdAt: number,
    rawError?: unknown
  ): void {
    if (!this.isEnabled(level)) return;
    const body = redactLogText(message);
    const safeContext = context ? (redactData(context) as Record<string, unknown>) : {};
    const traceId = traceIdOf(safeContext);
    const { attributes, exception } = splitException(safeContext);
    const scope = inferSystemScope(body, safeContext);
    const identifier = safeContext.identifier ?? safeContext.connectionId ?? safeContext.roomId;
    if (typeof identifier === "string" && attributes.identifier === undefined)
      attributes.identifier = sanitizeLogText(identifier, 64);
    const record = createOtelLogRecord({
      createdAt,
      level: LOWER_LEVEL[level],
      body,
      attributes: { ...attributes, "log.kind": "system", "log.scope": scope },
      traceId,
    });
    this.dispatch(record);
    if (level !== "DEBUG") {
      this.console.write({
        createdAt,
        level: LOWER_LEVEL[level],
        scope,
        message: body,
        fields: scalarFields(safeContext, [
          "roomId",
          "playerId",
          "connectionId",
          "attempt",
          "signal",
          "port",
          "saved",
          "restored",
          "discarded",
        ]),
        traceId,
        error: exception?.display,
      });
      this.enqueueOtlp(record, level);
      if (isServerSentryEnabled()) {
        // 错误级只走异常事件一条路：再写一条 Sentry log 会让同一个错误计两次。
        if (level === "ERROR") {
          if (rawError instanceof Error) captureServerException(rawError, safeContext);
          else captureServerMessage(body, "error", safeContext);
        } else captureServerLog(body, SENTRY_LEVEL[level], safeContext);
      }
    }
  }

  /** 一次操作的各出口依次编排：本地与 OTLP 日志、控制台、指标与 Sentry span、OTLP span。 */
  private emitOperation(operation: OperationEvent): void {
    const text = operationBody(
      operation.action,
      operation.status,
      operation.durationMs,
      this.slowOperationMs
    );
    this.writeOperationLog(operation, text);
    this.writeOperationConsole(operation, text);
    this.emitOperationTelemetry(operation);
  }

  /** 日志记录：本地文件与 OTLP 的过滤相互独立，记录只按真实级别构造一次，各出口各自判断是否收。 */
  private writeOperationLog(
    { action, status, durationMs, identifier, level, createdAt, traceId }: OperationEvent,
    { body, scope, replay }: OperationText
  ): void {
    const slow = durationMs >= this.slowOperationMs;
    // 本地文件的取舍：默认只留失败与慢操作；成功操作降为 debug 档，随详细度调高才出现。
    let structuredLevel: LogLevel = level;
    if (level === "INFO" && this.operationLogging === "errors" && !slow && status < 400)
      structuredLevel = "DEBUG";
    const toLocal = this.isEnabled(structuredLevel);
    const toOtlp = !!this.otlpExporter?.isEnabled && level !== "DEBUG";
    if (!toLocal && !toOtlp) return;
    const record = createOtelLogRecord({
      createdAt,
      level: LOWER_LEVEL[level],
      body,
      attributes: operationAttributes({ action, status, durationMs, identifier, scope, replay }),
      traceId,
    });
    if (toLocal) this.dispatch(record);
    if (toOtlp) this.enqueueOtlp(record, level);
  }

  /** 控制台只给人看失败与慢操作；成功请求永不逐条打印。 */
  private writeOperationConsole(
    { status, durationMs, identifier, level, createdAt, traceId }: OperationEvent,
    { body, scope }: OperationText
  ): void {
    const slow = durationMs >= this.slowOperationMs;
    if (!(level === "WARN" || level === "ERROR" || (level === "INFO" && slow))) return;
    if (!this.isEnabled(level)) return;
    this.console.write({
      createdAt,
      level: LOWER_LEVEL[level],
      scope,
      message: body,
      fields: [
        ["status", status],
        ["durationMs", durationMs],
        ["identifier", identifier],
      ],
      traceId,
    });
  }

  /** 指标与 span 不因本地过滤而缺失（只有调试级跳过 OTLP span）。 */
  private emitOperationTelemetry({
    status,
    durationMs,
    identifier,
    action,
    level,
    createdAt,
    traceId,
  }: OperationEvent): void {
    captureServerOperation({
      name: action,
      durationMs,
      status,
      startTime: createdAt - durationMs,
      attributes: {
        "operation.identifier": identifier,
        ...(traceId ? { "trace.id": traceId } : {}),
      },
    });
    countServerMetric("bakagame.operations", 1, { status, operation: action });
    recordServerMetric("bakagame.operation.duration", durationMs, {
      status,
      operation: action,
    });

    if (this.otlpExporter?.isEnabled && level !== "DEBUG") {
      this.otlpExporter.enqueueSpan({
        traceId,
        name: action,
        startTime: createdAt - durationMs,
        endTime: createdAt,
        // 入站 HTTP 请求是服务端跨度；WS 命令与其余操作是进程内跨度。
        kind: action.startsWith("HTTP ") ? "server" : "internal",
        attributes: {
          "http.response.status_code": status,
          "operation.identifier": identifier,
          "operation.action": action,
          ...(traceId ? { "trace.id": traceId } : {}),
        },
        status: status >= 400 ? "ERROR" : "OK",
      });
    }
  }

  debug(message: string, context?: Record<string, unknown>) {
    if (!this.isEnabled("DEBUG")) return;
    const createdAt = this.now();
    const safeContext = context ? (redactData(context) as Record<string, unknown>) : {};
    const { attributes } = splitException(safeContext);
    const body = redactLogText(message);
    const scope = inferSystemScope(body, safeContext);
    this.dispatch(
      createOtelLogRecord({
        createdAt,
        level: "debug",
        body,
        attributes: { ...attributes, "log.kind": "system", "log.scope": scope },
        traceId: traceIdOf(safeContext),
      })
    );
  }

  info(message: string, context?: Record<string, unknown>) {
    this.emitSystem("INFO", message, context, this.now());
  }

  warn(message: string, context?: Record<string, unknown>) {
    this.emitSystem("WARN", message, context, this.now());
  }

  /**
   * 突发告警按键节流：同一个键在窗口内只记一条，被压制的条数计入指标，窗口过后下一次放行时
   * 附带 `suppressed`。用于「同一件事成百上千次」的预期安全事件（如客户端完整性拒绝），
   * 否则一次扫描或一批旧版客户端就把告警配额与文件日志占满。不需要定时器：压制只发生在下一次调用里结算。
   */
  warnThrottled(key: string, windowMs: number, message: string, context?: Record<string, unknown>) {
    const now = this.now();
    const state = this.throttles.get(key);
    if (state && now - state.at < windowMs) {
      state.suppressed += 1;
      countServerMetric("bakagame.log.suppressed", 1, { key });
      return;
    }
    this.throttles.delete(key);
    this.throttles.set(key, { at: now, suppressed: 0 });
    if (this.throttles.size > MAX_THROTTLE_KEYS)
      this.throttles.delete(this.throttles.keys().next().value!);
    this.emitSystem(
      "WARN",
      message,
      state?.suppressed ? { ...context, suppressed: state.suppressed } : context,
      now
    );
  }

  error(message: string, context?: Record<string, unknown>) {
    this.emitSystem("ERROR", message, context, this.now(), context?.error);
  }

  /**
   * 本地专用输出：只写控制台，不进结构化出口、OTLP 或 Sentry，也不做脱敏拦截。
   * 仅供必须保留明文的开发期输出（登录验证码）；调用方不得夹带其它用户数据。
   */
  localInfo(message: string) {
    this.console.write({
      createdAt: this.now(),
      level: "info",
      scope: "开发",
      message,
      fields: [],
      unbounded: true,
    });
  }

  section(title: string) {
    this.console.section(title);
  }

  logOperation({
    status = 200,
    durationMs = 0,
    identifier = "system",
    action,
    level,
    createdAt = this.now(),
    traceId,
  }: {
    status?: number;
    durationMs?: number;
    identifier?: string;
    action: string;
    /** 缺省按状态码走 `levelForStatus`；只有口径之外的特例（如扫描探测降为 debug）才显式传入。 */
    level?: LogLevel;
    createdAt?: number;
    traceId?: string;
  }) {
    this.emitOperation({
      status,
      durationMs,
      identifier: sanitizeLogText(identifier, 64),
      action,
      level: level ?? levelForStatus(status),
      createdAt,
      traceId: acceptTraceId(traceId),
    });
  }

  async write(entry: LogEntry): Promise<void> {
    const level = getEventLevel(entry);
    if (!this.isEnabled(level)) return;
    const headline = EVENT_LABELS[entry.type] ?? `事件 ${entry.type}`;
    const payload = entry.payload ? redactData(entry.payload) : undefined;
    const attributes: Record<string, unknown> = {
      "log.kind": "event",
      "log.scope": eventScope(entry.type),
      "event.name": entry.type,
      ...(entry.roomId ? { roomId: entry.roomId } : {}),
      ...(entry.playerId ? { playerId: entry.playerId } : {}),
      ...(payload !== undefined ? { payload } : {}),
    };
    const record = createOtelLogRecord({
      createdAt: entry.createdAt,
      level: LOWER_LEVEL[level],
      body: headline,
      attributes,
    });
    this.dispatch(record);

    const consoleVisible =
      level === "WARN" || level === "ERROR" || CONSOLE_EVENT_TYPES.has(entry.type);
    if (consoleVisible) {
      this.console.write({
        createdAt: entry.createdAt,
        level: LOWER_LEVEL[level],
        scope: eventScope(entry.type),
        message: headline,
        fields: scalarFields(
          {
            ...(entry.roomId ? { roomId: entry.roomId } : {}),
            ...(entry.playerId ? { playerId: entry.playerId } : {}),
          },
          ["roomId", "playerId"]
        ),
      });
    }

    this.enqueueOtlp(record, level);
    if (isServerSentryEnabled()) {
      captureServerLog(headline, SENTRY_LEVEL[level], {
        event: entry.type,
        roomId: entry.roomId,
        playerId: entry.playerId,
        ...(isRecord(payload) ? payload : {}),
      });
    }
    countServerMetric("bakagame.events", 1, { event: entry.type, level });
  }

  async flush(): Promise<void> {
    await Promise.all(
      this.sinks.map(async (sink) => {
        await sink.flush?.();
      })
    );
  }

  async close(): Promise<void> {
    await Promise.all(
      this.sinks.map(async (sink) => {
        await sink.close?.();
      })
    );
  }
}
