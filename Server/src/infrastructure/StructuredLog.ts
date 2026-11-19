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
export const resolveLogLevel = (raw = Bun.env.LOG_LEVEL): StructuredLogLevel => parseLogLevel(raw);

export const isLogLevelEnabled = (
  configured: StructuredLogLevel,
  level: StructuredLogLevel
): boolean => LEVEL_RANK[level] >= LEVEL_RANK[configured];
