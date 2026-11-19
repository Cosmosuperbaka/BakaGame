import { ROOM_ID_TEST_MODE } from "../shared/ModelValues";

/**
 * 测试房策略：测试房号只在部署侧明确打开开关时才是测试房。
 *
 * 测试房豁免空房回收、开放测试指令，这些特权不能只凭「房号对上」就给出去：
 * 任何人都能在生产上建一间同号房。开关由组合根注入，缺省关闭；
 * 关闭时测试房号既不享受豁免，也不该被当成合法房号（由建房入口据 `isEnabled` 拒绝）。
 */
export interface TestRoomPolicy {
  /** 现读：运行期旋钮可以不重启开合，调用方不得缓存结论。 */
  isEnabled(): boolean;
  /** 开关打开且房号是测试房号（大小写不敏感，与房号校验同一口径）。 */
  isTestRoom(roomId: string): boolean;
}

const TEST_ROOM_KEY = ROOM_ID_TEST_MODE.toLowerCase();

export const createTestRoomPolicy = (isEnabled: () => boolean): TestRoomPolicy => ({
  isEnabled,
  isTestRoom: (roomId) => isEnabled() && roomId.trim().toLowerCase() === TEST_ROOM_KEY,
});

/** 缺省策略：隔离测试与未装配开关的部署一律当作关闭。 */
export const TEST_ROOMS_DISABLED: TestRoomPolicy = createTestRoomPolicy(() => false);
