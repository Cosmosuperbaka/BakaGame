import { describe, expect, test } from "bun:test";
import { createRoom, joinPlayers } from "./Fixtures";
import {
  CHAT_RATE_LIMIT_PER_CONNECTION,
  CHAT_RATE_LIMIT_WINDOW_MS,
  PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS,
  ROOM_EMPTY_GRACE_PERIOD_MS,
  SPECTATOR_OFFLINE_GRACE_MS,
} from "../../src/config/Constants";
import { NOOP_GAME_RECORDER } from "../../src/domain/GameRecord";
import { WhoIsFakerService } from "../../src/application/WhoIsFakerService";
import { EventLogger, type LogEntry } from "../../src/infrastructure/EventLogger";
import { type WhoIsFakerRoomSnapshot } from "../../src/shared/Index";
import { createConnection, createTestContext, execute, getLastEventPayload } from ".././Helpers";
import { TEST_ROOMS_ON } from "../TestRoomPolicy";

describe("清理与聊天", () => {
  test("真人离开测试房间后测试房间自动关闭", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "Oblivionis");

    await execute(service, host, {
      id: "leave-test-room",
      type: "room.leave",
      payload: {},
    });

    const rejoin = createConnection(service, "oblivionis-new-human");
    // 房间已关闭，直接加入会找不到房间
    await expect(
      execute(service, rejoin, {
        id: "join-new",
        type: "room.join",
        roomId: "Oblivionis",
        payload: { userName: "新玩家" },
      })
    ).rejects.toThrow("房间不存在");

    // 再次创建 Oblivionis 则是全新房间
    const { result: createResult } = await createRoom(service, "Oblivionis");
    expect(createResult.roomId).toBe("Oblivionis");
  });

  test("0 分旁观者掉线留够一次刷新的时间，超过宽限才移出", async () => {
    const { service, advanceTime } = createTestContext();
    await createRoom(service, "3333");
    const spectatorConn = createConnection(service, "spec-conn");
    const joinResult = (await execute(service, spectatorConn, {
      id: "join-spec",
      type: "room.join",
      roomId: "3333",
      payload: { userName: "旁观者" },
    })) as { playerId: string; sessionToken: string };
    await execute(service, spectatorConn, {
      id: "set-spec",
      type: "player.setSpectator",
      payload: { spectator: true },
    });

    const room = service.rooms.get("3333")!;
    expect(room.players[joinResult.playerId]).toBeDefined();

    // 刷新：连接断开后席位还在，新连接凭原票据回到旁观席。
    await service.unregisterConnection(spectatorConn.record.id);
    expect(room.players[joinResult.playerId]).toMatchObject({
      online: false,
      membership: "spectator",
    });
    const refreshed = createConnection(service, "spec-refreshed");
    const resumed = (await execute(service, refreshed, {
      id: "reconnect-spec",
      type: "room.reconnect",
      payload: { roomId: "3333", sessionToken: joinResult.sessionToken },
    })) as { playerId: string };
    expect(resumed.playerId).toBe(joinResult.playerId);
    expect(room.players[joinResult.playerId]).toMatchObject({
      online: true,
      membership: "spectator",
    });

    // 真走了：宽限内仍保留，超过才移出，且不等普通玩家那么久。
    await service.unregisterConnection(refreshed.record.id);
    advanceTime(SPECTATOR_OFFLINE_GRACE_MS - 1);
    await service.runHousekeeping();
    expect(room.players[joinResult.playerId]).toBeDefined();
    advanceTime(1);
    await service.runHousekeeping();
    expect(room.players[joinResult.playerId]).toBeUndefined();
  });

  test("退出房间的玩家即使有积分也会被正确清理", async () => {
    const { service } = createTestContext();
    await createRoom(service, "4444");
    const playerConn = createConnection(service, "player-conn");
    const joinResult = (await execute(service, playerConn, {
      id: "join-player",
      type: "room.join",
      roomId: "4444",
      payload: { userName: "有分玩家" },
    })) as { playerId: string };

    const room = service.rooms.get("4444")!;
    room.players[joinResult.playerId]!.score = 10;

    await execute(service, playerConn, {
      id: "leave-player",
      type: "room.leave",
      payload: {},
    });

    expect(room.players[joinResult.playerId]).toBeUndefined();
  });

  test("掉线玩家3分钟后由 housekeeping 自动清理", async () => {
    const { service, advanceTime } = createTestContext();
    await createRoom(service, "5555");
    const playerConn = createConnection(service, "offline-player-conn");
    const joinResult = (await execute(service, playerConn, {
      id: "join-player",
      type: "room.join",
      roomId: "5555",
      payload: { userName: "掉线玩家" },
    })) as { playerId: string };

    const room = service.rooms.get("5555")!;
    await service.unregisterConnection(playerConn.record.id);
    expect(room.players[joinResult.playerId]).toBeDefined();
    expect(room.players[joinResult.playerId]?.online).toBe(false);

    // 模拟2分钟过去，尚未超时
    advanceTime(2 * 60 * 1000);
    await service.runHousekeeping();
    expect(room.players[joinResult.playerId]).toBeDefined();

    // 模拟超过3分钟过去（累计3分01秒）
    advanceTime(1 * 60 * 1000 + 1000);
    await service.runHousekeeping();
    expect(room.players[joinResult.playerId]).toBeUndefined();
  });

  test("房主掉线1分钟后自动移交房主", async () => {
    const { service, advanceTime } = createTestContext();
    const { host, result: hostResult } = await createRoom(service, "6666");
    const playerConn = createConnection(service, "next-host-conn");
    const joinResult = (await execute(service, playerConn, {
      id: "join-player",
      type: "room.join",
      roomId: "6666",
      payload: { userName: "接任房主" },
    })) as { playerId: string };

    const room = service.rooms.get("6666")!;
    expect(room.hostPlayerId).toBe(hostResult.playerId);

    await service.unregisterConnection(host.record.id);
    expect(room.hostPlayerId).toBe(hostResult.playerId);
    expect(room.hostReconnectDeadlineAt).toBeDefined();

    // 30秒过去，房主尚未移交
    advanceTime(30 * 1000);
    await service.runHousekeeping();
    expect(room.hostPlayerId).toBe(hostResult.playerId);

    // 累计61秒过去，房主已移交给下一位在线正式玩家
    advanceTime(31 * 1000);
    await service.runHousekeeping();
    expect(room.hostPlayerId).toBe(joinResult.playerId);
  });

  test("游戏进行中死亡玩家与旁观者发言归入ghost频道且仅对有权限者可见", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "7777", "房主");
    const joined = await joinPlayers(service, "7777", 4, "玩家");
    const spectatorConn = createConnection(service, "7777-spectator");
    await execute(service, spectatorConn, {
      id: "spectator-join",
      type: "room.join",
      roomId: "7777",
      payload: { userName: "旁观者" },
    });
    await execute(service, spectatorConn, {
      id: "set-spectator",
      type: "player.setSpectator",
      roomId: "7777",
      payload: { spectator: true },
    });

    // 旁观者读亡者频道要房主打开旁观可见答案；关闭时的口径另有用例。
    await execute(service, host, {
      id: "spectators-see",
      type: "room.updateSettings",
      roomId: "7777",
      payload: { spectatorsSeeAnswers: true },
    });
    // 全员准备并开局
    for (const item of joined) {
      await execute(service, item.connection, {
        id: "ready",
        type: "player.setReady",
        roomId: "7777",
        payload: { ready: true },
      });
    }
    await execute(service, host, {
      id: "host-ready",
      type: "player.setReady",
      roomId: "7777",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "start",
      type: "game.advancePhase",
      roomId: "7777",
      payload: {},
    });
    await execute(service, host, {
      id: "assign-q",
      type: "game.assignQuestioner",
      roomId: "7777",
      payload: { playerId: joined[0].joinResult.playerId },
    });
    await execute(service, joined[0].connection, {
      id: "submit-words",
      type: "game.submitWords",
      roomId: "7777",
      payload: { words: ["苹果", "香蕉"] },
    });

    const room = service.rooms.get("7777")!;
    expect(room.round!.phase).toBe("description");

    // 正常存活玩家发言
    await execute(service, host, {
      id: "alive-chat",
      type: "chat.send",
      roomId: "7777",
      payload: { text: "我是活人发言" },
    });

    // 旁观者发言
    await execute(service, spectatorConn, {
      id: "spectator-chat",
      type: "chat.send",
      roomId: "7777",
      payload: { text: "我是旁观者发言" },
    });

    // 模拟其中一位玩家死亡
    const deadPlayerId = joined[1].joinResult.playerId;
    room.round!.assignments[deadPlayerId].alive = false;

    // 死亡玩家发言
    await execute(service, joined[1].connection, {
      id: "dead-chat",
      type: "chat.send",
      roomId: "7777",
      payload: { text: "我是亡者发言" },
    });

    // 检查存活玩家收到的 snapshot.chat：只能看到活人发言与系统消息，看不到旁观者和亡者发言
    const hostSnapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(host, "room.snapshot");
    const hostChatTexts = hostSnapshot?.chat.map((m) => m.text);
    expect(hostChatTexts).toContain("我是活人发言");
    expect(hostChatTexts).not.toContain("我是旁观者发言");
    expect(hostChatTexts).not.toContain("我是亡者发言");

    // 检查旁观者收到的 snapshot.chat：能看到活人、旁观者、亡者的全部发言
    const spectatorSnapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(
      spectatorConn,
      "room.snapshot"
    );
    const spectatorChatTexts = spectatorSnapshot?.chat.map((m) => m.text);
    expect(spectatorChatTexts).toContain("我是活人发言");
    expect(spectatorChatTexts).toContain("我是旁观者发言");
    expect(spectatorChatTexts).toContain("我是亡者发言");

    // 检查死亡玩家收到的 snapshot.chat：同样能看到全部发言
    const deadPlayerSnapshot = getLastEventPayload<WhoIsFakerRoomSnapshot>(
      joined[1].connection,
      "room.snapshot"
    );
    const deadChatTexts = deadPlayerSnapshot?.chat.map((m) => m.text);
    expect(deadChatTexts).toContain("我是活人发言");
    expect(deadChatTexts).toContain("我是旁观者发言");
    expect(deadChatTexts).toContain("我是亡者发言");
  });

  test("聊天按连接限流：窗内第 6 条被拒，窗口过去后恢复", async () => {
    const { service, advanceTime } = createTestContext();
    const { host } = await createRoom(service, "3434");

    for (let index = 0; index < CHAT_RATE_LIMIT_PER_CONNECTION; index += 1) {
      await execute(service, host, {
        id: `chat-${index}`,
        type: "chat.send",
        roomId: "3434",
        payload: { text: `第${index + 1}条` },
      });
    }

    await expect(
      execute(service, host, {
        id: "chat-over-limit",
        type: "chat.send",
        roomId: "3434",
        payload: { text: "超限" },
      })
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });

    advanceTime(CHAT_RATE_LIMIT_WINDOW_MS);
    await expect(
      execute(service, host, {
        id: "chat-recovered",
        type: "chat.send",
        roomId: "3434",
        payload: { text: "恢复" },
      })
    ).resolves.toEqual({ sent: true });
  });

  test("一间房巡检抛错时，其余房间照常被清理", async () => {
    // 记录器在关闭 1111 房时故障：该房的清理会抛错，巡检循环不能因此跳过后面的房间。
    const { service, advanceTime } = createTestContext({
      gameRecorder: {
        ...NOOP_GAME_RECORDER,
        finishRoom: (entry) => {
          if (entry.roomId === "1111") throw new Error("对局记录器故障");
        },
      },
    });
    const rooms = ["1111", "2222", "3333"];
    for (const roomId of rooms) {
      const { host } = await createRoom(service, roomId);
      await service.unregisterConnection(host.record.id);
    }

    // 第一轮巡检只记录空房起点，宽限期满后第二轮才真正关闭。
    await service.runHousekeeping();
    advanceTime(ROOM_EMPTY_GRACE_PERIOD_MS + 1_000);
    await service.runHousekeeping();

    const remaining = [...service.rooms.keys()];
    expect(remaining).toEqual(["1111"]);
  });

  test("被踢玩家只记一次移出，重复踢人与后续巡检都不再重复处理", async () => {
    let currentTime = Date.UTC(2026, 3, 10, 0, 0, 0);
    const entries: LogEntry[] = [];
    class RecordingLogger extends EventLogger {
      override async write(entry: LogEntry): Promise<void> {
        entries.push(entry);
        await super.write(entry);
      }
    }
    const service = new WhoIsFakerService({
      now: () => currentTime,
      testRooms: TEST_ROOMS_ON,
      eventLogger: new RecordingLogger(),
    });
    const { host } = await createRoom(service, "Oblivionis");
    const [player] = await joinPlayers(service, "Oblivionis", 1, "被踢者");
    await execute(service, host, { id: "bots", type: "test.addBot", payload: { count: 3 } });
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

    const kick = () =>
      execute(service, host, {
        id: "kick",
        type: "room.kick",
        payload: { playerId: player.joinResult.playerId },
      });
    const kickedCount = () => entries.filter((entry) => entry.type === "player.kicked").length;
    await kick();
    expect(kickedCount()).toBe(1);

    // 房主对已被踢者再踢一次：幂等，不再写第二条记录。
    await kick();
    expect(kickedCount()).toBe(1);

    // 被踢记录过了掉线保留期被巡检清掉时，也不再走一遍强制移除。
    currentTime += PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS + 1_000;
    await service.runHousekeeping();
    expect(kickedCount()).toBe(1);
    expect(service.rooms.get("Oblivionis")!.players[player.joinResult.playerId]).toBeUndefined();
  });
});
