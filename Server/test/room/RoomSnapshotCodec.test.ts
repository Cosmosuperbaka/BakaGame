import { describe, expect, test } from "bun:test";

import {
  adoptRoomCore,
  exportRoomJson,
  hasSnapshotShape,
  restoreRooms,
  shiftDeadline,
} from "../../src/application/room/RoomSnapshotCodec";
import { HOST_RECONNECT_TIMEOUT_MS } from "../../src/config/Constants";
import type { SnapshottedRoom } from "../../src/shared/RoomSnapshot";
import { makeRoom, makeSeat } from "./RoomKernelFixtures";

const NOW = 900_000;

describe("快照导出", () => {
  test("一律丢弃 runtime，循环引用与句柄也不会让导出抛错", () => {
    const lock: Record<string, unknown> = { token: Symbol("在途") };
    lock.self = lock;
    const room = { ...makeRoom([makeSeat("a")]), runtime: { lock, startedAt: 5 } };
    const exported = exportRoomJson(room);
    expect("runtime" in exported).toBe(false);
    expect(exported.id).toBe("1234");
    expect((exported.players as Record<string, unknown>).a).toMatchObject({ id: "a" });
    expect(room.runtime.startedAt).toBe(5);
  });

  test("点名的顶层键不进快照，同名的嵌套键保留", () => {
    const room = {
      id: "1234",
      musicPool: [{ cookie: "secret" }],
      settings: { musicPool: "nested" },
      lastActivityAt: 1,
      gone: undefined,
    };
    const exported = exportRoomJson(room, ["musicPool"]);
    expect(exported).toEqual({ id: "1234", settings: { musicPool: "nested" }, lastActivityAt: 1 });
    expect(JSON.stringify(exported)).not.toContain("secret");
  });

  test("导出是深拷贝，之后改房间不影响已导出的快照", () => {
    const room = makeRoom([makeSeat("a")]);
    const exported = exportRoomJson(room);
    room.players.a.name = "changed";
    expect((exported.players as Record<string, { name: string }>).a.name).toBe("a");
  });
});

describe("快照恢复", () => {
  test("最小形状：要有非空 id 与座位容器对象", () => {
    expect(hasSnapshotShape({ id: "1234", players: {} })).toBe(true);
    expect(hasSnapshotShape({ id: "", players: {} })).toBe(false);
    expect(hasSnapshotShape({ id: "1234" })).toBe(false);
    expect(hasSnapshotShape({ id: "1234", players: null })).toBe(false);
    expect(hasSnapshotShape(null as unknown as SnapshottedRoom)).toBe(false);
    expect(hasSnapshotShape({ id: "1234", members: {} }, "members")).toBe(true);
  });

  test("公共部分五项重置：全员离线清连接、lastSeenAt、空房计时、活动时刻、房主宽限；残留运行时丢弃", () => {
    const seats = [
      makeSeat("H", { connectionId: "c1", lastSeenAt: 1 }),
      makeSeat("G", { online: false, lastSeenAt: 2 }),
    ];
    const room = makeRoom(seats, {
      emptySinceAt: 3,
      lastActivityAt: 4,
      hostReconnectDeadlineAt: 5,
      runtime: { lock: true },
    });
    adoptRoomCore(room, seats, NOW);
    for (const seat of seats) {
      expect(seat).toMatchObject({ online: false, connectionId: undefined, lastSeenAt: NOW });
    }
    expect(room.emptySinceAt).toBeUndefined();
    expect(room.lastActivityAt).toBe(NOW);
    expect(room.hostReconnectDeadlineAt).toBe(NOW + HOST_RECONNECT_TIMEOUT_MS);
    expect(room.runtime).toBeUndefined();
  });

  test("停机前房主在线（没有截止）恢复后也从 now 起给完整宽限；待选的房间不设截止", () => {
    const seats = [makeSeat("H")];
    const hosted = makeRoom(seats);
    adoptRoomCore(hosted, seats, NOW);
    expect(hosted.hostReconnectDeadlineAt).toBe(NOW + HOST_RECONNECT_TIMEOUT_MS);

    const vacant = makeRoom([], { hostPlayerId: "", hostReconnectDeadlineAt: 7 });
    adoptRoomCore(vacant, [], NOW);
    expect(vacant.hostReconnectDeadlineAt).toBeUndefined();
  });

  test("截止平移：数值后移，空值透传", () => {
    const deadline: number = 100;
    expect(shiftDeadline(deadline, 50)).toBe(150);
    expect(shiftDeadline(null, 50)).toBeNull();
    expect(shiftDeadline(undefined, 50)).toBeUndefined();
  });

  test("恢复循环：按停机时长平移、丢弃不合格与同号、单间抛错只丢这一间", () => {
    const rooms = new Map<string, { id: string; pausedMs: number }>([
      ["9999", { id: "9999", pausedMs: -1 }],
    ]);
    const restoredIds: string[] = [];
    const errors: string[] = [];
    const count = restoreRooms(
      rooms,
      [{ id: "1111" }, { id: "" }, { id: "9999" }, { id: "boom" }, { id: "late" }, { id: "2222" }],
      { savedAt: NOW - 3_000, now: NOW },
      {
        adopt: (raw, _now, pausedMs) => {
          if (raw.id === "boom") throw new Error("坏房");
          return raw.id ? { id: raw.id, pausedMs } : undefined;
        },
        onRestored: (room) => {
          if (room.id === "late") throw new Error("抬计数器失败");
          restoredIds.push(room.id);
        },
        onError: (raw) => errors.push(raw.id),
      }
    );
    expect(count).toBe(2);
    expect(restoredIds).toEqual(["1111", "2222"]);
    expect(errors).toEqual(["boom", "late"]);
    expect(rooms.get("1111")?.pausedMs).toBe(3_000);
    expect(rooms.get("9999")?.pausedMs).toBe(-1);
    expect(rooms.has("late")).toBe(false);
  });

  test("时钟回拨时停机时长按 0", () => {
    const rooms = new Map<string, { id: string; pausedMs: number }>();
    restoreRooms(
      rooms,
      [{ id: "1111" }],
      { savedAt: NOW + 5_000, now: NOW },
      { adopt: (raw, _now, pausedMs) => ({ id: raw.id, pausedMs }), onError: () => {} }
    );
    expect(rooms.get("1111")?.pausedMs).toBe(0);
  });
});
