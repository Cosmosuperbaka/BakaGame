import { describe, expect, test } from "bun:test";

import {
  expiredOfflineSeats,
  forEachRoomIsolated,
  isIdleWarningDue,
  judgeReclaim,
  markIdleWarningSent,
  offlineSeatGraceMs,
} from "../../src/application/room/RoomJanitor";
import {
  PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS,
  ROOM_EMPTY_GRACE_PERIOD_MS,
  ROOM_IDLE_TIMEOUT_MS,
  SPECTATOR_OFFLINE_GRACE_MS,
} from "../../src/config/Constants";
import { makeRoom, makeSeat } from "./RoomKernelFixtures";

const T0 = 1_000_000;

describe("逐房隔离遍历", () => {
  test("一间房同步抛错或异步拒绝，其余房间照常访问", async () => {
    const rooms = new Map(["a", "b", "c", "d"].map((id) => [id, { id }]));
    const visited: string[] = [];
    const failures: [string, string][] = [];
    await forEachRoomIsolated(
      rooms,
      async (room) => {
        visited.push(room.id);
        if (room.id === "a") throw new Error("同步坏房");
        if (room.id === "c") await Promise.reject(new Error("异步坏房"));
      },
      (room, error) => failures.push([room.id, (error as Error).message])
    );
    expect(visited).toEqual(["a", "b", "c", "d"]);
    expect(failures).toEqual([
      ["a", "同步坏房"],
      ["c", "异步坏房"],
    ]);
  });

  test("同步 visit 抛错同样隔离", async () => {
    const rooms = new Map(["a", "b"].map((id) => [id, { id }]));
    const visited: string[] = [];
    const failures: string[] = [];
    await forEachRoomIsolated(
      rooms,
      (room) => {
        visited.push(room.id);
        if (room.id === "a") throw new Error("坏房");
      },
      (room) => failures.push(room.id)
    );
    expect(visited).toEqual(["a", "b"]);
    expect(failures).toEqual(["a"]);
  });

  test("遍历中删房不出错：删掉的是自己照常继续，删掉的是后面的房间则跳过它", async () => {
    const rooms = new Map(["a", "b", "c"].map((id) => [id, { id }]));
    const visited: string[] = [];
    await forEachRoomIsolated(
      rooms,
      (room) => {
        visited.push(room.id);
        rooms.delete(room.id);
        if (room.id === "a") rooms.delete("b");
      },
      () => {
        throw new Error("不应出错");
      }
    );
    expect(visited).toEqual(["a", "c"]);
    expect(rooms.size).toBe(0);
  });

  test("同步 visit 在一次调用内跑完全部房间，不被拆进微任务", () => {
    const rooms = new Map(["a", "b", "c"].map((id) => [id, { id }]));
    const visited: string[] = [];
    void forEachRoomIsolated(
      rooms,
      (room) => {
        visited.push(room.id);
      },
      () => {}
    );
    expect(visited).toEqual(["a", "b", "c"]);
  });
});

describe("回收结论", () => {
  test("有人在线：清空房起点；未闲置为 keep，闲置为 close-idle", () => {
    const room = makeRoom([], { lastActivityAt: T0, emptySinceAt: T0 });
    expect(judgeReclaim(room, 1, T0 + 1, { emptyRoomExempt: false })).toBe("keep");
    expect(room.emptySinceAt).toBeUndefined();
    expect(judgeReclaim(room, 1, T0 + ROOM_IDLE_TIMEOUT_MS, { emptyRoomExempt: false })).toBe(
      "close-idle"
    );
  });

  test("无人在线：记空房起点并给宽限，宽限满则 close-empty，起点不被刷新", () => {
    const room = makeRoom([], { lastActivityAt: T0 });
    expect(judgeReclaim(room, 0, T0 + 10, { emptyRoomExempt: false })).toBe("grace");
    expect(room.emptySinceAt).toBe(T0 + 10);
    expect(judgeReclaim(room, 0, T0 + 20, { emptyRoomExempt: false })).toBe("grace");
    expect(room.emptySinceAt).toBe(T0 + 10);
    expect(
      judgeReclaim(room, 0, T0 + 10 + ROOM_EMPTY_GRACE_PERIOD_MS, { emptyRoomExempt: false })
    ).toBe("close-empty");
  });

  test("空房宽限内但已闲置超时：按闲置关闭", () => {
    const room = makeRoom([], { lastActivityAt: T0 - ROOM_IDLE_TIMEOUT_MS });
    expect(judgeReclaim(room, 0, T0, { emptyRoomExempt: false })).toBe("close-idle");
  });

  test("测试房只豁免空房、不豁免闲置", () => {
    const room = makeRoom([], { lastActivityAt: T0, emptySinceAt: T0 - 10 });
    expect(judgeReclaim(room, 0, T0 + ROOM_EMPTY_GRACE_PERIOD_MS, { emptyRoomExempt: true })).toBe(
      "keep"
    );
    expect(room.emptySinceAt).toBeUndefined();
    expect(judgeReclaim(room, 0, T0 + ROOM_IDLE_TIMEOUT_MS, { emptyRoomExempt: true })).toBe(
      "close-idle"
    );
  });
});

