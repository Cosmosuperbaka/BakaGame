import {
  formatStructuredLog,
  isLogLevelEnabled,
  resolveLogLevel,
  type StructuredLogLevel,
} from "./StructuredLog";

export interface LogEntry {
  type: string;
  createdAt: number;
  roomId?: string;
  playerId?: string;
  payload?: unknown;
}

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

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
  DEBUG: "info",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
};

const LOWER_LEVEL: Record<LogLevel, StructuredLogLevel> = {
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
};

/**
 * 同类操作日志的合并窗口。满载时每条命令都会写一行日志，生产剖面里这一条
 * 标准输出就占掉 5.7% 的核时间；INFO 级按「动作|状态码」每秒留一条代表，
 * WARN/ERROR 不合并，指标与 span 仍然每条上报。
 */
const OPERATION_LOG_SAMPLE_MS = 1_000;

/**
 * 默认输出只写进程流，**不经过标准 console 通道**。
 *
 * Sentry 的 `consoleLoggingIntegration` 会把 `console.warn/error` 采集为 Sentry log，
 * 而本类的 `emit` 对同一条记录已经显式调用 `captureServerLog`；两条路并行时每条
 * WARN/ERROR 在观测平台计两次，任何按日志量的阈值与趋势全部失真。所以这里定下唯一
 * 真相源：结构化记录只经 `captureServerLog` 出口，stdout/stderr 只服务本机与容器日志。
 * stdout 需求保留（INFO 走 stdout、WARN/ERROR 走 stderr，与 console 的分流一致）。
 */
const defaultOutput: LogOutput = {
  info: (message) => process.stdout.write(`${message}\n`),
  warn: (message) => process.stderr.write(`${message}\n`),
  error: (message) => process.stderr.write(`${message}\n`),
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

export { redactData, describeError, sanitizeLogText } from "./Sentry";

// 系统日志：固定字段 time/level/msg，其余诊断信息统一进 context。
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
  const rawIdentifier =
    (context?.connectionId as string) ??
    (context?.roomId as string) ??
    (context?.playerId as string) ??
    (context?.ip as string) ??
    "system";
  return formatStructuredLog({
    createdAt,
    level: LOWER_LEVEL[level],
    message,
    context: {
      status: statusCode,
      durationMs,
      identifier: sanitizeLogText(String(rawIdentifier), 64),
      ...context,
    },
  });
};

// 领域事件日志：事件名与摘要写进 msg，结构化字段留在 context。
export const formatLogEntry = (
  entry: LogEntry & { durationMs?: number; status?: number },
  level = getEventLevel(entry)
): string => {
  const headline = EVENT_LABELS[entry.type] ?? entry.type;
  const statusCode = entry.status ?? (level === "ERROR" ? 500 : level === "WARN" ? 400 : 200);
  return formatStructuredLog({
    createdAt: entry.createdAt,
    level: LOWER_LEVEL[level],
    message: `EVENT ${entry.type} (${headline})`,
    context: {
      status: statusCode,
      durationMs: entry.durationMs ?? 0,
      ...(entry.roomId ? { roomId: entry.roomId } : {}),
      ...(entry.playerId ? { playerId: entry.playerId } : {}),
      ...(entry.payload ? { payload: entry.payload } : {}),
    },
  });
};

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

export class EventLogger {
  private readonly output: LogOutput;
  private readonly otlpExporter?: OtlpExporter;
  private readonly minimumLevel: LogLevel;
  private readonly operationSamples = new Map<string, { at: number; merged: number }>();

  constructor(
    output: LogOutputLike = defaultOutput,
    private readonly now: () => number = () => Date.now(),
    otlpExporter?: OtlpExporter,
    level: LogLevel = resolveLogLevel().toUpperCase() as LogLevel
  ) {
    this.output = normalizeOutput(output);
    this.otlpExporter = otlpExporter;
    this.minimumLevel = level;
  }

  get exporter(): OtlpExporter | undefined {
    return this.otlpExporter;
  }

  private isEnabled(level: LogLevel): boolean {
    return isLogLevelEnabled(LOWER_LEVEL[this.minimumLevel], LOWER_LEVEL[level]);
  }

