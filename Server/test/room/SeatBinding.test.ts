import { describe, expect, test } from "bun:test";

import { ConnectionRegistry } from "../../src/application/ConnectionRegistry";
import {
  assertAgentAdmission,
  assertSeatResumable,
  assertTabAgentsAllowed,
  bindSeat,
  dissolveRoom,
  findSeat,
  markSeatOffline,
  roomsOfTab,
} from "../../src/application/room/SeatBinding";
import { tabSeatId } from "../../src/application/TabSeat";
import { HOST_RECONNECT_TIMEOUT_MS } from "../../src/config/Constants";
import type { GameRoomEnd } from "../../src/domain/GameRecord";
import type { ConnectionRecord } from "../../src/shared/Model";
import {
  expectAppError,
  kernelShape,
  makeConnection,
  makeRoom,
  makeSeat,
  type KernelRoom,
} from "./RoomKernelFixtures";

const NOW = 50_000;

const createContext = (connections = new ConnectionRegistry()) => ({
  shape: kernelShape,
  connections,
  now: () => NOW,
});

describe("找座位与回座准入", () => {
  test("令牌优先、常量时间比较；被踢的记录不算座位", () => {
    const ctx = createContext();
    const kicked = makeSeat("K", { membership: "kicked", sessionToken: "t-kicked" });
    const seat = makeSeat("A", { sessionToken: "t-a" });
    const room = makeRoom([seat, kicked]);
    const connection = makeConnection("c1");
    expect(findSeat(ctx, room, connection, "t-a")).toBe(seat);
    expect(findSeat(ctx, room, connection, "t-kicked")).toBeUndefined();
    expect(findSeat(ctx, room, connection, "t-a-")).toBeUndefined();
    expect(findSeat(ctx, room, connection, "")).toBeUndefined();
    expect(findSeat(ctx, room, connection, null)).toBeUndefined();
  });

  test("没有令牌时按标签页座位找；标签页座位被踢同样不算", () => {
    const ctx = createContext();
    const connection = makeConnection("c1", { overrides: { tabKey: "tab-key" } });
    const seatId = tabSeatId(connection, kernelShape.game, "1234")!;
    const seat = makeSeat(seatId, { sessionToken: "t-tab" });
    const room = makeRoom([seat]);
    expect(findSeat(ctx, room, connection)).toBe(seat);
    const other = makeSeat("A", { sessionToken: "t-a" });
    room.players.A = other;
    expect(findSeat(ctx, room, connection, "t-a")).toBe(other);
    seat.membership = "kicked";
    expect(findSeat(ctx, room, connection)).toBeUndefined();
  });

  test("回座：被踢的记录拒回；Agent 不得接手人类座位，可以回到自己的 Agent 座位", () => {
    const human = makeConnection("h");
    const agent = makeConnection("a", { overrides: { isAgent: true } });
    expectAppError(
      () => assertSeatResumable(makeSeat("K", { membership: "kicked" }), human),
      "PLAYER_KICKED"
    );
    expectAppError(() => assertSeatResumable(makeSeat("H"), agent), "AGENT_SEAT_FORBIDDEN");
    expect(() => assertSeatResumable(makeSeat("G", { isAgent: true }), agent)).not.toThrow();
    expect(() => assertSeatResumable(makeSeat("H"), human)).not.toThrow();
  });

  test("Agent 准入：握手声明的 Agent 与被接管的标签页两条都看", () => {
    const closed = { visibility: "public" as const, allowSpectators: true, allowAgents: false };
    const open = { ...closed, allowAgents: true };
    const agent = makeConnection("a", { overrides: { isAgent: true } });
    const driven = makeConnection("d", { overrides: { agentDriven: () => true } });
    const human = makeConnection("h", { overrides: { agentDriven: () => false } });
    expectAppError(() => assertAgentAdmission(agent, closed), "AGENTS_NOT_ALLOWED");
    expectAppError(() => assertAgentAdmission(driven, closed), "AGENTS_NOT_ALLOWED");
    expect(() => assertAgentAdmission(human, closed)).not.toThrow();
    expect(() => assertAgentAdmission(agent, open)).not.toThrow();
    expect(() => assertAgentAdmission(driven, open)).not.toThrow();
  });
});

