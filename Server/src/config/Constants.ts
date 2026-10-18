// ==================== 服务端全局常量配置 ====================

/** 房间无活动清理超时时间（10分钟） */
export const ROOM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** 网络短暂断开后的空房宽限期，避免移动端切后台立即丢失房间。 */
export const ROOM_EMPTY_GRACE_PERIOD_MS = 90 * 1000;

/** 出题人断线重连超时时间（60秒） */
export const QUESTIONER_RECONNECT_TIMEOUT_MS = 60 * 1000;

/** 房主断线重连超时时间（60秒） */
export const HOST_RECONNECT_TIMEOUT_MS = 60 * 1000;

/** 玩家掉线清理超时时间（3分钟） */
export const PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS = 3 * 60 * 1000;

/** 房间聊天记录最大保留条数 */
export const CHAT_LIMIT = 20;

/**
 * 私密房密码尝试配额：同一连接对同一房间在统计窗口内最多尝试的次数。
 * 在校验密码之前计数，超限后正确密码同样被拒；缺少密码不计数。
 */
export const JOIN_PASSWORD_MAX_ATTEMPTS = 5;
export const JOIN_PASSWORD_WINDOW_MS = 60 * 1000;

/** 阶段淘汰结果的最短展示时间，期间不能跳过结算返回等待房间。 */
export const PHASE_RESULT_DISPLAY_MS = 1_500;

/** 测试模式默认词对（用于快速跳转阶段） */
export const TEST_MODE_DEFAULT_WORD: [string, string] = ["苹果", "香蕉"];

/** 测试房间玩家数上限（含机器人），防止误触把房间撑爆 */
export const TEST_MODE_MAX_PLAYERS = 12;

/** 单条测试人机增减指令的数量上限：房间不限制总人数，但仍需约束单次批量规模 */
export const TEST_BOT_BATCH_LIMIT = 64;

/** 机器人名字后缀，按顺序取用，取完后退化为数字编号 */
export const BOT_NAME_SUFFIXES = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K"];

/** 机器人发言用的模板，按索引轮换，避免每个机器人说同一句 */
export const BOT_DESCRIPTION_TEMPLATES = [
  "这个东西挺常见的，生活里经常能见到。",
  "我觉得它的样子比较有特点，不太好形容。",
  "它用处不少，很多场合都会用到。",
  "我印象里它的口感或手感还不错。",
  "描述起来有点难，但大家应该都熟悉。",
  "它给我的感觉偏日常，不算稀奇。",
];

/**
 * HTTP 请求体上限（Bun 原生 `maxRequestBodySize`，缺省 128MB 形同不设）。
 * 合法调用里最大的是 Sentry 隧道信封（256KB）与云同步设置（32KB），1MB 已留足余量；
 * 与 WS 侧 256KB 单帧上限同一口径，超限由运行时直接回 413，不进业务解析。
 */
export const HTTP_MAX_REQUEST_BODY_BYTES = 1024 * 1024;