  private emit(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
    createdAt = this.now()
  ) {
    if (!this.isEnabled(level)) return;
    message = redactLogText(message);
    const safeContext = context ? (redactData(context) as Record<string, unknown>) : undefined;
    this.output[LEVEL_METHODS[level]](
      formatSystemLog({
        level,
        message,
        createdAt,
        context: safeContext,
      })
    );

    // debug 只落进程流：OTLP 与 Sentry 都没有对应的诊断级别，避免污染告警与趋势。
    if (level === "DEBUG") return;

    if (this.otlpExporter?.isEnabled) {
      const traceId = typeof context?.traceId === "string" ? context.traceId : undefined;
      this.otlpExporter.enqueue({
        timestamp: createdAt,
        level,
        message,
        traceId,
        attributes: safeContext,
      });

      if (level === "ERROR" && traceId) {
        this.otlpExporter.enqueueSpan({
          traceId,
          name: message,
          startTime: createdAt - 1,
          endTime: createdAt,
          attributes: safeContext,
          status: "ERROR",
          statusMessage: message,
        });
      }
    }

    if (level === "ERROR" && isServerSentryEnabled()) {
      const err = context?.error;
      if (err instanceof Error) {
        captureServerException(err, safeContext);
      } else {
        captureServerMessage(message, "error", safeContext);
      }
    }

    captureServerLog(
      message,
      level === "ERROR" ? "error" : level === "WARN" ? "warning" : "info",
      safeContext
    );
  }

  debug(message: string, context?: Record<string, unknown>) {
    this.emit("DEBUG", message, context);
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

  /**
   * 本地专用输出：只写进程 stdout，不进 OTLP / Sentry 导出通道，也不做脱敏拦截。
   * 仅供必须保留明文的开发期输出（登录验证码）；调用方不得夹带其它用户数据。
   */
  localInfo(message: string) {
    this.output.info(
      JSON.stringify({ time: formatTimestamp(this.now()), level: "info", msg: message })
    );
  }

  private writeOperationLine({
    level,
    action,
    createdAt,
    status,
    durationMs,
    identifier,
    traceId,
  }: {
    level: LogLevel;
    action: string;
    createdAt: number;
    status: number;
    durationMs: number;
    identifier: string;
    traceId?: string;
  }): void {
    if (!this.isEnabled(level)) return;
    const sampleKey = `${action}|${status}`;
    const sample = level === "INFO" ? this.operationSamples.get(sampleKey) : undefined;
    if (sample && createdAt - sample.at < OPERATION_LOG_SAMPLE_MS) {
      sample.merged += 1;
      return;
    }
    // 合并条数记在下一条代表上：窗口里被省掉的行仍然计入速率，只是不再各占一次写。
    if (level === "INFO") this.operationSamples.set(sampleKey, { at: createdAt, merged: 0 });
    this.output[LEVEL_METHODS[level]](
      formatStructuredLog({
        createdAt,
        level: LOWER_LEVEL[level],
        message: action,
        context: {
          status,
          durationMs,
          identifier,
          ...(traceId ? { traceId } : {}),
          ...(sample && sample.merged > 0 ? { merged: sample.merged + 1 } : {}),
        },
      })
    );
  }

  // 后端操作日志输出
  logOperation({
    status = 200,
    durationMs = 0,
    identifier = "system",
    action,
    level = "INFO",
    createdAt = this.now(),
    traceId,
  }: {
    status?: number;
    durationMs?: number;
    identifier?: string;
    action: string;
    level?: LogLevel;
    createdAt?: number;
    traceId?: string;
  }) {
    this.writeOperationLine({
      level,
      action,
      createdAt,
      status,
      durationMs,
      identifier,
      traceId,
    });

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
    countServerMetric("bakagame.operations", 1, {
      status,
      operation: action,
    });
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
        attributes: {
          "http.status_code": status,
          "operation.identifier": identifier,
          "operation.action": action,
          ...(traceId ? { "trace.id": traceId } : {}),
        },
        status: status >= 400 ? "ERROR" : "OK",
      });
    }
  }

  async write(entry: LogEntry): Promise<void> {
    const level = getEventLevel(entry);
    if (this.isEnabled(level)) {
      this.output[LEVEL_METHODS[level]](formatLogEntry(entry, level));

      captureServerLog(
        `EVENT ${entry.type}`,
        level === "ERROR" ? "error" : level === "WARN" ? "warning" : "info",
        {
          roomId: entry.roomId,
          playerId: entry.playerId,
          ...(isRecord(entry.payload) ? (redactData(entry.payload) as Record<string, unknown>) : {}),
        }
      );
    }
    countServerMetric("bakagame.events", 1, { event: entry.type, level });

    if (this.otlpExporter?.isEnabled && level !== "DEBUG") {
      this.otlpExporter.enqueue({
        timestamp: entry.createdAt,
        level,
        message: `EVENT ${entry.type}`,
        attributes: {
          roomId: entry.roomId,
          playerId: entry.playerId,
          payload: entry.payload
            ? (redactData(entry.payload) as Record<string, unknown>)
            : undefined,
        },
      });
    }
  }
}
