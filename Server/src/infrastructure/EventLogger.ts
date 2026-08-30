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

// 统一时间戳格式化 YYYY/MM/DD - HH:mm:ss
const formatTimestamp = (createdAt: number) => {
  const date = new Date(createdAt);

  return `${date.getFullYear()}/${padNumber(date.getMonth() + 1)}/${padNumber(date.getDate())} - ${padNumber(date.getHours())}:${padNumber(date.getMinutes())}:${padNumber(date.getSeconds())}`;
};

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

export const describeError = (error: unknown): Record<string, unknown> => {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
    };
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
  const identifierStr = (
    (context?.connectionId as string) ??
    (context?.roomId as string) ??
    (context?.playerId as string) ??
    (context?.ip as string) ??
    "system"
  ).padStart(15, " ");
  const actionStr = `SYS ${message}`;

  return `[BAKA] ${timestampStr} | ${statusCode} | ${durationStr} | ${identifierStr} | ${actionStr}`;
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
  const identifierStr = (entry.roomId ?? entry.playerId ?? "system").padStart(15, " ");
  const actionStr = `EVENT ${entry.type} (${headline})`;

  return `[BAKA] ${timestampStr} | ${statusCode} | ${durationStr} | ${identifierStr} | ${actionStr}`;
};

export class EventLogger {
  private readonly output: LogOutput;

  constructor(
    output: LogOutputLike = defaultOutput,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.output = normalizeOutput(output);
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
  }

  async write(entry: LogEntry): Promise<void> {
    const level = getEventLevel(entry);
    this.output[LEVEL_METHODS[level]](formatLogEntry(entry, level));
  }
}
