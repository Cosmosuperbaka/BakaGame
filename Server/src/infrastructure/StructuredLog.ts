import { redactData, redactLogText } from "./Sentry";

/** 运行日志等级；生产默认 info，可用 `LOG_LEVEL` 调到 debug 或 warn。 */
export type StructuredLogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<StructuredLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export const parseLogLevel = (
  raw: string | undefined,
  fallback: StructuredLogLevel = "info"
): StructuredLogLevel => {
  const value = raw?.trim().toLowerCase();
  return value === "debug" || value === "info" || value === "warn" || value === "error"
    ? value
    : fallback;
};

/** 读取一次环境配置；写错或留空按 info 处理，不让日志配置本身挡住启动。 */
export const resolveLogLevel = (raw = Bun.env.LOG_LEVEL): StructuredLogLevel =>
  parseLogLevel(raw);

export const isLogLevelEnabled = (
  configured: StructuredLogLevel,
  level: StructuredLogLevel
): boolean => LEVEL_RANK[level] >= LEVEL_RANK[configured];

export interface StructuredLogInput {
  createdAt: number;
  level: StructuredLogLevel;
  message: string;
  context?: Record<string, unknown>;
}

/**
 * 单行 JSON：`time/level/msg` 固定在前，上下文统一放在 `context`。
 * 上下文先过统一脱敏；`JSON.stringify` 会把换行转义，保证一条记录只占一行。
 */
export const formatStructuredLog = ({
  createdAt,
  level,
  message,
  context,
}: StructuredLogInput): string => {
  const safeContext = context ? (redactData(context) as Record<string, unknown>) : undefined;
  return JSON.stringify({
    time: new Date(createdAt).toISOString(),
    level,
    msg: redactLogText(message),
    ...(safeContext && Object.keys(safeContext).length > 0 ? { context: safeContext } : {}),
  });
};
