import { describe, expect, test } from "bun:test";

import { WhoIsFakerService } from "../../src/application/WhoIsFakerService";
import { CHAT_LIMIT, CHAT_RATE_LIMIT_WINDOW_MS } from "../../src/config/Constants";
import { EventLogger, type LogEntry } from "../../src/infrastructure/EventLogger";
import type { WhoIsFakerRoomSnapshot } from "../../src/shared/Index";
import { TEST_ROOMS_ON } from "../TestRoomPolicy";
import { createTestContext, execute, getLastEventPayload } from "../Helpers";
import { createRoom, joinPlayers } from "./Fixtures";

const chatOf = (host: Parameters<typeof getLastEventPayload>[0]) =>
  getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot")?.chat ?? [];

describe("聊天受理与系统消息", () => {
  test("空消息回 INVALID_CHAT；长消息不截断，原样进入聊天记录", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "6001");

    await expect(
      execute(service, host, { id: "empty", type: "chat.send", payload: { text: "   " } })
    ).rejects.toMatchObject({ code: "INVALID_CHAT" });

    const long = "啊".repeat(500);
    await execute(service, host, { id: "long", type: "chat.send", payload: { text: long } });
    expect(chatOf(host).at(-1)).toMatchObject({ text: long, system: false, channel: "main" });
  });

  test("聊天窗口只保留最近一段，新消息在末尾", async () => {
    const { service, advanceTime } = createTestContext();
    const { host } = await createRoom(service, "6002");

    for (let index = 0; index < CHAT_LIMIT + 5; index += 1) {
      await execute(service, host, {
        id: `chat-${index}`,
        type: "chat.send",
        payload: { text: `消息${index}` },
      });
      // 每条连接的额度按窗口计：翻过窗口再发，只验证窗口形状。
      if (index % 4 === 3) advanceTime(CHAT_RATE_LIMIT_WINDOW_MS);
    }

    const chat = chatOf(host);
    expect(chat).toHaveLength(CHAT_LIMIT);
    expect(chat.at(-1)?.text).toBe(`消息${CHAT_LIMIT + 4}`);
    expect(chat.some((message) => message.text === "消息0")).toBe(false);
  });

  test("系统消息：固定的系统发送者、系统标记与主频道", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "6003");
    const [guest] = await joinPlayers(service, "6003", 1, "客人");
    await execute(service, host, {
      id: "transfer",
      type: "room.transferHost",
      payload: { playerId: guest.joinResult.playerId },
    });

    const announcement = chatOf(host).find((message) => message.text.includes("将房主转移给了"));
    expect(announcement).toMatchObject({
      playerId: "system",
      playerName: "系统",
      system: true,
      channel: "main",
    });
  });

  test("发言写一条 chat.sent 日志，带原文与频道", async () => {
    let now = Date.UTC(2026, 3, 10);
    const entries: LogEntry[] = [];
    class RecordingLogger extends EventLogger {
      override async write(entry: LogEntry): Promise<void> {
        entries.push(entry);
        await super.write(entry);
      }
    }
    const service = new WhoIsFakerService({
      now: () => now,
      testRooms: TEST_ROOMS_ON,
      eventLogger: new RecordingLogger(),
    });
    const { host } = await createRoom(service, "6004");
    await execute(service, host, { id: "chat", type: "chat.send", payload: { text: "你好" } });
    now += 1;

    expect(entries.filter((entry) => entry.type === "chat.sent")).toEqual([
      expect.objectContaining({
        roomId: "6004",
        payload: { text: "你好", channel: "main", ghostRole: undefined },
      }),
    ]);
  });
});

describe("在线计数与后台房间视图", () => {
  test("后台视图：测试房标记隐藏、普通房不隐藏，房间与成员字段映射齐全", async () => {
    const { service } = createTestContext();
    await createRoom(service, "Oblivionis");
    await createRoom(service, "6005");

    const views = service.adminListRooms();
    expect(views.map((view) => [view.roomId, view.hidden])).toEqual([
      ["Oblivionis", true],
      ["6005", false],
    ]);
    expect(views[1]).toMatchObject({
      game: "faker",
      name: "6005-房间",
      phase: "waiting",
      visibility: "public",
      hasPassword: false,
      roundNumber: 0,
    });
    expect(views[1].players).toEqual([
      {
        id: expect.any(String),
        name: "房主",
        online: true,
        membership: "active",
        host: true,
        bot: false,
        userId: null,
      },
    ]);
  });

  test("在线人数只数在线的成员：大厅摘要与健康快照同口径，掉线的不计", async () => {
    const { service } = createTestContext();
    await createRoom(service, "6006");
    const guests = await joinPlayers(service, "6006", 2, "客人");
    expect(service.getRoomSummaries()[0].onlineCount).toBe(3);
    expect(service.getHealthSnapshot().onlinePlayerCount).toBe(3);

    await service.unregisterConnection(guests[0].connection.record.id);

    expect(service.getRoomSummaries()[0].onlineCount).toBe(2);
    expect(service.getHealthSnapshot().onlinePlayerCount).toBe(2);
  });
});