describe("绑定与顶号", () => {
  test("绑定：标在线、写连接与账号、刷新 lastSeenAt、清空房计时、重置基线并登记", () => {
    const ctx = createContext();
    const seat = makeSeat("A", { online: false, lastSeenAt: 1 });
    const room = makeRoom([seat], { emptySinceAt: 5 });
    const connection = makeConnection("c1", {
      overrides: { account: { userId: "u1", image: null } },
    });
    ctx.connections.registerConnection(connection);
    expect(bindSeat(ctx, room, seat, connection)).toEqual({ becameHost: false });
    expect(seat).toMatchObject({ online: true, connectionId: "c1", lastSeenAt: NOW });
    expect(seat.account?.userId).toBe("u1");
    expect(room.emptySinceAt).toBeUndefined();
    expect(connection.resets).toBe(1);
    expect(ctx.connections.findConnectionByPlayer("1234", "A")).toBe(connection);
    expect(connection.roomId).toBe("1234");
  });

  test("顶号：旧连接收到顶号事件、被解绑、以 4001 关闭", () => {
    const ctx = createContext();
    const seat = makeSeat("A");
    const room = makeRoom([seat]);
    const previous = makeConnection("old");
    const next = makeConnection("new");
    ctx.connections.registerConnection(previous);
    ctx.connections.registerConnection(next);
    bindSeat(ctx, room, seat, previous);
    bindSeat(ctx, room, seat, next);
    expect(previous.packets).toEqual([
      { type: "event", event: "song.session.replaced", payload: { roomId: "1234" } },
    ]);
    expect(previous.roomId).toBeUndefined();
    expect(previous.closes).toEqual([{ code: 4001, reason: "session_replaced" }]);
    expect(ctx.connections.findConnectionByPlayer("1234", "A")).toBe(next);
    expect(seat.connectionId).toBe("new");
  });

  test("顶号三步各自失败不影响后续：发不出、解绑抛错、关不掉都照样接管", () => {
    class FlakyRegistry extends ConnectionRegistry {
      override detach(connection: ConnectionRecord): void {
        if (connection.id === "old") throw new Error("索引已损坏");
        super.detach(connection);
      }
    }
    const ctx = createContext(new FlakyRegistry());
    const seat = makeSeat("A");
    const room = makeRoom([seat]);
    const previous = makeConnection("old", { fail: { send: true, close: true } });
    const next = makeConnection("new");
    ctx.connections.registerConnection(previous);
    ctx.connections.registerConnection(next);
    bindSeat(ctx, room, seat, previous);
    expect(() => bindSeat(ctx, room, seat, next)).not.toThrow();
    expect(seat.connectionId).toBe("new");
    expect(ctx.connections.findConnectionByPlayer("1234", "A")).toBe(next);

    // 只有关闭失败时，通知与解绑仍然做完。
    const third = makeConnection("third", { fail: { close: true } });
    ctx.connections.registerConnection(third);
    bindSeat(ctx, room, seat, third);
    expect(next.packets).toHaveLength(1);
    expect(next.roomId).toBeUndefined();
  });

  test("同一条连接重绑自己的座位不算顶号", () => {
    const ctx = createContext();
    const seat = makeSeat("A");
    const room = makeRoom([seat]);
    const connection = makeConnection("c1");
    ctx.connections.registerConnection(connection);
    bindSeat(ctx, room, seat, connection);
    bindSeat(ctx, room, seat, connection);
    expect(connection.packets).toEqual([]);
    expect(connection.closes).toEqual([]);
  });

  test("连接还挂着别的座位时拒绝绑定，两边状态都不动", () => {
    const ctx = createContext();
    const first = makeSeat("A");
    const second = makeSeat("B", { online: false });
    const room = makeRoom([first, second]);
    const connection = makeConnection("c1");
    ctx.connections.registerConnection(connection);
    bindSeat(ctx, room, first, connection);
    expectAppError(() => bindSeat(ctx, room, second, connection), "SESSION_INVALID");
    expect(second.online).toBe(false);
    expect(connection.playerId).toBe("A");
  });

  test("绑定末尾房主空缺当场接任；房主仍在宽限内则不接任", () => {
    const ctx = createContext();
    const seat = makeSeat("A", { online: false });
    const room = makeRoom([seat], { hostPlayerId: "" });
    const connection = makeConnection("c1");
    ctx.connections.registerConnection(connection);
    expect(bindSeat(ctx, room, seat, connection).becameHost).toBe(true);
    expect(room.hostPlayerId).toBe("A");

    const host = makeSeat("H", { online: false });
    const guest = makeSeat("G", { online: false, joinedAt: 1 });
    const graceRoom = makeRoom([host, guest], { id: "5678", hostReconnectDeadlineAt: NOW + 1 });
    const guestConnection = makeConnection("c2");
    ctx.connections.registerConnection(guestConnection);
    expect(bindSeat(ctx, graceRoom, guest, guestConnection).becameHost).toBe(false);
    expect(graceRoom.hostPlayerId).toBe("H");
  });

  test("房主被移除而其余全离线时，离线成员凭票回来当场成为房主", () => {
    const ctx = createContext();
    const host = makeSeat("H");
    const guest = makeSeat("G", { online: false, sessionToken: "t-g" });
    const room = makeRoom([host, guest], { hostPlayerId: "" });
    delete room.players.H;
    const connection = makeConnection("c1");
    ctx.connections.registerConnection(connection);
    const seat = findSeat(ctx, room, connection, "t-g")!;
    assertSeatResumable(seat, connection);
    expect(bindSeat(ctx, room, seat, connection).becameHost).toBe(true);
    expect(room.hostPlayerId).toBe("G");
  });
});

