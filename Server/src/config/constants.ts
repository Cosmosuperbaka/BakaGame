// ==================== 服务端全局常量配置 ====================

/** 房间无活动清理超时时间（10分钟） */
export const ROOM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** 出题人断线重连超时时间（60秒） */
export const QUESTIONER_RECONNECT_TIMEOUT_MS = 60 * 1000;

/** 房间聊天记录最大保留条数 */
export const CHAT_LIMIT = 200;

/** 测试模式默认词对（用于快速跳转阶段） */
export const TEST_MODE_DEFAULT_WORD: [string, string] = ["苹果", "香蕉"];
