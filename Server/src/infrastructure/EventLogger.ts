export interface LogEntry {
  type: string;
  createdAt: number;
  roomId?: string;
  playerId?: string;
  payload?: unknown;
}

export type LogLevel = "INFO" | "WARN" | "ERROR";

type LogEmitter = (message: string) => void;

interface LogOutput {
  info: LogEmitter;
  warn: LogEmitter;
  error: LogEmitter;
}

type LogOutputLike = LogEmitter | Partial<LogOutput>;

const EVENT_LABELS: Record<string, string> = {
  "chat.sent": "聊天消息已发送",
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
  "room.join": "收到加入房间请求",
  "room.joined": "玩家已加入房间",
  "room.reconnect": "收到房间重连请求",
  "room.reconnected": "玩家已重连房间",
  "room.settings_changed": "房间设置已更新",
  "room.updateSettings": "收到房间设置更新请求",
};

const LEVEL_METHODS: Record<LogLevel, keyof LogOutput> = {
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
};

const defaultOutput: LogOutput = {
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeOutput = (output: LogOutputLike = defaultOutput): LogOutput => {
  if (typeof output === "function") {
    return {
      info: output,
      warn: output,
      error: output,
    };
  }

  return {
    info: output.info ?? defaultOutput.info,
    warn: output.warn ?? output.info ?? defaultOutput.warn,
    error: output.error ?? output.warn ?? output.info ?? defaultOutput.error,
  };
};

const padNumber = (value: number, length = 2) => value.toString().padStart(length, "0");

// 高精度耗时格式化（支持微秒 µs、毫秒 ms、秒 s，统一右对齐 13 位）
export const formatDuration = (durationMs = 0): string => {
  if (durationMs <= 0) {
    return "      0.000µs";
  }
  if (durationMs < 1) {
    const micros = (durationMs * 1000).toFixed(3);
    return `${micros}µs`.padStart(13, " ");
  }
  if (durationMs < 1000) {
    const millis = durationMs.toFixed(3);
    return `${millis}ms`.padStart(13, " ");
  }
  const secs = (durationMs / 1000).toFixed(3);
  return `${secs}s`.padStart(13, " ");
};

// 统一时间戳格式化为标准 ISO-8601 UTC 格式
const formatTimestamp = (createdAt: number) => new Date(createdAt).toISOString();

const getEventLevel = (entry: LogEntry): LogLevel => {
  switch (entry.type) {
    case "player.disconnect":
      return "WARN";
    case "room.closed":
      return isRecord(entry.payload) && entry.payload.reason === "empty" ? "INFO" : "WARN";
    default:
      return "INFO";
  }
};

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
  return text.replace(/[\r\n\x00-\x1f\x7f]/g, " ").slice(0, maxLength);
};

export const redactData = (data: unknown, depth = 0, maxProperties = 32): unknown => {
  if (data == null) return data;
  if (depth >= 5) return "[MAX_DEPTH_EXCEEDED]";
  if (typeof data !== "object") return data;
  if (Array.isArray(data)) {
    return data.slice(0, maxProperties).map((item) => redactData(item, depth + 1, maxProperties));
  }

  const redacted: Record<string, unknown> = {};
  const entries = Object.entries(data as Record<string, unknown>);
  const limit = Math.min(entries.length, maxProperties);

  for (let i = 0; i < limit; i++) {
    const [key, value] = entries[i];
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      if (key.toLowerCase() === "password") {
        redacted[key] = "***[REDACTED]";
      } else if (typeof value === "string" && value.length > 8) {
        redacted[key] = `${value.slice(0, 4)}***[REDACTED]`;
      } else {
        redacted[key] = "***[REDACTED]";
      }
    } else {
      redacted[key] = redactData(value, depth + 1, maxProperties);
    }
  }

  if (entries.length > maxProperties) {
    redacted["_truncated"] = `[TRUNCATED_${entries.length - maxProperties}_PROPERTIES]`;
  }

  return redacted;
};

export const describeError = (error: unknown): Record<string, unknown> => {
  if (error instanceof Error) {
    const desc: Record<string, unknown> = {
      errorName: error.name,
      errorMessage: error.message,
    };
    if (error.stack) {
      desc.stack = error.stack;
    }
    if ("cause" in error && error.cause) {
      desc.cause = describeError(error.cause);
    }
    return desc;
  }

  return {
    errorMessage: typeof error === "string" ? error : String(error),
  };
};

// 系统日志列格式化
export const formatSystemLog = ({
  level,
  message,
  createdAt,
  context,
  durationMs = 0,
  status,
}: {
  level: LogLevel;
  message: string;
  createdAt: number;
  context?: Record<string, unknown>;
  durationMs?: number;
  status?: number;
}) => {
  const statusCode = status ?? (level === "ERROR" ? 500 : level === "WARN" ? 400 : 200);
  const timestampStr = formatTimestamp(createdAt);
  const durationStr = formatDuration(durationMs);
  const rawIdentifier = (
    (context?.connectionId as string) ??
    (context?.roomId as string) ??
    (context?.playerId as string) ??
    (context?.ip as string) ??
    "system"
  );
  const identifierStr = sanitizeLogText(String(rawIdentifier), 32).padStart(15, " ");
  const actionStr = `SYS ${sanitizeLogText(message, 1000)}`;

  const cleanedContext = context ? (redactData(context) as Record<string, unknown>) : undefined;
  const extraContext = cleanedContext
    ? Object.fromEntries(
        Object.entries(cleanedContext).filter(
          ([k]) => !["connectionId", "roomId", "playerId", "ip"].includes(k),
        ),
      )
    : undefined;

  const extraStr =
    extraContext && Object.keys(extraContext).length > 0
      ? ` | ${sanitizeLogText(JSON.stringify(extraContext), 2048)}`
      : "";

  return `[BAKA] ${timestampStr} | ${statusCode} | ${durationStr} | ${identifierStr} | ${actionStr}${extraStr}`;
};