describe("闲置预警", () => {
  const LEAD = 60_000;
  const warnAt = T0 + ROOM_IDLE_TIMEOUT_MS - LEAD;

  test("离闲置超时不到提前量、有人在线时预警一次", () => {
    const room = makeRoom([], { lastActivityAt: T0 });
    expect(isIdleWarningDue(room, 1, warnAt - 1, LEAD)).toBe(false);
    expect(isIdleWarningDue(room, 0, warnAt, LEAD)).toBe(false);
    expect(isIdleWarningDue(room, 1, warnAt, LEAD)).toBe(true);
    markIdleWarningSent(room);
    expect(isIdleWarningDue(room, 1, warnAt + 1, LEAD)).toBe(false);
  });

  test("预警后有新活动，下一段闲置会重新预警", () => {
    const room = makeRoom([], { lastActivityAt: T0 });
    markIdleWarningSent(room);
    room.lastActivityAt = T0 + 5_000;
    expect(isIdleWarningDue(room, 1, warnAt + 5_000, LEAD)).toBe(true);
  });
});

describe("离线席位清理", () => {
  test("0 分真人旁观者短保留；房主、有分、正式玩家、机器人都长保留", () => {
    const room = makeRoom([makeSeat("H")]);
    expect(offlineSeatGraceMs(room, makeSeat("S", { membership: "spectator" }))).toBe(
      SPECTATOR_OFFLINE_GRACE_MS
    );
    for (const seat of [
      makeSeat("H", { membership: "spectator" }),
      makeSeat("S", { membership: "spectator", score: 3 }),
      makeSeat("A"),
      makeSeat("B", { membership: "spectator", isBot: true }),
    ]) {
      expect(offlineSeatGraceMs(room, seat)).toBe(PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS);
    }
  });

  test("没有分数字段的座位按 0 分处理", () => {
    const room = makeRoom([makeSeat("H")]);
    const { score: _score, ...seat } = makeSeat("S", { membership: "spectator" });
    expect(offlineSeatGraceMs(room, seat)).toBe(SPECTATOR_OFFLINE_GRACE_MS);
  });

  test("只挑离线超时的真人席位；在线与机器人不清，被踢记录到期同样清出名册", () => {
    const seats = [
      makeSeat("online", { lastSeenAt: 0 }),
      makeSeat("bot", { online: false, isBot: true, lastSeenAt: 0 }),
      makeSeat("fresh", { online: false, lastSeenAt: T0 - 1 }),
      makeSeat("stale", { online: false, lastSeenAt: T0 - PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS }),
      makeSeat("watcher", {
        online: false,
        membership: "spectator",
        lastSeenAt: T0 - SPECTATOR_OFFLINE_GRACE_MS,
      }),
      makeSeat("kicked", { online: false, membership: "kicked", lastSeenAt: 0 }),
    ];
    const room = makeRoom([makeSeat("H")]);
    expect(expiredOfflineSeats(room, seats, T0).map((seat) => seat.id)).toEqual([
      "stale",
      "watcher",
      "kicked",
    ]);
  });
});
