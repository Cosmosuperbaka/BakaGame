import { afterEach, describe, expect, test } from "bun:test";

import { ROOM_EMPTY_GRACE_PERIOD_MS } from "../src/config/Constants";
import { canStartCEERound } from "../src/domain/CEERound";
import { createTestRoomPolicy, TEST_ROOMS_DISABLED } from "../src/domain/TestRooms";
import { ROOM_ID_TEST_MODE } from "../src/shared/Index";
import { ceeTestHarness } from "./CEENativeFixtures";
import { TEST_ROOMS_ON } from "./TestRoomPolicy";

type Harness = ReturnType<typeof ceeTestHarness>;
const active: Harness[] = [];
const keep = (harness: Harness) => {
  active.push(harness);
  return harness;
};
afterEach(() => {
  active.splice(0).forEach((harness) => harness.service.close());
});

describe("CEE 测试房守卫", () => {
  test("策略关闭时建测试房与加入测试房都得非法房号，与其它非法房号同文案", async () => {
    const h = keep(ceeTestHarness({}, undefined, { testRooms: TEST_ROOMS_DISABLED }));
    const reject = async (roomId: string) => {
      const client = h.connect(`建房-${roomId}`);
      try {
        await h.send(
          client,
          "cee.room.create",
          {
            source: "native",
            roomId,
            name: "房",
            userName: "房主",
            visibility: "public",
            allowSpectators: true,
          },
          roomId
        );
      } catch (error) {
        return error as { code: string; message: string };
      }
      throw new Error(`${roomId} 应被拒绝`);
    };
    const ordinary = await reject("abcd");
    for (const roomId of [ROOM_ID_TEST_MODE, ROOM_ID_TEST_MODE.toLowerCase()]) {
      const error = await reject(roomId);
      expect(error.code).toBe("INVALID_ROOM_ID");
      expect(error.message).toBe(ordinary.message);
    }
    await expect(
      h.send(h.connect("访客"), "cee.room.join", { userName: "访客" }, ROOM_ID_TEST_MODE)
    ).rejects.toMatchObject({ code: "INVALID_ROOM_ID" });
    expect(h.service.getHealthSnapshot().roomCount).toBe(0);
  });

  test("开关在房间存续期间关闭：单人开局、大厅隐藏与回收豁免立即失效", async () => {
    let enabled = true;
    const h = keep(
      ceeTestHarness({}, undefined, {
        roomId: ROOM_ID_TEST_MODE,
        testRooms: createTestRoomPolicy(() => enabled),
      })
    );
    const host = await h.create();
    await h.configure(host, {});
    expect(h.privateState(host).canStart).toBe(true);
    // 测试房不进大厅。
    expect(h.service.listRooms()).toHaveLength(0);

    const room = h.service.state.rooms.get(ROOM_ID_TEST_MODE)!;
    const hostPlayer = room.players.get(host.id!)!;
    expect(canStartCEERound(room, hostPlayer, TEST_ROOMS_ON)).toBe(true);

    enabled = false;
    // 单人开局资格由策略给出：同一间房换成关闭的策略就不能一人开局。
    expect(canStartCEERound(room, hostPlayer, TEST_ROOMS_DISABLED)).toBe(false);
    // 房号入口同样关闭：对这间房的后续命令与其它非法房号一样被拒，不会留下半特权。
    await expect(h.send(host, "cee.game.start", {})).rejects.toMatchObject({
      code: "INVALID_ROOM_ID",
    });
    expect(h.service.listRooms().map((item) => item.roomId)).toEqual([ROOM_ID_TEST_MODE]);

    // 不再豁免空房回收。
    h.service.unregisterConnection(host.record.id);
    h.advance(ROOM_EMPTY_GRACE_PERIOD_MS + 1);
    expect(h.service.getHealthSnapshot().roomCount).toBe(0);
  });
});