describe("转离线", () => {
  const setup = () => {
    const ctx = createContext();
    const host = makeSeat("H");
    const guest = makeSeat("G", { joinedAt: 1 });
    const room = makeRoom([host, guest]);
    const hostConnection = makeConnection("ch");
    const guestConnection = makeConnection("cg");
    ctx.connections.registerConnection(hostConnection);
    ctx.connections.registerConnection(guestConnection);
    bindSeat(ctx, room, host, hostConnection);
    bindSeat(ctx, room, guest, guestConnection);
    return { ctx, host, guest, room, hostConnection, guestConnection };
  };

  test("房主掉线：开始重连宽限、解绑连接；还有人在线时不起空房计时", () => {
    const { ctx, host, room, hostConnection } = setup();
    expect(markSeatOffline(ctx, room, host, { emptyRoomExempt: false })).toEqual({
      wasHost: true,
      roomEmpty: false,
    });
    expect(host).toMatchObject({ online: false, connectionId: undefined, lastSeenAt: NOW });
    expect(room.hostReconnectDeadlineAt).toBe(NOW + HOST_RECONNECT_TIMEOUT_MS);
    expect(room.emptySinceAt).toBeUndefined();
    expect(hostConnection.roomId).toBeUndefined();
    expect(room.hostPlayerId).toBe("H");
  });

  test("最后一人掉线起空房计时，已有的起点不被刷新；豁免的房间不起计时", () => {
    const first = setup();
    markSeatOffline(first.ctx, first.room, first.host, { emptyRoomExempt: false });
    expect(
      markSeatOffline(first.ctx, first.room, first.guest, { emptyRoomExempt: false })
    ).toEqual({ wasHost: false, roomEmpty: true });
    expect(first.room.emptySinceAt).toBe(NOW);
    first.room.emptySinceAt = 7;
    markSeatOffline(first.ctx, first.room, first.guest, { emptyRoomExempt: false });
    expect(first.room.emptySinceAt).toBe(7);

    const second = setup();
    markSeatOffline(second.ctx, second.room, second.host, { emptyRoomExempt: true });
    expect(
      markSeatOffline(second.ctx, second.room, second.guest, { emptyRoomExempt: true }).roomEmpty
    ).toBe(true);
    expect(second.room.emptySinceAt).toBeUndefined();
  });
});

