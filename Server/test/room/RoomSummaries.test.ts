import { describe, expect, test } from "bun:test";

import {
  adminRoomView,
  countOnline,
  countOnlineByMembership,
  requireAdminRoom,
} from "../../src/application/room/RoomSummaries";
import { expectAppError, makeRoom, makeSeat } from "./RoomKernelFixtures";

describe("在线计数", () => {
  test("只数在线且未被移出的座位；可直接吃 Map 的单次迭代器", () => {
    const seats = [
      makeSeat("a"),
      makeSeat("b", { online: false }),
      makeSeat("c", { membership: "spectator" }),
      makeSeat("k", { membership: "kicked" }),
    ];
    expect(countOnline(seats)).toBe(2);
    expect(countOnline(new Map(seats.map((seat) => [seat.id, seat])).values())).toBe(2);
    expect(countOnline([])).toBe(0);
  });

  test("按身份分开数在线人数：离线与被移出的都不计，单次迭代器同样吃得下", () => {
    const seats = [
      makeSeat("a"),
      makeSeat("b", { online: false }),
      makeSeat("c", { membership: "spectator" }),
      makeSeat("d", { membership: "spectator", online: false }),
      makeSeat("k", { membership: "kicked" }),
      makeSeat("ks", { membership: "kicked", online: false }),
    ];
    expect(countOnlineByMembership(seats)).toEqual({ active: 1, spectator: 1 });
    expect(countOnlineByMembership(new Map(seats.map((seat) => [seat.id, seat])).values())).toEqual(
      { active: 1, spectator: 1 }
    );
    expect(countOnlineByMembership([])).toEqual({ active: 0, spectator: 0 });
  });
});

describe("后台房间视图", () => {
  test("成员逐字段映射，被移出的不列出，令牌不进视图", () => {
    const seats = [
      makeSeat("h", { account: { userId: "u1", image: null }, sessionToken: "secret-h" }),
      makeSeat("g", { online: false, membership: "spectator" }),
      makeSeat("b", { isBot: true }),
      makeSeat("k", { membership: "kicked" }),
    ];
    const room = makeRoom(seats, {
      hostPlayerId: "h",
      passwordHash: "digest",
      createdAt: 10,
      lastActivityAt: 20,
    });
    const view = adminRoomView(room, seats, {
      game: "song",
      name: "房间",
      phase: "waiting",
      visibility: "private",
      hidden: false,
      roundNumber: 3,
    });
    expect(view).toEqual({
      game: "song",
      roomId: "1234",
      name: "房间",
      phase: "waiting",
      visibility: "private",
      hasPassword: true,
      hidden: false,
      roundNumber: 3,
      createdAt: 10,
      lastActiveAt: 20,
      players: [
        {
          id: "h",
          name: "h",
          online: true,
          membership: "active",
          host: true,
          bot: false,
          userId: "u1",
        },
        {
          id: "g",
          name: "g",
          online: false,
          membership: "spectator",
          host: false,
          bot: false,
          userId: null,
        },
        {
          id: "b",
          name: "b",
          online: true,
          membership: "active",
          host: false,
          bot: true,
          userId: null,
        },
      ],
    });
    expect(JSON.stringify(view)).not.toContain("secret-h");
  });

  test("没有摘要的房间 hasPassword 为假；目标房间不存在时回房间不存在", () => {
    const room = makeRoom([]);
    const view = adminRoomView(room, [], {
      game: "cee",
      name: "",
      phase: "waiting",
      visibility: "public",
      hidden: true,
      roundNumber: 0,
    });
    expect(view.hasPassword).toBe(false);
    const rooms = new Map([[room.id, room]]);
    expect(requireAdminRoom(rooms, "1234")).toBe(room);
    expectAppError(() => requireAdminRoom(rooms, "9999"), "ROOM_NOT_FOUND");
  });
});
