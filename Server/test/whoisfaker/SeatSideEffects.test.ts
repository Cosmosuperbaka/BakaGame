import { describe, expect, test } from "bun:test";
import { createRoom, joinPlayers } from "./Fixtures";
import {
  HOST_RECONNECT_TIMEOUT_MS,
  PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS,
} from "../../src/config/Constants";
import { WhoIsFakerService } from "../../src/application/WhoIsFakerService";
import { EventLogger } from "../../src/infrastructure/EventLogger";
import { type WhoIsFakerRoomSnapshot } from "../../src/shared/Index";
import {
  createConnection,
  createTestContext,
  execute,
  getEventPayloads,
  getLastEventPayload,
} from ".././Helpers";

type Ctx = ReturnType<typeof createTestContext>;

const startRound = async (service: Ctx["service"], roomId: string) => {
  const { host, result } = await createRoom(service, roomId);
  const others = await joinPlayers(service, roomId, 4, "玩家");
  for (const other of others) {
    await execute(service, other.connection, {
      id: `ready-${other.joinResult.playerId}`,
      type: "player.setReady",
      payload: { ready: true },
    });
  }
  await execute(service, host, { id: "start", type: "game.advancePhase", payload: {} });
  return { host, hostId: result.playerId, others };
};

describe("内核接入后玩法侧补做的副作用", () => {
  test("私密房算摘要失败：不留房间，房号占用被释放，可以重新建", async () => {
    let failNext = true;
    const service = new WhoIsFakerService({
      eventLogger: new EventLogger(),
      passwordHasher: {
        hash: async (password) => {
          if (failNext) throw new Error("hash failed");
          return `digest:${password}`;
        },
        verify: async (password, digest) => digest === `digest:${password}`,
      },
    });
    const payload = {
      roomId: "2801",
      name: "私房",
      visibility: "private" as const,
      password: "secret",
      allowSpectators: true,
      userName: "房主",
    };
    const first = createConnection(service, "2801-a");
    await expect(
      execute(service, first, { id: "create-1", type: "room.create", payload })
    ).rejects.toThrow("hash failed");
    expect(service.rooms.has("2801")).toBe(false);

    failNext = false;
    const second = createConnection(service, "2801-b");
    await execute(service, second, { id: "create-2", type: "room.create", payload });
    expect(service.rooms.has("2801")).toBe(true);
  });

  test("最后一人掉线：普通房开始空房计时，测试房不计时", async () => {
    const { service } = createTestContext();
    const normal = await createRoom(service, "2802");
    const testRoom = await createRoom(service, "Oblivionis");

    await service.unregisterConnection(normal.host.record.id);
    await service.unregisterConnection(testRoom.host.record.id);

    expect(service.rooms.get("2802")!.emptySinceAt).toBeDefined();
    expect(service.rooms.get("Oblivionis")!.emptySinceAt).toBeUndefined();
  });

  test("房主局外显式离开：房主当场交给在线玩家，截止时刻清空", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "2803");
    const [guest] = await joinPlayers(service, "2803", 1, "接任");

    await execute(service, host, { id: "leave", type: "room.leave", payload: {} });

    const room = service.rooms.get("2803")!;
    expect(room.hostPlayerId).toBe(guest.joinResult.playerId);
    expect(room.hostReconnectDeadlineAt).toBeUndefined();
  });

  test("房主局内显式离开：房主当场交给在线玩家，期间没有快照把离开者当房主发出去", async () => {
    const { service } = createTestContext();
    const { host, hostId, others } = await startRound(service, "2804");
    const watcher = others[0].connection;
    const before = getEventPayloads<WhoIsFakerRoomSnapshot>(watcher, "room.snapshot").length;

    await execute(service, host, { id: "leave", type: "room.leave", payload: {} });

    const room = service.rooms.get("2804")!;
    expect(room.hostPlayerId).not.toBe(hostId);
    expect(room.hostPlayerId).not.toBe("");
    expect(room.players[room.hostPlayerId]?.online).toBe(true);
    const during = getEventPayloads<WhoIsFakerRoomSnapshot>(watcher, "room.snapshot").slice(before);
    expect(during.some((snapshot) => snapshot.hostPlayerId === hostId)).toBe(false);
  });

  test("房主兼出题人局内显式离开：本局中止，房主当场交给在线玩家", async () => {
    const { service } = createTestContext();
    const { host, hostId } = await startRound(service, "2809");
    await execute(service, host, {
      id: "assign-self",
      type: "game.assignQuestioner",
      payload: { playerId: hostId },
    });

    await execute(service, host, { id: "leave", type: "room.leave", payload: {} });

    const room = service.rooms.get("2809")!;
    expect(room.round?.phase).toBe("gameOver");
    expect(room.hostPlayerId).not.toBe("");
    expect(room.players[room.hostPlayerId]?.online).toBe(true);
  });

  test("标签页交给 Agent：所在房间没开 MCP 就拒绝，开了就放行", async () => {
    const { service } = createTestContext();
    const host = createConnection(service, "2810-host");
    host.record.tabKey = "tab-2810";
    await execute(service, host, {
      id: "create",
      type: "room.create",
      payload: {
        roomId: "2810",
        name: "房间",
        visibility: "public",
        allowSpectators: true,
        userName: "房主",
      },
    });

    expect(() => service.assertTabAgentsAllowed("tab-2810")).toThrow("本房间未开启 MCP 接入");

    await execute(service, host, {
      id: "allow-agents",
      type: "room.updateSettings",
      payload: { allowAgents: true },
    });
    expect(() => service.assertTabAgentsAllowed("tab-2810")).not.toThrow();
  });

  test("接管开始或结束：标签页所在房间重新发布，同房玩家立刻看到变化", async () => {
    const { service } = createTestContext();
    const host = createConnection(service, "2811-host");
    host.record.tabKey = "tab-2811";
    await execute(service, host, {
      id: "create",
      type: "room.create",
      payload: {
        roomId: "2811",
        name: "房间",
        visibility: "public",
        allowSpectators: true,
        userName: "房主",
      },
    });
    const before = getEventPayloads(host, "room.snapshot").length;

    service.publishTabRooms("tab-2811");

    expect(getEventPayloads(host, "room.snapshot").length).toBeGreaterThan(before);
  });

  test("房主被后台移出：房主当场交给在线玩家", async () => {
    const { service } = createTestContext();
    const { result } = await createRoom(service, "2805");
    const [guest] = await joinPlayers(service, "2805", 1, "接任");

    await service.adminKickPlayer("2805", result.playerId);

    expect(service.rooms.get("2805")!.hostPlayerId).toBe(guest.joinResult.playerId);
  });

  test("房主离线超过清理时限：同一次巡检里清出名册并改选，公告房主变更", async () => {
    const { service, advanceTime } = createTestContext();
    const { host } = await createRoom(service, "2806");
    const [guest] = await joinPlayers(service, "2806", 1, "在线者");
    await service.unregisterConnection(host.record.id);
    advanceTime(PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS);

    await service.runHousekeeping();

    const room = service.rooms.get("2806")!;
    expect(room.hostPlayerId).toBe(guest.joinResult.playerId);
    expect(room.chat.some((message) => message.text.includes("房主已转移给"))).toBe(true);
  });

  test("房主宽限到期改选：活动时刻、公告、日志、房间快照与大厅发布一样不少", async () => {
    const { service, advanceTime } = createTestContext();
    const { host, result } = await createRoom(service, "2807");
    const [guest] = await joinPlayers(service, "2807", 1, "接任");
    const logged: Array<{ type: string; payload?: unknown }> = [];
    const originalLog = service.ctx.log.bind(service.ctx);
    service.ctx.log = async (entry) => {
      logged.push(entry);
      await originalLog(entry);
    };
    let lobbyRequests = 0;
    const originalRequest = service.ctx.lobbyFanout.request.bind(service.ctx.lobbyFanout);
    service.ctx.lobbyFanout.request = () => {
      lobbyRequests += 1;
      originalRequest();
    };

    await service.unregisterConnection(host.record.id);
    advanceTime(HOST_RECONNECT_TIMEOUT_MS);
    const snapshotsBefore = getEventPayloads(guest.connection, "room.snapshot").length;
    const lobbyBefore = lobbyRequests;
    await service.runHousekeeping();

    const room = service.rooms.get("2807")!;
    expect(room.lastActivityAt).toBe(service.ctx.now());
    expect(room.chat.some((message) => message.text === "房主 断线超时，房主已转移给 接任1")).toBe(
      true
    );
    const entry = logged.find((item) => item.type === "room.host_transferred");
    expect(entry?.payload).toMatchObject({
      previousHostId: result.playerId,
      nextHostId: guest.joinResult.playerId,
      reason: "disconnect_timeout",
    });
    expect(getEventPayloads(guest.connection, "room.snapshot").length).toBeGreaterThan(
      snapshotsBefore
    );
    expect(lobbyRequests).toBeGreaterThan(lobbyBefore);
  });

  test("房主本人在宽限内重连：重连截止时刻当场清空", async () => {
    const { service, advanceTime } = createTestContext();
    const { host, result } = await createRoom(service, "2808");
    await joinPlayers(service, "2808", 1, "旁人");
    await service.unregisterConnection(host.record.id);
    expect(service.rooms.get("2808")!.hostReconnectDeadlineAt).toBeDefined();
    advanceTime(1000);

    const back = createConnection(service, "2808-back");
    await execute(service, back, {
      id: "reconnect",
      type: "room.reconnect",
      payload: { roomId: "2808", sessionToken: result.sessionToken },
    });

    const room = service.rooms.get("2808")!;
    expect(room.hostPlayerId).toBe(result.playerId);
    expect(room.hostReconnectDeadlineAt).toBeUndefined();
    expect(getLastEventPayload<WhoIsFakerRoomSnapshot>(back, "room.snapshot")?.hostPlayerId).toBe(
      result.playerId
    );
  });
});
