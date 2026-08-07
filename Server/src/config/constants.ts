// ==================== 服务端全局常量配置 ====================

/** 房间无活动清理超时时间（10分钟） */
export const ROOM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** 出题人断线重连超时时间（60秒） */
export const QUESTIONER_RECONNECT_TIMEOUT_MS = 60 * 1000;

/** 房间聊天记录最大保留条数 */
export const CHAT_LIMIT = 200;

/** 测试模式默认词对（用于快速跳转阶段） */
export const TEST_MODE_DEFAULT_WORD: [string, string] = ["苹果", "香蕉"];

/** 测试房间玩家数上限（含机器人），防止误触把房间撑爆 */
export const TEST_MODE_MAX_PLAYERS = 12;

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
