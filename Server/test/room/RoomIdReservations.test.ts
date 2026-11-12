import { describe, expect, test } from "bun:test";

import { RoomIdReservations } from "../../src/application/room/RoomIdReservations";
import { expectAppError } from "./RoomKernelFixtures";

const free = () => false;

describe("建房占号", () => {
  test("占号期间第二次占同号被拒，别的房号不受影响", () => {
    const reservations = new RoomIdReservations();
    reservations.hold("1234", free);
    expect(reservations.has("1234")).toBe(true);
    expectAppError(() => reservations.hold("1234", free), "ROOM_EXISTS");
    expect(() => reservations.hold("5678", free)).not.toThrow();
  });

  test("房间表或别的目录已占用（isTaken 为真）时被拒，且不留下占用", () => {
    const reservations = new RoomIdReservations();
    expectAppError(() => reservations.hold("1234", (id) => id === "1234"), "ROOM_EXISTS");
    expect(reservations.has("1234")).toBe(false);
  });

  test("释放后可以再占；释放函数幂等，旧的释放函数不会放掉后来者的占用", () => {
    const reservations = new RoomIdReservations();
    const release = reservations.hold("1234", free);
    release();
    release();
    expect(reservations.has("1234")).toBe(false);
    const second = reservations.hold("1234", free);
    release();
    expect(reservations.has("1234")).toBe(true);
    second();
    expect(reservations.has("1234")).toBe(false);
  });

  test("房号占用的错误码可以按玩法现值传入", () => {
    const reservations = new RoomIdReservations({
      takenError: { code: "ROOM_ALREADY_EXISTS", message: "房间已存在" },
    });
    reservations.hold("1234", free);
    expectAppError(() => reservations.hold("1234", free), "ROOM_ALREADY_EXISTS");
  });
});
