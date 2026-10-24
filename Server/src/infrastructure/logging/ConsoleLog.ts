import type { StructuredLogLevel } from "../StructuredLog";

export interface LogOutput {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export type LogOutputLike = ((message: string) => void) | Partial<LogOutput>;

export interface ConsoleLogEntry {
  createdAt: number;
  level: StructuredLogLevel;
  scope: string;
  message: string;
  fields?: Array<[key: string, value: unknown]>;
  traceId?: string;
  error?: unknown;
  /** 仅开发期明文通道使用：不截断正文（验证码必须完整可见）。 */
  unbounded?: boolean;
}

export interface ConsoleLogOptions {
  output?: LogOutputLike;
  color?: boolean;
}

const LEVEL_WIDTH = 5;
const SCOPE_WIDTH = 6;
const MESSAGE_MAX_WIDTH = 48;
const FIELD_KEY_WIDTH = 8;
const FIELD_VALUE_WIDTH = 16;
const MAX_FIELDS = 3;
const SEPARATOR_WIDTH = 96;
const DEDUPE_WINDOW_MS = 5_000;
/** 持续发生的同一告警至少每 30 秒重新露一次面，避免被静默吞掉。 */
const DEDUPE_REEMIT_MS = 30_000;

const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  red: "\u001b[1;31m",
  yellow: "\u001b[33m",
  green: "\u001b[32m",
  cyan: "\u001b[36m",
  magenta: "\u001b[35m",
  gray: "\u001b[90m",
};

const LEVEL_STYLE: Record<StructuredLogLevel, string> = {
  debug: ANSI.gray,
  info: ANSI.cyan,
  warn: ANSI.yellow,
  error: ANSI.red,
};

const FIELD_LABELS: Record<string, string> = {
  status: "状态",
  durationMs: "耗时",
  method: "方法",
  path: "路径",
  command: "命令",
  roomId: "房间",
  playerId: "玩家",
  connectionId: "连接",
  requestId: "请求",
  identifier: "标识",
  attempt: "尝试",
  signal: "信号",
  serverUrl: "地址",
  listenAddress: "监听",
  port: "端口",
  saved: "已保存",
  restored: "已恢复",
  discarded: "已丢弃",
  action: "操作",
  repeats: "重复",
  frame: "位置",
  exception: "异常",
  error: "原因",
};

const defaultOutput: LogOutput = {
  info: (message) => process.stdout.write(`${message}\n`),
  warn: (message) => process.stderr.write(`${message}\n`),
  error: (message) => process.stderr.write(`${message}\n`),
};

export const normalizeLogOutput = (output: LogOutputLike = defaultOutput): LogOutput => {
  if (typeof output === "function") {
    return { info: output, warn: output, error: output };
  }
  return {
    info: output.info ?? defaultOutput.info,
    warn: output.warn ?? output.info ?? defaultOutput.warn,
    error: output.error ?? output.warn ?? output.info ?? defaultOutput.error,
  };
};

const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

const isZeroWidth = (codePoint: number): boolean =>
  (codePoint >= 0x0300 && codePoint <= 0x036f) ||
  (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
  codePoint === 0x200d;

const isWide = (codePoint: number): boolean =>
  WIDE_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);

/** 终端显示宽度：CJK 与全角字符按 2 列计，组合符号不计宽。 */
export const displayWidth = (text: string): number => {
  let width = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    if (isZeroWidth(codePoint)) continue;
    width += isWide(codePoint) ? 2 : 1;
  }
  return width;
};

export const truncateToWidth = (text: string, maxWidth: number): string => {
  if (maxWidth <= 0) return "";
  if (displayWidth(text) <= maxWidth) return text;
  let width = 0;
  let result = "";
  for (const char of text) {
    const charWidth = displayWidth(char);
    if (width + charWidth > maxWidth - 1) return `${result}…`;
    result += char;
    width += charWidth;
  }
  return `${result}…`;
};

const padToWidth = (text: string, width: number): string => {
  const truncated = truncateToWidth(text, width);
  return truncated + " ".repeat(Math.max(0, width - displayWidth(truncated)));
};

const oneLine = (text: string): string => text.replace(/[\r\n]+/g, " ");

const formatDurationShort = (value: unknown): string => {
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
  if (value < 1) return `${(value * 1000).toFixed(1)}µs`;
  if (value < 1000) return `${value.toFixed(1)}ms`;
  return `${(value / 1000).toFixed(2)}s`;
};

const formatFieldValue = (key: string, value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (key === "durationMs") return formatDurationShort(value);
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return value.toString();
  return undefined;
};

