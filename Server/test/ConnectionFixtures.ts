import type { ConnectionRecord } from "../src/shared/Index";

/**
 * 测试用连接记录：只带最小能力（收消息、关连接），其余字段按需覆盖。
 * 连接记录增减必填字段时只改这里，不必逐个测试文件手搓。
 */
export const buildConnectionRecord = (
  id: string,
  overrides: Partial<ConnectionRecord> = {}
): ConnectionRecord => ({
  id,
  lobbySubscribed: false,
  send: () => {},
  close: () => {},
  ...overrides,
});
