import { expect, test } from "bun:test";

import { GAME_COMMAND_TYPES } from "../src/application/handlers/game-command-handler";
import { PLAYER_COMMAND_TYPES } from "../src/application/handlers/player-command-handler";
import { ROOM_COMMAND_TYPES } from "../src/application/handlers/room-command-handler";
import { TEST_COMMAND_TYPES } from "../src/application/handlers/test-command-handler";
import type { ClientMessage } from "../src/transport/protocol";

const ALL_COMMAND_TYPES = [
  "lobby.subscribeRooms",
  "room.create",
  "room.join",
  "room.reconnect",
  "room.leave",
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
] as const satisfies readonly ClientMessage["type"][];

type MissingCommandType = Exclude<
  ClientMessage["type"],
  (typeof ALL_COMMAND_TYPES)[number]
>;
const allCommandTypesCovered: MissingCommandType extends never ? true : never = true;

test("每个客户端命令恰好归属一个处理器", () => {
  const groupedTypes = [
    ...ROOM_COMMAND_TYPES,
    ...PLAYER_COMMAND_TYPES,
    ...GAME_COMMAND_TYPES,
    ...TEST_COMMAND_TYPES,
  ];

  expect(new Set(groupedTypes).size).toBe(groupedTypes.length);
  expect(allCommandTypesCovered).toBe(true);
  expect([...groupedTypes].sort()).toEqual([...ALL_COMMAND_TYPES].sort());
});
