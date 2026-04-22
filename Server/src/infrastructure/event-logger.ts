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

const FIELD_LABELS: Record<string, string> = {
  allowSpectators: "允许旁观",
  blankHint: "白板提示",
  civilianWord: "平民词",
  code: "错误码",
  commit: "提交哈希",
  connectionCount: "连接数",
  connectionId: "连接",
  counts: "票数统计",
  day: "天数",
  errorMessage: "错误信息",
  errorName: "错误类型",
  guessedWords: "猜词",
  hasAngel: "天使",
  hasBlank: "白板",
  hostPlayerId: "房主",
  joinedAs: "加入身份",
  kickedPlayerId: "被踢玩家",
  leaders: "最高票玩家",
  listenAddress: "监听地址",
  maxUndercoverCount: "最大卧底数",
  membership: "席位",
  name: "名称",
  online: "在线",
  onlineCount: "在线人数",
  onlinePlayerCount: "在线玩家数",
  phase: "阶段",
  playerCount: "玩家数",
  playerId: "玩家",
  ready: "准备",
  reason: "原因",
  requestId: "请求",
  resolution: "处理结果",
  role: "角色",
  roleConfig: "阵营配置",
  roomCount: "房间数",
  roomId: "房间",
  serverUrl: "服务地址",
  sessionToken: "会话令牌",
  signal: "信号",
  spectator: "旁观",
  started: "已开局",
  success: "成功",
  targetId: "目标玩家",
  targetPlayerId: "目标玩家",
  tieBreak: "平票PK",
  undercoverCount: "卧底数",
  undercoverWord: "卧底词",
  userName: "用户名",
  version: "版本",
  visibility: "可见性",
  winner: "胜方",
  words: "词语",
};

const VALUE_LABELS: Record<string, Record<string, string>> = {
  membership: {
    active: "正式玩家",
    spectator: "旁观者",
    kicked: "已踢出",
  },
  phase: {
    waiting: "等待中",
    assigningQuestioner: "指定出题人",
    wordSubmission: "出题阶段",
    description: "描述阶段",
    voting: "投票阶段",
    tieBreak: "平票PK",
    night: "夜晚阶段",
    daybreak: "天亮了",
    blankGuess: "白板猜词",
    gameOver: "游戏结束",
  },
  reason: {
    empty: "房间内已无人在线",
    idle_timeout: "房间闲置超时",
  },
  resolution: {
    wait: "等待重连",
    eliminate: "淘汰并踢出",
  },
  role: {
    civilian: "平民",
    undercover: "卧底",
    angel: "天使",
    blank: "白板",
  },
  signal: {
    SIGINT: "控制台中断",
    SIGTERM: "终止信号",
  },
  visibility: {
    public: "公开",
    private: "私密",
  },
  winner: {
    good: "好人阵营",
    undercover: "卧底阵营",
    blank: "白板",
    aborted: "中断",
  },
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

const formatTimestamp = (createdAt: number) => {
  const date = new Date(createdAt);

  return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())} ${padNumber(date.getHours())}:${padNumber(date.getMinutes())}:${padNumber(date.getSeconds())}.${padNumber(date.getMilliseconds(), 3)}`;
};

const formatFieldName = (field: string) =>
  FIELD_LABELS[field] ??
  field
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replaceAll("-", "_");

const formatScalar = (field: string, value: string | number | boolean | null | undefined) => {
  if (value == null) {
    return "空";
  }

  if (typeof value === "boolean") {
    return value ? "是" : "否";
  }

  if (typeof value === "number") {
    return String(value);
  }

  return VALUE_LABELS[field]?.[value] ?? value;
};

const formatValue = (field: string, value: unknown): string => {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }

    return `[${value.map((item) => formatValue(field, item)).join(" / ")}]`;
  }

  if (isRecord(value)) {
    const parts = Object.entries(value)
      .filter(([, nestedValue]) => nestedValue !== undefined)
      .map(
        ([nestedKey, nestedValue]) =>
          `${formatFieldName(nestedKey)}=${formatValue(nestedKey, nestedValue)}`,
      );

    return parts.length > 0 ? `{${parts.join(", ")}}` : "{}";
  }

  return formatScalar(field, value as string | number | boolean | null | undefined);
};

const formatContext = (context?: Record<string, unknown>) =>
  !context
    ? ""
    : Object.entries(context)
        .filter(([, value]) => value !== undefined)
        .map(([field, value]) => `${formatFieldName(field)}=${formatValue(field, value)}`)
        .join(", ");

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

export const formatSystemLog = ({
  level,
  message,
  createdAt,
  context,
}: {
  level: LogLevel;
  message: string;
  createdAt: number;
  context?: Record<string, unknown>;
}) => {
  const detail = formatContext(context);

  return [
    `[${formatTimestamp(createdAt)}]`,
    `[${level}]`,
    message,
    detail ? `详情: ${detail}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
};

export const formatLogEntry = (entry: LogEntry, level = getEventLevel(entry)): string => {
  const headline = EVENT_LABELS[entry.type] ?? entry.type;
  const contextParts = [
    entry.roomId ? `房间=${entry.roomId}` : undefined,
    entry.playerId ? `玩家=${entry.playerId}` : undefined,
  ].filter(Boolean);

  const detail =
    entry.payload === undefined
      ? ""
      : isRecord(entry.payload)
        ? formatContext(entry.payload)
        : formatValue("payload", entry.payload);

  return [
    `[${formatTimestamp(entry.createdAt)}]`,
    `[${level}]`,
    headline,
    `(${entry.type})`,
    ...contextParts,
    detail ? `详情: ${detail}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
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

  async write(entry: LogEntry): Promise<void> {
    const level = getEventLevel(entry);
    this.output[LEVEL_METHODS[level]](formatLogEntry(entry, level));
  }
}
