import { expect, test } from "bun:test";

import { WhoIsFakerService } from "../src/application/WhoIsFakerService";
import { AppError } from "../src/domain/Errors";
import { EventLogger } from "../src/infrastructure/EventLogger";
import { createTestApp as createApp } from "./AppFixtures";
import { createAck, createErrorPacket, createEvent } from "../src/transport/Packets";
import {
  WhoIsFakerMessageSchemas,
  WhoIsFakerPayloadSchemas,
  type WhoIsFakerCommand,
} from "../src/shared/WhoIsFaker";
import { parseWhoIsFakerMessage } from "../src/transport/WhoIsFakerProtocol";

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
    { id: "sync", type: "room.requestSync", roomId: "1234", payload: {} },
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
    const parsed = parseWhoIsFakerMessage(JSON.stringify(message));
    expect(parsed.type).toBe(message.type);
    expect(parsed.id).toBe(message.id);
  }

  const objectParsed = parseWhoIsFakerMessage({
    id: "23",
    type: "game.resolveDisconnect",
    payload: { playerId: "p5", resolution: "eliminate" },
  });
  expect(objectParsed.type).toBe("game.resolveDisconnect");

  expect(() =>
    parseWhoIsFakerMessage({
      id: "invalid-array",
      type: "game.requestSupplement",
      payload: { playerIds: ["p1", 2] },
    })
  ).toThrow(AppError);
});

test("协议解析会为非法消息抛出业务错误", () => {
  let malformedJsonError: unknown;
  try {
    parseWhoIsFakerMessage("not-json");
  } catch (error) {
    malformedJsonError = error;
  }
  expect(malformedJsonError).toBeInstanceOf(AppError);
  expect((malformedJsonError as AppError).code).toBe("INVALID_MESSAGE");

  expect(() =>
    parseWhoIsFakerMessage(
      JSON.stringify({
        id: "invalid",
        type: "unknown.type",
        payload: {},
      })
    )
  ).toThrow(AppError);

  expect(() =>
    parseWhoIsFakerMessage(
      JSON.stringify({
        id: "invalid",
        type: "game.resolveDisconnect",
        payload: { playerId: "p1", resolution: "skip" },
      })
    )
  ).toThrow(AppError);
});

test("协议拒绝未定义的多余角色配置字段", () => {
  expect(() =>
    parseWhoIsFakerMessage({
      id: "extra-role-properties",
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
    })
  ).toThrow(AppError);
});