describe("解散通知", () => {
  test("先收尾对局记录，再逐连接发关闭事件、解绑、重置基线，最后清本房定时器", () => {
    const ended: GameRoomEnd[] = [];
    const cleared: string[] = [];
    const ctx = {
      ...createContext(),
      recorder: { record() {}, finishRoom: (end: GameRoomEnd) => ended.push(end) },
      timers: { clear: (roomId: string) => cleared.push(roomId) },
    };
    const first = makeSeat("A");
    const second = makeSeat("B");
    const room = makeRoom([first, second], { createdAt: 123 });
    const alive = makeConnection("c1");
    const dead = makeConnection("c2", { fail: { send: true } });
    ctx.connections.registerConnection(alive);
    ctx.connections.registerConnection(dead);
    bindSeat(ctx, room, first, alive);
    bindSeat(ctx, room, second, dead);
    alive.resets = 0;
    dead.resets = 0;

    dissolveRoom(ctx, room, { roomId: "1234", reason: "empty" });

    expect(ended).toEqual([{ game: "song", roomId: "1234", roomCreatedAt: 123, endedAt: NOW }]);
    expect(alive.packets).toEqual([
      { type: "event", event: "song.room.closed", payload: { roomId: "1234", reason: "empty" } },
    ]);
    expect(alive.roomId).toBeUndefined();
    expect(dead.roomId).toBeUndefined();
    expect([alive.resets, dead.resets]).toEqual([1, 1]);
    expect(ctx.connections.getRoomConnections("1234")).toEqual([]);
    expect(cleared).toEqual(["1234"]);
  });
});

describe("标签页接管", () => {
  const setup = (rooms: KernelRoom[]) => {
    const connections = new ConnectionRegistry();
    const roomMap = new Map(rooms.map((room) => [room.id, room]));
    rooms.forEach((room, index) => {
      const connection = makeConnection(`c${index}`, { overrides: { tabKey: "tab" } });
      connections.registerConnection(connection);
      connections.attach(connection, room.id, `p${index}`);
    });
    return { shape: kernelShape, connections, rooms: roomMap };
  };

  test("标签页坐着的每个房间都开着 MCP 才放行；玩法附加条件同样拦截", () => {
    const open = makeRoom([], { id: "1111", allowAgents: true });
    const closed = makeRoom([], { id: "2222", allowAgents: false });
    expect(() => assertTabAgentsAllowed(setup([open]), "tab")).not.toThrow();
    expectAppError(() => assertTabAgentsAllowed(setup([open, closed]), "tab"), "AGENTS_NOT_ALLOWED");
    expectAppError(
      () => assertTabAgentsAllowed(setup([open]), "tab", (room) => room.id === "1111"),
      "AGENTS_NOT_ALLOWED"
    );
    expect(() => assertTabAgentsAllowed(setup([open]), "other-tab")).not.toThrow();
  });

  test("房间已不在登记里也按未开启处理；列出房间时跳过已关闭的", () => {
    const open = makeRoom([], { id: "1111", allowAgents: true });
    const ctx = setup([open, makeRoom([], { id: "2222", allowAgents: true })]);
    ctx.rooms.delete("2222");
    expectAppError(() => assertTabAgentsAllowed(ctx, "tab"), "AGENTS_NOT_ALLOWED");
    expect(roomsOfTab(ctx, "tab")).toEqual([open]);
  });
});
