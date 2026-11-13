import { describe, expect, test } from "bun:test";

import {
  CommandQuota,
  dispatchCommand,
  type CommandDispatcher,
  type CommandSeat,
  type CommandTable,
  type Guard,
} from "../../src/application/room/CommandTable";
import { AppError } from "../../src/domain/Errors";
import type { ConnectionRecord } from "../../src/shared/Model";
import { expectAppError, expectAppErrorAsync, makeConnection } from "./RoomKernelFixtures";

type Message =
  | { type: "lobby.subscribe"; payload: Record<string, never> }
  | { type: "room.update"; payload: { name: string } }
  | { type: "game.act"; payload: { amount: number } }
  | { type: "test.addBot"; payload: { count: number } };
type Phase = "waiting" | "playing";

interface Seat {
  id: string;
}
interface Room {
  id: string;
  hostPlayerId: string;
  phase: Phase;
  testRoom: boolean;
  seats: Map<string, Seat>;
  name: string;
}
interface Deps {
  log: string[];
}

const WAITING = {
  allow: ["waiting"],
  code: "INVALID_PHASE",
  message: "只能在等待阶段修改",
} as const;
const testRoomOnly: Guard<Room, Seat> = ({ room }) => {
  if (!room.testRoom) throw new AppError("TEST_ROOM_ONLY", "只有测试房可以使用");
};

/** 让 run 停在 await 上，由用例在中途改房间状态后再放行。 */
const createGate = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { wait: promise, open: resolve };
};

const createSetup = () => {
  const rooms = new Map<string, Room>();
  const room: Room = {
    id: "1234",
    hostPlayerId: "host",
    phase: "waiting",
    testRoom: true,
    seats: new Map([
      ["host", { id: "host" }],
      ["guest", { id: "guest" }],
    ]),
    name: "",
  };
  rooms.set(room.id, room);
  const deps: Deps = { log: [] };
  const gate = { current: createGate() };
  const resolved: string[] = [];
  const table: CommandTable<Message, Deps, Room, Seat, Phase> = {
    "lobby.subscribe": {
      access: "lobby",
      run: (d, connection) => {
        d.log.push(`lobby:${connection.id}`);
        return { subscribed: true };
      },
    },
    "room.update": {
      access: "host",
      phases: WAITING,
      run: async (d, at, message) => {
        await gate.current.wait;
        at.recheck();
        at.room.name = message.payload.name;
        d.log.push(`update:${message.payload.name}`);
        return { name: at.room.name };
      },
    },
    "game.act": {
      access: "seat",
      phases: "any",
      run: (d, at, message) => {
        d.log.push(`act:${at.seat.id}:${message.payload.amount}`);
      },
    },
    "test.addBot": {
      access: "host",
      phases: "any",
      guards: [testRoomOnly],
      run: async (d, at, message) => {
        await gate.current.wait;
        at.recheck();
        d.log.push(`bots:${message.payload.count}`);
      },
    },
  };
  const dispatcher: CommandDispatcher<Message, Deps, Room, Seat, Phase> = {
    table,
    deps,
    resolveSeat: (connection) => {
      resolved.push(connection.id);
      const seat = connection.playerId ? room.seats.get(connection.playerId) : undefined;
      if (!seat) throw new AppError("PLAYER_NOT_IN_ROOM", "当前连接尚未加入房间");
      return { room, seat };
    },
    isRoomRegistered: (candidate) => rooms.get(candidate.id) === candidate,
    isSeated: (candidate, seat) => candidate.seats.get(seat.id) === seat,
    hostIdOf: (candidate) => candidate.hostPlayerId,
    phaseOf: (candidate) => candidate.phase,
  };
  const as = (playerId?: string, id = `c-${playerId ?? "lobby"}`) =>
    makeConnection(id, { overrides: { roomId: "1234", playerId } });
  return { rooms, room, deps, gate, resolved, dispatcher, as };
};