// 领域事件日志列格式化
export const formatLogEntry = (
  entry: LogEntry & { durationMs?: number; status?: number },
  level = getEventLevel(entry),
): string => {
  const headline = EVENT_LABELS[entry.type] ?? entry.type;
  const statusCode = entry.status ?? (level === "ERROR" ? 500 : level === "WARN" ? 400 : 200);
  const timestampStr = formatTimestamp(entry.createdAt);
  const durationStr = formatDuration(entry.durationMs ?? 0);
  const rawIdentifier = entry.roomId ?? entry.playerId ?? "system";
  const identifierStr = sanitizeLogText(String(rawIdentifier), 32).padStart(15, " ");
  const actionStr = `EVENT ${sanitizeLogText(entry.type, 64)} (${sanitizeLogText(headline, 64)})`;

  const cleanedPayload = entry.payload ? redactData(entry.payload) : undefined;
  const payloadStr =
    cleanedPayload &&
    typeof cleanedPayload === "object" &&
    Object.keys(cleanedPayload as object).length > 0
      ? ` | ${sanitizeLogText(JSON.stringify(cleanedPayload), 2048)}`
      : "";

  return `[BAKA] ${timestampStr} | ${statusCode} | ${durationStr} | ${identifierStr} | ${actionStr}${payloadStr}`;
};

import type { OtlpExporter } from "./OtlpExporter";

export class EventLogger {
  private readonly output: LogOutput;
  private readonly otlpExporter?: OtlpExporter;

  constructor(
    output: LogOutputLike = defaultOutput,
    private readonly now: () => number = () => Date.now(),
    otlpExporter?: OtlpExporter,
  ) {
    this.output = normalizeOutput(output);
    this.otlpExporter = otlpExporter;
  }

  get exporter(): OtlpExporter | undefined {
    return this.otlpExporter;
  }

  private emit(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
    createdAt = this.now(),
  ) {
    this.output[LEVEL_METHODS[level]](
      formatSystemLog({
        level,
        message,
        createdAt,
        context,
      }),
    );

    if (this.otlpExporter?.isEnabled) {
      const traceId = typeof context?.traceId === "string" ? context.traceId : undefined;
      this.otlpExporter.enqueue({
        timestamp: createdAt,
        level,
        message,
        traceId,
        attributes: context ? (redactData(context) as Record<string, unknown>) : undefined,
      });

      if (level === "ERROR" && traceId) {
        this.otlpExporter.enqueueSpan({
          traceId,
          name: message,
          startTime: createdAt - 1,
          endTime: createdAt,
          attributes: context ? (redactData(context) as Record<string, unknown>) : undefined,
          status: "ERROR",
          statusMessage: message,
        });
      }
    }
  }

  info(message: string, context?: Record<string, unknown>) {
    this.emit("INFO", message, context);
  }

  warn(message: string, context?: Record<string, unknown>) {
    this.emit("WARN", message, context);
  }

  error(message: string, context?: Record<string, unknown>) {
    this.emit("ERROR", message, context);
  }

  // 后端操作日志输出
  logOperation({
    status = 200,
    durationMs = 0,
    identifier = "system",
    action,
    level = "INFO",
    createdAt = this.now(),
  }: {
    status?: number;
    durationMs?: number;
    identifier?: string;
    action: string;
    level?: LogLevel;
    createdAt?: number;
  }) {
    const timestampStr = formatTimestamp(createdAt);
    const durationStr = formatDuration(durationMs);
    const idStr = identifier.padStart(15, " ");
    const line = `[BAKA] ${timestampStr} | ${status} | ${durationStr} | ${idStr} | ${action}`;
    this.output[LEVEL_METHODS[level]](line);

    if (this.otlpExporter?.isEnabled) {
      this.otlpExporter.enqueueSpan({
        name: action,
        startTime: createdAt - durationMs,
        endTime: createdAt,
        attributes: {
          "http.status_code": status,
          "operation.identifier": identifier,
          "operation.action": action,
        },
        status: status >= 400 ? "ERROR" : "OK",
      });
    }
  }

  async write(entry: LogEntry): Promise<void> {
    const level = getEventLevel(entry);
    this.output[LEVEL_METHODS[level]](formatLogEntry(entry, level));

    if (this.otlpExporter?.isEnabled) {
      this.otlpExporter.enqueue({
        timestamp: entry.createdAt,
        level,
        message: `EVENT ${entry.type}`,
        attributes: {
          roomId: entry.roomId,
          playerId: entry.playerId,
          payload: entry.payload ? (redactData(entry.payload) as Record<string, unknown>) : undefined,
        },
      });
    }
  }
}
