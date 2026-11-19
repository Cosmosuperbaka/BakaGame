import { describe, expect, test } from "bun:test";

import type { RoomCore, SeatCore } from "../../src/application/room/RoomCore";
import type {
  SonGuessrPlayerRecord,
  SonGuessrRoomRecord,
} from "../../src/application/songuessr/Records";
import type { CEEPlayerRecord, CEERoom } from "../../src/domain/CEEModel";
import type { WhoIsFakerPlayerRecord, WhoIsFakerRoomRecord } from "../../src/shared/WhoIsFaker";
import { kernelShape, makeRoom, makeSeat } from "./RoomKernelFixtures";

/** 编译期断言：左边可以赋给右边。不满足时 `bun run check` 失败。 */
type Assignable<TFrom extends TTo, TTo> = [TFrom, TTo];

// 三款的房间与座位记录都逐字段满足内核的最小接口。
export type FakerRoomFits = Assignable<WhoIsFakerRoomRecord, RoomCore>;
export type FakerSeatFits = Assignable<WhoIsFakerPlayerRecord, SeatCore>;
export type SongRoomFits = Assignable<SonGuessrRoomRecord, RoomCore>;
export type SongSeatFits = Assignable<SonGuessrPlayerRecord, SeatCore>;
export type CEERoomFits = Assignable<CEERoom, RoomCore>;
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
