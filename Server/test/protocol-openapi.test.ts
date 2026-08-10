import { expect, test } from "bun:test";

import { RoomService } from "../src/application/room-service";
import { AppError } from "../src/domain/errors";
import { EventLogger } from "../src/infrastructure/event-logger";
import { WordBankRepository } from "../src/infrastructure/word-bank-repository";
import { createApp } from "../src/transport/app";
import {
  createAck,
  createErrorPacket,
  createEvent,
  parseClientMessage,
} from "../src/transport/protocol";

// ==================== 协议与文档测试 ====================

test("协议解析可以覆盖主要客户端消息类型", () => {
  const messages = [
    {
      id: "1",
      type: "lobby.subscribeRooms",
      payload: {},
    },
    {
      id: "2",
      type: "room.create",
      payload: {
        roomId: "1234",
        name: "房间",
        visibility: "public",
        allowSpectators: true,
        userName: "玩家",
        roleConfig: {
          undercoverCount: 1,
          hasAngel: false,
          hasBlank: false,
        },
      },
    },
    {
      id: "3",
      type: "room.join",
      roomId: "1234",
      payload: {
        userName: "加入者",
        password: "123",
      },
    },
    {
      id: "4",
      type: "room.reconnect",
      payload: {
        roomId: "1234",
        sessionToken: "session",
      },
    },
    { id: "5", type: "room.leave", roomId: "1234", payload: {} },
    { id: "6", type: "player.rename", roomId: "1234", payload: { name: "新名字" } },
    {
      id: "7",
      type: "player.setSpectator",
      roomId: "1234",
      payload: { spectator: true },
    },
    { id: "8", type: "player.setReady", roomId: "1234", payload: { ready: true } },
    {
      id: "9",
      type: "room.updateSettings",
      roomId: "1234",
      payload: {
        name: "新房间",
        visibility: "private",
        password: "",
        allowSpectators: false,
        roleConfig: {
          undercoverCount: 1,
          hasAngel: false,
          hasBlank: false,
        },
      },
    },
    { id: "10", type: "room.kick", roomId: "1234", payload: { playerId: "p1" } },
    {
      id: "11",
      type: "game.assignQuestioner",
      roomId: "1234",
      payload: { playerId: "p2" },
    },
    {
      id: "12",
      type: "game.submitWords",
      roomId: "1234",
      payload: { words: ["苹果", "香蕉"], blankHint: "" },
    },
    { id: "13", type: "game.advancePhase", roomId: "1234", payload: {} },
    {
      id: "14",
      type: "game.submitDescription",
      roomId: "1234",
      payload: { text: "描述" },
    },
    {
      id: "15",
      type: "game.submitVote",
      roomId: "1234",
      payload: { targetId: "p3" },
    },
    {
      id: "16",
      type: "game.submitNightAction",
      roomId: "1234",
      payload: { targetId: null },
    },
    {
      id: "17",
      type: "game.submitBlankGuess",
      roomId: "1234",
      payload: { words: ["苹果", "香蕉"] },
    },
    {
      id: "18",
      type: "game.resolveDisconnect",
      roomId: "1234",
      payload: { playerId: "p4", resolution: "wait" },
    },
    {
      id: "19",
      type: "chat.send",
      roomId: "1234",
      payload: { text: "你好" },
    },
    { id: "20", type: "game.cancelVote", roomId: "1234", payload: {} },
    { id: "21", type: "game.cancelNightAction", roomId: "1234", payload: {} },
    {
      id: "22",
      type: "game.requestSupplement",
      roomId: "1234",
      payload: { playerIds: ["p1", "p2"] },
    },
    { id: "24", type: "game.enterBlankGuess", roomId: "1234", payload: {} },
    {
      id: "25",
      type: "game.updateBlankGuessDraft",
      roomId: "1234",
      // 草稿允许留空：白板边想边改的中间态不是非法输入。
      payload: { words: ["苹果", ""] },
    },
    {
      id: "26",
      type: "game.reviewBlankGuess",
      roomId: "1234",
      payload: { approve: true },
    },
  ] as const;

  for (const message of messages) {
    const parsed = parseClientMessage(JSON.stringify(message));
    expect(parsed.type).toBe(message.type);
    expect(parsed.id).toBe(message.id);
  }

  const objectParsed = parseClientMessage({
    id: "23",
    type: "game.resolveDisconnect",
    payload: { playerId: "p5", resolution: "eliminate" },
  });
  expect(objectParsed.type).toBe("game.resolveDisconnect");

  expect(() =>
    parseClientMessage({
      id: "invalid-array",
      type: "game.requestSupplement",
      payload: { playerIds: ["p1", 2] },
    }),
  ).toThrow(AppError);
});

test("协议解析会为非法消息抛出业务错误", () => {
  let malformedJsonError: unknown;
  try {
    parseClientMessage("not-json");
  } catch (error) {
    malformedJsonError = error;
  }
  expect(malformedJsonError).toBeInstanceOf(AppError);
  expect((malformedJsonError as AppError).code).toBe("INVALID_MESSAGE");

  expect(() =>
    parseClientMessage(
      JSON.stringify({
        id: "invalid",
        type: "unknown.type",
        payload: {},
      }),
    ),
  ).toThrow(AppError);

  expect(() =>
    parseClientMessage(
      JSON.stringify({
        id: "invalid",
        type: "game.resolveDisconnect",
        payload: { playerId: "p1", resolution: "skip" },
      }),
    ),
  ).toThrow(AppError);
});

test("协议拒绝已移除的特殊角色人数配置", () => {
  expect(() =>
    parseClientMessage({
      id: "legacy-role-count",
      type: "room.updateSettings",
      payload: {
        roleConfig: {
          undercoverCount: 2,
          hasAngel: true,
          angelCount: 2,
          hasBlank: true,
          blankCount: 2,
        },
      },
    }),
  ).toThrow(AppError);
});

test("协议辅助包与 Elysia 原生 OpenAPI 快照可以正确生成", async () => {
  const logger = new EventLogger();
  const roomService = new RoomService({
    eventLogger: logger,
    wordBankRepository: new WordBankRepository(":memory:"),
  });
  const { app } = createApp({
    env: {
      clientUrl: "http://localhost:5173",
      serverUrl: "http://127.0.0.1:4850",
      serverListenHost: "127.0.0.1",
      serverPort: 4850,
      wordBankPath: ":memory:",
    },
    roomService,
    logger,
  });

  const response = await app.handle(new Request("http://127.0.0.1:4850/openapi/json"));
  expect(response.status).toBe(200);

  const document = (await response.json()) as { paths: Record<string, unknown> };
  expect(document.paths["/health"]).toBeTruthy();
  expect(document.paths["/version"]).toBeUndefined();
  expect(createAck({ id: "ack", type: "chat.send" }, { ok: true }).type).toBe("ack");
  expect(createErrorPacket("err", "CODE", "message").type).toBe("error");
  expect(createEvent("room.snapshot", {}).type).toBe("event");
});
