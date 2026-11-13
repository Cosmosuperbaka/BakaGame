import { describe, expect, test } from "bun:test";

import { LOBBY_MERGE_WINDOW_MS } from "../../src/application/LobbyFanout";
import { WhoIsFakerService } from "../../src/application/WhoIsFakerService";
import { ADMIN_CLOSE_REASON } from "../../src/domain/AdminRoom";
import { NOOP_GAME_RECORDER, type GameRecorder } from "../../src/domain/GameRecord";
import { EventLogger, type LogEntry } from "../../src/infrastructure/EventLogger";
import { createConnection, createTestContext, execute, getLastEventPayload } from "../Helpers";
import { TEST_ROOMS_ON } from "../TestRoomPolicy";
import { createRoom, joinPlayers } from "./Fixtures";

describe("关房", () => {
  const recordingContext = () => {
    let now = Date.UTC(2026, 3, 10);
    const finishes: Array<{ roomId: string; roomCreatedAt: number; endedAt: number }> = [];
    const entries: LogEntry[] = [];
    class RecordingLogger extends EventLogger {
      override async write(entry: LogEntry): Promise<void> {
        entries.push(entry);
        await super.write(entry);
      }
    }
    const recorder: GameRecorder = {
      ...NOOP_GAME_RECORDER,
      finishRoom: (entry) => finishes.push(entry),
    };
    const service = new WhoIsFakerService({
      now: () => now,
      testRooms: TEST_ROOMS_ON,
      eventLogger: new RecordingLogger(),
      gameRecorder: recorder,
    });
    return { service, finishes, entries, advance: (ms: number) => (now += ms) };
  };

  test("关房时成员收到关闭事件并被解绑，对局记录收尾一次，旁表清空，记日志", async () => {
    const { service, finishes, entries } = recordingContext();
    const { host } = await createRoom(service, "4001");
    const [guest] = await joinPlayers(service, "4001", 1, "客人");
    // 旁表里各挂一条：关房后一条都不能留（房号可能被新房复用）。
    service.gameOverAdvanceAllowedAtByRoomId.set("4001", 1);
    expect(service.publishedPhaseKeyByRoomId.has("4001")).toBe(true);

    await service.adminCloseRoom("4001");

    for (const client of [host, guest.connection]) {
      expect(getLastEventPayload(client, "room.closed")).toEqual({
        roomId: "4001",
        reason: ADMIN_CLOSE_REASON,
      });
      expect(client.record.roomId).toBeUndefined();
      expect(client.record.playerId).toBeUndefined();
    }
    expect(service.rooms.has("4001")).toBe(false);
    expect(service.publishedPhaseKeyByRoomId.has("4001")).toBe(false);
    expect(service.gameOverAdvanceAllowedAtByRoomId.has("4001")).toBe(false);
    expect(finishes.map((entry) => entry.roomId)).toEqual(["4001"]);
    expect(entries.filter((entry) => entry.type === "room.closed")).toEqual([
      expect.objectContaining({ roomId: "4001", payload: { reason: ADMIN_CLOSE_REASON } }),
    ]);
  });

  test("对局中关房会一并撤掉这一局的开局时间记录", async () => {
    const { service } = recordingContext();
    const { host } = await createRoom(service, "Oblivionis");
    await execute(service, host, { id: "bots", type: "test.addBot", payload: { count: 4 } });
    await execute(service, host, {
      id: "jump-words",
      type: "test.jumpToPhase",
      payload: { phase: "wordSubmission" },
    });
    await execute(service, host, {
      id: "words",
      type: "game.submitWords",
      payload: { words: ["苹果", "香蕉"] },
    });
    expect(service.roundStartedAtById.size).toBe(1);

    await service.adminCloseRoom("Oblivionis");

    expect(service.roundStartedAtById.size).toBe(0);
  });

  test("一条发不出去的连接不挡住其余成员的关闭通知，房间照常删除", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "4002");
    const [guest] = await joinPlayers(service, "4002", 1, "客人");
    host.record.send = () => {
      throw new Error("连接已断");
    };

    await service.adminCloseRoom("4002");

    expect(getLastEventPayload(guest.connection, "room.closed")).toEqual({
      roomId: "4002",
      reason: ADMIN_CLOSE_REASON,
    });
    expect(service.rooms.has("4002")).toBe(false);
  });

  test("关房会刷新大厅：合并窗后的列表不再包含已关闭的房间", async () => {
    const { service, advanceTime } = createTestContext();
    const lobby = createConnection(service, "lobby");
    await createRoom(service, "4003");
    await execute(service, lobby, { id: "sub", type: "lobby.subscribeRooms", payload: {} });
    await service.adminCloseRoom("4003");
    advanceTime(LOBBY_MERGE_WINDOW_MS);

    expect(
      getLastEventPayload<Array<{ roomId: string }>>(lobby, "lobby.rooms")?.some(
        (room) => room.roomId === "4003"
      )
    ).toBe(false);
  });
});
