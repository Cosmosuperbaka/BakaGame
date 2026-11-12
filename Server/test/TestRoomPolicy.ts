import { createTestRoomPolicy } from "../src/domain/TestRooms";

/**
 * 打开的测试房策略：用到测试房的夹具与用例显式传入它。
 * 生产缺省是关闭的，这里不能反过来把服务的缺省值改成打开。
 */
export const TEST_ROOMS_ON = createTestRoomPolicy(() => true);