const open = (setup: ReturnType<typeof createSetup>) => {
  setup.gate.current.open();
};

describe("命令分发与准入", () => {
  test("大厅命令不解析席位直接执行", async () => {
    const setup = createSetup();
    const result = await dispatchCommand(setup.dispatcher, setup.as(undefined, "c1"), {
      type: "lobby.subscribe",
      payload: {},
    });
    expect(result).toEqual({ subscribed: true });
    expect(setup.resolved).toEqual([]);
    expect(setup.deps.log).toEqual(["lobby:c1"]);
  });

  test("access：解析不到席位由玩法报错；房主命令拒绝非房主", async () => {
    const setup = createSetup();
    await expectAppErrorAsync(
      () => dispatchCommand(setup.dispatcher, setup.as(undefined), act(1)),
      "PLAYER_NOT_IN_ROOM"
    );
    await expectAppErrorAsync(
      () => dispatchCommand(setup.dispatcher, setup.as("guest"), update("x")),
      "FORBIDDEN"
    );
    await dispatchCommand(setup.dispatcher, setup.as("guest"), act(2));
    expect(setup.deps.log).toEqual(["act:guest:2"]);
  });

  test("access：解析出的座位已不在名册同样拒绝", async () => {
    const setup = createSetup();
    setup.room.seats.set("guest", { id: "guest" });
    const stale = { id: "guest" };
    setup.dispatcher.resolveSeat = () => ({ room: setup.room, seat: stale });
    await expectAppErrorAsync(
      () => dispatchCommand(setup.dispatcher, setup.as("guest"), act(1)),
      "PLAYER_NOT_FOUND"
    );
  });

  test("phases：不在允许的阶段按声明的码与文案拒绝", async () => {
    const setup = createSetup();
    setup.room.phase = "playing";
    await expectAppErrorAsync(
      () => dispatchCommand(setup.dispatcher, setup.as("host"), update("x")),
      "INVALID_PHASE"
    );
  });

  test("guards：玩法守卫不成立时拒绝，且在执行之前", async () => {
    const setup = createSetup();
    setup.room.testRoom = false;
    await expectAppErrorAsync(
      () => dispatchCommand(setup.dispatcher, setup.as("host"), addBot(1)),
      "TEST_ROOM_ONLY"
    );
    expect(setup.deps.log).toEqual([]);
  });

  test("运行时遇到表里没有的命令类型回不支持", async () => {
    const setup = createSetup();
    await expectAppErrorAsync(
      () =>
        dispatchCommand(setup.dispatcher, setup.as("host"), {
          type: "room.unknown",
          payload: {},
        } as unknown as Message),
      "UNSUPPORTED_COMMAND"
    );
  });

  test("命令类型撞上对象原型上的名字时同样回不支持，不把继承来的成员当命令", async () => {
    const setup = createSetup();
    for (const type of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      await expectAppErrorAsync(
        () =>
          dispatchCommand(setup.dispatcher, setup.as("host"), {
            type,
            payload: {},
          } as unknown as Message),
        "UNSUPPORTED_COMMAND"
      );
    }
  });
});

