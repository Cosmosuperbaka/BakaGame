import { expect, test } from "bun:test";

import { createWhoIsFakerCommands } from "../src/application/whoisfaker/Commands";
import { createWhoIsFakerContext } from "../src/application/whoisfaker/Context";
import { EventLogger } from "../src/infrastructure/EventLogger";
import { WhoIsFakerMessageSchemas, WhoIsFakerPayloadSchemas } from "../src/shared/WhoIsFaker";
import type { WhoIsFakerClientMessage } from "../src/shared/Index";
import { TEST_ROOMS_ON } from "./TestRoomPolicy";

const ALL_COMMAND_TYPES = [
  "lobby.subscribeRooms",
  "room.create",
  "room.join",
  "room.reconnect",
  "room.leave",
  "room.requestSync",
  "player.rename",
  "player.setSpectator",
  "player.setReady",
  "room.updateSettings",
  "room.kick",
  "game.assignQuestioner",
  "game.submitWords",
  "game.advancePhase",
  "game.submitDescription",
  "game.submitVote",
  "game.submitNightAction",
  "game.submitBlankGuess",
  "game.enterBlankGuess",
  "game.updateBlankGuessDraft",
  "game.reviewBlankGuess",
  "game.resolveDisconnect",
  "chat.send",
  "room.transferHost",
  "test.jumpToPhase",
  "test.setMyRole",
  "test.addBot",
  "test.removeBot",
  "game.cancelVote",
  "game.cancelNightAction",
  "game.requestSupplement",
  "game.startPhaseTimer",
  "game.stopPhaseTimer",
] as const satisfies readonly WhoIsFakerClientMessage["type"][];

type MissingCommandType = Exclude<
  WhoIsFakerClientMessage["type"],
  (typeof ALL_COMMAND_TYPES)[number]
>;
// 编译期守卫：漏登记命令时这一行类型检查不过；运行期断言它恒为 true 没有意义。
const allCommandTypesCovered: MissingCommandType extends never ? true : never = true;
void allCommandTypesCovered;

const ctx = createWhoIsFakerContext({ eventLogger: new EventLogger(), testRooms: TEST_ROOMS_ON });
const table = createWhoIsFakerCommands(ctx);
const TABLE_COMMAND_TYPES = Object.keys(table);

test("每个客户端命令在命令表里恰好有一条", () => {
  // 对象键天然不会重复；映射类型在编译期保证漏一条就编译失败，这里在运行期再核一次键集。
  expect([...TABLE_COMMAND_TYPES].sort()).toEqual([...ALL_COMMAND_TYPES].sort());
});

test("命令表键集与传输层命令表键集一致", () => {
  // 同一条命令清单在命令表、shared 载荷表与派生信封三处各有一份；漏配任意一处，
  // 表现都是「类型有、处理器有、协议恒拒」的静默失效，只能在运行时用键集比对拦住。
  expect(Object.keys(WhoIsFakerPayloadSchemas).sort()).toEqual([...TABLE_COMMAND_TYPES].sort());
  expect(Object.keys(WhoIsFakerMessageSchemas).sort()).toEqual([...ALL_COMMAND_TYPES].sort());
});

test("除大厅类命令外，每条命令都对阶段表了态", () => {
  for (const [type, spec] of Object.entries(table)) {
    if (spec.access === "lobby") continue;
    expect(spec.phases, type).toBeDefined();
  }
});

test("大厅类命令只有订阅大厅与建房、入房、重连四条", () => {
  const lobby = Object.entries(table)
    .filter(([, spec]) => spec.access === "lobby")
    .map(([type]) => type)
    .sort();
  expect(lobby).toEqual(["lobby.subscribeRooms", "room.create", "room.join", "room.reconnect"]);
});

test("四条测试指令都先问测试房策略、再验房主", () => {
  // 房主判定写成玩法守卫而不是 `access: "host"`：内核的房主判定排在玩法守卫之前，
  // 会让非测试房里的非房主先拿到「只有房主」，给探测者留下区分信号。
  const room = (id: string) => ({ id, hostPlayerId: "host" }) as never;
  const seat = (id: string) => ({ id }) as never;
  const guardsOf = (type: string) => {
    const spec = table[type as keyof typeof table];
    if (spec.access !== "seat") throw new Error(`${type} 应为座位命令`);
    return spec.guards ?? [];
  };
  const run = (type: string, roomId: string, seatId: string) => {
    try {
      for (const guard of guardsOf(type)) {
        guard({ connection: {} as never, room: room(roomId), seat: seat(seatId) });
      }
    } catch (error) {
      return (error as { code: string }).code;
    }
    return "ok";
  };
  for (const type of ["test.jumpToPhase", "test.setMyRole", "test.addBot", "test.removeBot"]) {
    expect(guardsOf(type), type).toHaveLength(2);
    // 非测试房：房主与非房主一样当作不支持。
    expect(run(type, "1234", "host"), type).toBe("UNSUPPORTED_COMMAND");
    expect(run(type, "1234", "guest"), type).toBe("UNSUPPORTED_COMMAND");
    // 测试房：非房主被拒，房主放行。
    expect(run(type, "Oblivionis", "guest"), type).toBe("FORBIDDEN");
    expect(run(type, "Oblivionis", "host"), type).toBe("ok");
  }
});
