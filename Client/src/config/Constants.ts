// ==================== 客户端全局常量配置 ====================

export const DEFAULT_SERVER_URL = "http://localhost:4850";
export const MAX_RECONNECT_DELAY_MS = 10000;
/** 重连退避的起步上限：第 n 次失败后在 [下限, 起步 * 2^n] 内随机取延迟，再被 MAX 封顶。 */
export const RECONNECT_BASE_DELAY_MS = 1000;
/** 退避随机延迟的下限：抖动取到接近 0 时也不出现紧密重连。 */
export const RECONNECT_MIN_DELAY_MS = 250;
/** 联网恢复与回到前台触发的立即重连，距上一次建连尝试至少隔这么久。 */
export const RECONNECT_MIN_INTERVAL_MS = 1000;
/** 连接业务可用后稳定存活这么久，才算上一轮重连成功、退避清零。 */
export const RECONNECT_STABLE_MS = 10000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
export const CONNECT_WAIT_TIMEOUT_MS = 8000;
export const TEST_ROOM_ID = "Oblivionis";
