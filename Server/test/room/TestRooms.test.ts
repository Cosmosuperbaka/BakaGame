import { describe, expect, test } from "bun:test";

import { TEST_ROOMS_DISABLED, createTestRoomPolicy } from "../../src/domain/TestRooms";
import { ROOM_ID_TEST_MODE } from "../../src/shared/ModelValues";

describe("测试房策略", () => {
  test("缺省策略关闭：测试房号不被当作测试房", () => {
    expect(TEST_ROOMS_DISABLED.isEnabled()).toBe(false);
    expect(TEST_ROOMS_DISABLED.isTestRoom(ROOM_ID_TEST_MODE)).toBe(false);
  });

  test("开关打开时只认测试房号，大小写与首尾空白不敏感", () => {
    const policy = createTestRoomPolicy(() => true);
    expect(policy.isTestRoom(ROOM_ID_TEST_MODE)).toBe(true);
    expect(policy.isTestRoom(` ${ROOM_ID_TEST_MODE.toUpperCase()} `)).toBe(true);
    expect(policy.isTestRoom("1234")).toBe(false);
    expect(policy.isTestRoom(`${ROOM_ID_TEST_MODE}x`)).toBe(false);
  });

  test("开关现读：运行期改动立刻生效，不缓存结论", () => {
    let enabled = false;
    const policy = createTestRoomPolicy(() => enabled);
    expect(policy.isTestRoom(ROOM_ID_TEST_MODE)).toBe(false);
    enabled = true;
    expect(policy.isEnabled()).toBe(true);
    expect(policy.isTestRoom(ROOM_ID_TEST_MODE)).toBe(true);
    enabled = false;
    expect(policy.isTestRoom(ROOM_ID_TEST_MODE)).toBe(false);
  });
});
