import { describe, expect, test } from "bun:test";

import type { RoomCore, SeatCore } from "../../src/application/room/RoomCore";
import type { SonGuessrPlayerRecord, SonGuessrRoomRecord } from "../../src/application/songuessr/Records";
import type { CEEPlayerRecord, CEERoom } from "../../src/domain/CEEModel";
import type { WhoIsFakerPlayerRecord, WhoIsFakerRoomRecord } from "../../src/shared/WhoIsFaker";
import { kernelShape, makeRoom, makeSeat } from "./RoomKernelFixtures";

/** 编译期断言：左边可以赋给右边。不满足时 `bun run check` 失败。 */
type Assignable<TFrom extends TTo, TTo> = [TFrom, TTo];

// 卧底与猜歌的记录今天已经逐字段满足内核的最小接口：接入时不需要改记录类型。
export type FakerRoomFits = Assignable<WhoIsFakerRoomRecord, RoomCore>;
export type FakerSeatFits = Assignable<WhoIsFakerPlayerRecord, SeatCore>;
export type SongRoomFits = Assignable<SonGuessrRoomRecord, RoomCore>;
export type SongSeatFits = Assignable<SonGuessrPlayerRecord, SeatCore>;
// CEE 还差四个同义异名字段；对齐字段名的那一步完成后这两行的期望错误消失，届时改成上面的写法。
// @ts-expect-error CEE 房间仍用 lastActiveAt / emptyAt / hostDeadlineAt
export type CEERoomFits = Assignable<CEERoom, RoomCore>;
// @ts-expect-error CEE 座位仍用 offlineAt，没有 lastSeenAt
export type CEESeatFits = Assignable<CEEPlayerRecord, SeatCore>;

describe("内核类型底座", () => {
  test("测试用的玩法形状按 Record 容器取座位与准入字段", () => {
    const room = makeRoom([makeSeat("a"), makeSeat("b")], { allowAgents: true });
    expect([...kernelShape.seats(room)].map((seat) => seat.id)).toEqual(["a", "b"]);
    kernelShape.dropSeat(room, "a");
    kernelShape.addSeat(room, makeSeat("c"));
    expect(kernelShape.seat(room, "a")).toBeUndefined();
    expect(kernelShape.seat(room, "c")?.id).toBe("c");
    expect(kernelShape.admission(room)).toEqual({
      visibility: "public",
      allowSpectators: true,
      allowAgents: true,
    });
  });
});