const firstFrame = (error: unknown): { label?: string; frame?: string } => {
  if (!error || typeof error !== "object") return {};
  const record = error as Record<string, unknown>;
  const name = typeof record.errorName === "string" ? record.errorName : undefined;
  const message = typeof record.errorMessage === "string" ? record.errorMessage : undefined;
  const label = name ? (message ? `${name}: ${message}` : name) : undefined;
  const stack = typeof record.stack === "string" ? record.stack : undefined;
  if (!stack) return { label };
  const line = stack.split("\n").find((item) => /^\s*at\s/.test(item));
  const match = line?.match(/\(?([^()\s]+:\d+:\d+)\)?\s*$/);
  if (!match) return { label };
  const parts = match[1].replaceAll("\\", "/").split("/");
  return { label, frame: parts.at(-1) };
};

export const formatConsoleLine = (
  entry: ConsoleLogEntry,
  { color }: { color: boolean }
): string => {
  const paint = (style: string, text: string) => (color ? `${style}${text}${ANSI.reset}` : text);
  const time = new Date(entry.createdAt).toISOString().slice(11, 23);
  const level = entry.level.toUpperCase().padEnd(LEVEL_WIDTH);
  const scope = padToWidth(entry.scope, SCOPE_WIDTH);
  const rawMessage = oneLine(entry.message);
  const message = entry.unbounded ? rawMessage : padToWidth(rawMessage, MESSAGE_MAX_WIDTH);
  const parts = [
    paint(ANSI.gray, time),
    paint(LEVEL_STYLE[entry.level], level),
    paint(ANSI.magenta, scope),
    paint(entry.level === "error" ? ANSI.bold : "", message),
  ];

  let shown = 0;
  for (const [key, rawValue] of entry.fields ?? []) {
    if (shown >= MAX_FIELDS) break;
    const value = formatFieldValue(key, rawValue);
    if (value === undefined) continue;
    const label = truncateToWidth(FIELD_LABELS[key] ?? key, FIELD_KEY_WIDTH);
    const pair = `${label}=${truncateToWidth(oneLine(value), FIELD_VALUE_WIDTH)}`;
    parts.push(paint(ANSI.dim, padToWidth(pair, FIELD_KEY_WIDTH + FIELD_VALUE_WIDTH + 1)));
    shown += 1;
  }

  const error = firstFrame(entry.error);
  if (error.label) parts.push(paint(ANSI.dim, `异常=${truncateToWidth(error.label, 28)}`));
  if (error.frame) parts.push(paint(ANSI.dim, `位置=${truncateToWidth(error.frame, 20)}`));
  if (entry.traceId) parts.push(paint(ANSI.gray, `追踪=${entry.traceId.slice(0, 8)}`));
  return parts.join("  ").replace(/\s+$/, "");
};

export class ConsoleLogSink {
  private readonly output: LogOutput;
  private readonly color: boolean;
  private lastKey?: string;
  private lastAt = 0;
  private lastEmitAt = 0;
  private repeats = 0;

  constructor(options: ConsoleLogOptions = {}) {
    this.output = normalizeLogOutput(options.output);
    this.color =
      options.color ?? (options.output === undefined ? process.stdout.isTTY === true : false);
  }

  write(entry: ConsoleLogEntry): void {
    const key = [
      entry.level,
      entry.scope,
      entry.message,
      entry.traceId ?? "",
      entry.error ? JSON.stringify(entry.error) : "",
      (entry.fields ?? []).map(([field, value]) => `${field}=${String(value)}`).join("|"),
    ].join("|");
    if (
      key === this.lastKey &&
      entry.createdAt - this.lastAt < DEDUPE_WINDOW_MS &&
      entry.createdAt - this.lastEmitAt < DEDUPE_REEMIT_MS
    ) {
      this.repeats += 1;
      this.lastAt = entry.createdAt;
      return;
    }

    const fields =
      this.repeats > 0
        ? [...(entry.fields ?? []), ["repeats", this.repeats + 1] as [string, unknown]]
        : entry.fields;
    this.output[entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : "info"](
      formatConsoleLine({ ...entry, fields }, { color: this.color })
    );
    this.lastKey = key;
    this.lastAt = entry.createdAt;
    this.lastEmitAt = entry.createdAt;
    this.repeats = 0;
  }

  /** 生命周期分割线：只在控制台出现，不写结构化出口。 */
  section(title: string): void {
    const label = ` ${truncateToWidth(title, 32)} `;
    const line = `──${label}${"─".repeat(Math.max(3, SEPARATOR_WIDTH - displayWidth(label) - 2))}`;
    this.output.info(this.color ? `${ANSI.dim}${line}${ANSI.reset}` : line);
  }
}
