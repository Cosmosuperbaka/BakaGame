import type { ConnectionRecord } from "../../src/shared/Index";

/** 测试用连接记录：只带最小能力（收消息、关连接），其余字段按需覆盖。 */
export const createTestConnection = (
  id: string,
  overrides: Partial<ConnectionRecord> = {}
): ConnectionRecord => ({
  id,
  lobbySubscribed: false,
  send: () => {},
  close: () => {},
  ...overrides,
});