describe("await 之后的复核 recheck", () => {
  const pending = (setup: ReturnType<typeof createSetup>, message: Message) =>
    dispatchCommand(setup.dispatcher, setup.as("host"), message);

  test("条件不变时 await 回来照常执行", async () => {
    const setup = createSetup();
    const running = pending(setup, update("新名字"));
    open(setup);
    expect(await running).toEqual({ name: "新名字" });
  });

  test("房间在 await 期间被删（或同号重建）：抛房间不存在，不写入", async () => {
    const setup = createSetup();
    const running = pending(setup, update("x"));
    setup.rooms.set("1234", { ...setup.room });
    open(setup);
    await expectAppErrorAsync(() => running, "ROOM_NOT_FOUND");
    expect(setup.room.name).toBe("");
  });

  test("座位在 await 期间被移出：抛座位不存在", async () => {
    const setup = createSetup();
    const running = pending(setup, update("x"));
    setup.room.seats.delete("host");
    open(setup);
    await expectAppErrorAsync(() => running, "PLAYER_NOT_FOUND");
  });

  test("房主在 await 期间换人：重跑 access 拒绝", async () => {
    const setup = createSetup();
    const running = pending(setup, update("x"));
    setup.room.hostPlayerId = "guest";
    open(setup);
    await expectAppErrorAsync(() => running, "FORBIDDEN");
  });

  test("阶段在 await 期间变化：重跑 phases 拒绝", async () => {
    const setup = createSetup();
    const running = pending(setup, update("x"));
    setup.room.phase = "playing";
    open(setup);
    await expectAppErrorAsync(() => running, "INVALID_PHASE");
    expect(setup.room.name).toBe("");
  });

  test("守卫在 await 期间不再成立：重跑 guards 拒绝", async () => {
    const setup = createSetup();
    const running = pending(setup, addBot(2));
    setup.room.testRoom = false;
    open(setup);
    await expectAppErrorAsync(() => running, "TEST_ROOM_ONLY");
    expect(setup.deps.log).toEqual([]);
  });
});

describe("命令表的穷尽性（编译期）", () => {
  test("缺键、多键、按错误的消息类型取字段都是编译错误", () => {
    const run = () => undefined;
    // @ts-expect-error 缺少 "test.addBot" 这一条
    const missing: CommandTable<Message, Deps, Room, Seat, Phase> = {
      "lobby.subscribe": { access: "lobby", run },
      "room.update": { access: "host", phases: "any", run },
      "game.act": { access: "seat", phases: "any", run },
    };
    const extra: CommandTable<Message, Deps, Room, Seat, Phase> = {
      "lobby.subscribe": { access: "lobby", run },
      "room.update": { access: "host", phases: "any", run },
      "game.act": { access: "seat", phases: "any", run },
      "test.addBot": { access: "host", phases: "any", run },
      // @ts-expect-error 协议里没有这条命令
      "room.ghost": { access: "lobby", run },
    };
    const noPhases: CommandTable<Message, Deps, Room, Seat, Phase> = {
      "lobby.subscribe": { access: "lobby", run },
      // @ts-expect-error 非大厅命令必须对阶段表态
      "room.update": { access: "host", run },
      "game.act": { access: "seat", phases: "any", run },
      "test.addBot": { access: "host", phases: "any", run },
    };
    const wrongField: CommandTable<Message, Deps, Room, Seat, Phase> = {
      "lobby.subscribe": { access: "lobby", run },
      "room.update": {
        access: "host",
        phases: "any",
        run: (_deps, _at: CommandSeat<Room, Seat>, message) => {
          // @ts-expect-error room.update 的载荷没有 amount
          void message.payload.amount;
        },
      },
      "game.act": { access: "seat", phases: "any", run },
      "test.addBot": { access: "host", phases: "any", run },
    };
    expect([missing, extra, noPhases, wrongField].every(Boolean)).toBe(true);
  });
});

describe("每连接命令总额度", () => {
  test("超额被拒、别的连接不受影响、窗口过后恢复", () => {
    const clock = { now: 0 };
    const quota = new CommandQuota({ now: () => clock.now, windowMs: 1_000, maxRequests: 2 });
    const first: ConnectionRecord = makeConnection("c1");
    quota.consume(first);
    quota.consume(first);
    expectAppError(() => quota.consume(first), "RATE_LIMITED");
    expect(() => quota.consume(makeConnection("c2"))).not.toThrow();
    clock.now += 1_001;
    expect(() => quota.consume(first)).not.toThrow();
  });
});

function act(amount: number): Message {
  return { type: "game.act", payload: { amount } };
}
function update(name: string): Message {
  return { type: "room.update", payload: { name } };
}
function addBot(count: number): Message {
  return { type: "test.addBot", payload: { count } };
}
