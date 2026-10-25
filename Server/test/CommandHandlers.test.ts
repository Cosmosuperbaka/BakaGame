import { expect, test } from "bun:test";

import { GAME_COMMAND_TYPES } from "../src/application/whoisfaker/GameCommandHandler";
import { PLAYER_COMMAND_TYPES } from "../src/application/whoisfaker/PlayerCommandHandler";
import { ROOM_COMMAND_TYPES } from "../src/application/whoisfaker/RoomCommandHandler";
import { TEST_COMMAND_TYPES } from "../src/application/whoisfaker/TestCommandHandler";
import { WhoIsFakerMessageSchemas, WhoIsFakerPayloadSchemas } from "../src/shared/WhoIsFaker";
import type { WhoIsFakerClientMessage } from "../src/shared/Index";

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
  "mcp.claim",
  "mcp.release",
  "mcp.focus",
] as const satisfies readonly WhoIsFakerClientMessage["type"][];

type MissingCommandType = Exclude<
  WhoIsFakerClientMessage["type"],
  (typeof ALL_COMMAND_TYPES)[number]
>;
const allCommandTypesCovered: MissingCommandType extends never ? true : never = true;

const HANDLER_COMMAND_TYPES = [
  ...ROOM_COMMAND_TYPES,
  ...PLAYER_COMMAND_TYPES,
  ...GAME_COMMAND_TYPES,
  ...TEST_COMMAND_TYPES,
];

test("每个客户端命令恰好归属一个处理器", () => {
  expect(new Set(HANDLER_COMMAND_TYPES).size).toBe(HANDLER_COMMAND_TYPES.length);
  expect(allCommandTypesCovered).toBe(true);
  expect([...HANDLER_COMMAND_TYPES].sort()).toEqual([...ALL_COMMAND_TYPES].sort());
});

test("处理器清单与传输层命令表键集一致", () => {
  // 同一条命令清单在处理器数组、shared 载荷表与派生信封三处各有一份；漏配任意一处，
  // 表现都是「类型有、处理器有、协议恒拒」的静默失效，只能在运行时用键集比对拦住。
  expect(Object.keys(WhoIsFakerPayloadSchemas).sort()).toEqual([...HANDLER_COMMAND_TYPES].sort());
  expect(Object.keys(WhoIsFakerMessageSchemas).sort()).toEqual([...ALL_COMMAND_TYPES].sort());
});