test("协议辅助包与 Elysia 原生 OpenAPI 快照可以正确生成", async () => {
  const logger = new EventLogger();
  const whoIsFakerService = new WhoIsFakerService({
    eventLogger: logger,
  });
  const { app } = createApp({
    env: {
      clientUrl: "http://localhost:5173",
      serverUrl: "http://127.0.0.1:4850",
      serverListenHost: "127.0.0.1",
      serverPort: 4850,
      bangumiApiUrl: "https://api.bgm.tv",
      bangumiImageUrl: "",
    },
    whoIsFakerService,
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

test("WhoIsFaker 协议严格拦截 payload null 与未声明脏字段", () => {
  // 1. 拒绝 payload: null
  expect(() =>
    parseWhoIsFakerMessage({
      id: "null-payload",
      type: "room.leave",
      payload: null,
    })
  ).toThrow(AppError);

  // 2. 拒绝未声明的信封脏字段
  expect(() =>
    parseWhoIsFakerMessage({
      id: "extra-envelope",
      type: "room.leave",
      payload: {},
      extraProp: "attack",
    })
  ).toThrow(AppError);

  // 3. 拒绝未声明的 payload 脏字段
  expect(() =>
    parseWhoIsFakerMessage({
      id: "extra-payload",
      type: "room.leave",
      payload: { unexpected: true },
    })
  ).toThrow(AppError);
});

// ==================== 命令清单不变量（与猜歌同一守卫） ====================

/** 每一条卧底命令的最小可发送载荷；删掉 shared 载荷表里任一条命令，这里必然变红。 */
const WHOISFAKER_COMMAND_CASES = [
  { type: "lobby.subscribeRooms", payload: {} },
  {
    type: "room.create",
    payload: {
      roomId: "1234",
      name: "房间",
      visibility: "public",
      allowSpectators: true,
      userName: "玩家",
    },
  },
  { type: "room.join", payload: { userName: "玩家" } },
  { type: "room.reconnect", payload: { roomId: "1234", sessionToken: "session" } },
  { type: "room.leave", payload: {} },
  { type: "room.requestSync", payload: {} },
  { type: "player.rename", payload: { name: "新名字" } },
  { type: "player.setSpectator", payload: { spectator: true } },
  { type: "player.setReady", payload: { ready: true } },
  { type: "room.updateSettings", payload: { name: "新房间" } },
  { type: "room.kick", payload: { playerId: "p1" } },
  { type: "game.assignQuestioner", payload: { playerId: "p2" } },
  { type: "game.submitWords", payload: { words: ["苹果", "香蕉"] } },
  { type: "game.advancePhase", payload: {} },
  { type: "game.submitDescription", payload: { text: "描述" } },
  { type: "game.submitVote", payload: { targetId: "p3" } },
  { type: "game.submitNightAction", payload: { targetId: null } },
  { type: "game.submitBlankGuess", payload: { words: ["苹果", "香蕉"] } },
  { type: "game.enterBlankGuess", payload: {} },
  { type: "game.updateBlankGuessDraft", payload: { words: ["苹果", ""] } },
  { type: "game.reviewBlankGuess", payload: { approve: true } },
  { type: "game.resolveDisconnect", payload: { playerId: "p4", resolution: "wait" } },
  { type: "chat.send", payload: { text: "你好" } },
  { type: "room.transferHost", payload: { playerId: "p1" } },
  { type: "test.jumpToPhase", payload: { phase: "waiting" } },
  { type: "test.setMyRole", payload: { role: "civilian" } },
  { type: "test.addBot", payload: {} },
  { type: "test.removeBot", payload: {} },
  { type: "game.cancelVote", payload: {} },
  { type: "game.cancelNightAction", payload: {} },
  { type: "game.requestSupplement", payload: { playerIds: ["p1"] } },
  { type: "game.startPhaseTimer", payload: { durationSeconds: 60 } },
  { type: "game.stopPhaseTimer", payload: {} },
  { type: "mcp.claim", payload: { roomId: "1234", sessionToken: "session-token" } },
  { type: "mcp.release", payload: {} },
  { type: "mcp.focus", payload: { agentName: "BakaAgent", tool: "get_room_state", kind: "state" } },
] as const satisfies readonly { type: WhoIsFakerCommand; payload: Record<string, unknown> }[];

type UnprobedWhoIsFakerCommand = Exclude<
  WhoIsFakerCommand,
  (typeof WHOISFAKER_COMMAND_CASES)[number]["type"]
>;
const everyWhoIsFakerCommandProbed: UnprobedWhoIsFakerCommand extends never ? true : never = true;

/** `Object.keys` 只给 `string[]`，比对前统一放宽，键集本身仍由上面的 satisfies/Exclude 锁死。 */
const sortedNames = (values: readonly string[]): string[] => [...values].sort();

test("卧底命令表与传输层信封键集完全一致", () => {
  expect(everyWhoIsFakerCommandProbed).toBe(true);
  const payloadKeys = sortedNames(Object.keys(WhoIsFakerPayloadSchemas));
  expect(sortedNames(Object.keys(WhoIsFakerMessageSchemas))).toEqual(payloadKeys);
  expect(sortedNames(WHOISFAKER_COMMAND_CASES.map((item) => item.type))).toEqual(payloadKeys);
});

test("卧底每一条命令都能通过传输层解析", () => {
  for (const { type, payload } of WHOISFAKER_COMMAND_CASES) {
    const parsed = parseWhoIsFakerMessage({
      id: `probe-${type}`,
      type,
      roomId: "1234",
      payload,
    });
    expect(parsed.type).toBe(type);
  }
});

test("卧底信封骨架统一为七个字段且保持严格", () => {
  for (const schema of Object.values(WhoIsFakerMessageSchemas)) {
    expect(Object.keys(schema.properties).sort()).toEqual([
      "game",
      "id",
      "payload",
      "roomId",
      "sessionToken",
      "traceId",
      "type",
    ]);
    expect([...schema.required].sort()).toEqual(["id", "payload", "type"]);
    expect(schema.additionalProperties).toBe(false);
  }
});
