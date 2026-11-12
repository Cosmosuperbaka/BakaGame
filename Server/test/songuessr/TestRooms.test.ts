import { describe, expect, test } from "bun:test";

import { ROOM_EMPTY_GRACE_PERIOD_MS } from "../../src/config/Constants";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import { createTestRoomPolicy } from "../../src/domain/TestRooms";
import type { SonGuessrRoomSnapshot } from "../../src/shared/Index";
import { TEST_ROOMS_ON } from "../TestRoomPolicy";
import { connection, createRoom, execute, joinRoom, lastEvent, provider } from "./Fixtures";

const TEST_ROOM = "Oblivionis";

describe("猜歌测试房守卫", () => {
  test("缺省策略关闭：建测试房与加入测试房都得非法房号，与其它非法房号同文案", async () => {
    // 不传 testRooms：服务缺省必须是关闭，生产靠这一条兜底。
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "guard-host");
    const reject = async (roomId: string) => {
      try {
        await createRoom(service, host, { roomId });
      } catch (error) {
        return error as { code: string; message: string };
      }
      throw new Error(`${roomId} 应被拒绝`);
    };
    const ordinary = await reject("abcd");
    for (const roomId of [TEST_ROOM, TEST_ROOM.toLowerCase()]) {
      const error = await reject(roomId);
      expect(error.code).toBe("INVALID_ROOM_ID");
      expect(error.message).toBe(ordinary.message);
    }

    const guest = connection(service, "guard-guest");
    await expect(
      execute(service, guest, {
        id: "join",
        type: "song.room.join",
        roomId: TEST_ROOM,
        payload: { userName: "访客" },
      })
    ).rejects.toMatchObject({ code: "INVALID_ROOM_ID" });
    expect(service.getHealthSnapshot().roomCount).toBe(0);
  });

  test("测试指令要求房主，且只在测试房里受理", async () => {
    const service = new SonGuessrService({ musicProvider: provider, testRooms: TEST_ROOMS_ON });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host, { roomId: TEST_ROOM });
    await joinRoom(service, guest, "访客", TEST_ROOM);

    // 非房主被拒。
    await expect(
      execute(service, guest, {
        id: "guest-add",
        type: "song.test.addBot",
        roomId: TEST_ROOM,
        payload: { count: 1 },
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      execute(service, guest, {
        id: "guest-remove",
        type: "song.test.removeBot",
        roomId: TEST_ROOM,
        payload: { count: 1 },
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // 普通房里房主也不行。
    const plainHost = connection(service, "plain-host");
    await createRoom(service, plainHost, { roomId: "1234" });
    for (const type of ["song.test.addBot", "song.test.removeBot"] as const) {
      await expect(
        execute(service, plainHost, { id: type, type, roomId: "1234", payload: { count: 1 } })
      ).rejects.toMatchObject({ code: "TEST_ROOM_ONLY" });
    }
  });

  test("开关在房间存续期间关闭：房间退回普通房，特权立即失效", async () => {
    let enabled = true;
    let now = 1_000_000;
    const service = new SonGuessrService({
      musicProvider: provider,
      testRooms: createTestRoomPolicy(() => enabled),
      now: () => now,
    });
    const host = connection(service, "host");
    await createRoom(service, host, { roomId: TEST_ROOM });
    await execute(service, host, {
      id: "add",
      type: "song.test.addBot",
      roomId: TEST_ROOM,
      payload: { count: 1 },
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").testMode).toBe(true);
    // 测试房不进大厅。
    expect(service.getRoomSummaries()).toHaveLength(0);
    // 机器人算在线人数：先清掉，才看得出空房回收是否恢复。
    await execute(service, host, {
      id: "remove",
      type: "song.test.removeBot",
      roomId: TEST_ROOM,
      payload: { count: 1 },
    });

    enabled = false;
    await expect(
      execute(service, host, {
        id: "add-off",
        type: "song.test.addBot",
        roomId: TEST_ROOM,
        payload: { count: 1 },
      })
    ).rejects.toMatchObject({ code: "TEST_ROOM_ONLY" });
    await execute(service, host, {
      id: "sync",
      type: "song.room.requestSync",
      roomId: TEST_ROOM,
      payload: {},
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").testMode).toBe(false);
    // 不再被隐藏出大厅。
    expect(service.getRoomSummaries().map((item) => item.roomId)).toEqual([TEST_ROOM]);

    // 不再豁免空房回收：房主掉线后满宽限期关房。
    await service.unregisterConnection(host.record.id);
    now += ROOM_EMPTY_GRACE_PERIOD_MS + 1;
    await service.runHousekeeping();
    expect(service.getHealthSnapshot().roomCount).toBe(0);
  });
});
