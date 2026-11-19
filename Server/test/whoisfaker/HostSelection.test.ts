import { describe, expect, test } from "bun:test";
import { createRoom } from "./Fixtures";
import { HOST_RECONNECT_TIMEOUT_MS } from "../../src/config/Constants";
import { type WhoIsFakerRoomSnapshot } from "../../src/shared/Index";
import { createConnection, createTestContext, execute, getLastEventPayload } from ".././Helpers";

type Service = ReturnType<typeof createTestContext>["service"];

const join = async (service: Service, roomId: string, name: string) => {
  const connection = createConnection(service, `${roomId}-${name}`);
  const result = (await execute(service, connection, {
    id: `${roomId}-${name}-join`,
    type: "room.join",
    roomId,
    payload: { userName: name },
  })) as { playerId: string; sessionToken: string };
  return { connection, result };
};

const transfer = (service: Service, host: ReturnType<typeof createConnection>, playerId: string) =>
  execute(service, host, {
    id: `transfer-${playerId}`,
    type: "room.transferHost",
    payload: { playerId },
  });

describe("房主改选与转让", () => {
  test("手动转让的目标必须在线：离线成员被拒，房主不变", async () => {
    const { service } = createTestContext();
    const { host, result: hostResult } = await createRoom(service, "2701");
    const guest = await join(service, "2701", "离线者");
    await service.unregisterConnection(guest.connection.record.id);

    await expect(transfer(service, host, guest.result.playerId)).rejects.toMatchObject({
      code: "INVALID_TARGET",
    });
    expect(service.rooms.get("2701")!.hostPlayerId).toBe(hostResult.playerId);
  });

  test("手动转让的目标必须是真人：机器人被拒", async () => {
    const { service } = createTestContext();
    const { host, result: hostResult } = await createRoom(service, "Oblivionis");
    await execute(service, host, { id: "add-bot", type: "test.addBot", payload: { count: 1 } });
    const bot = Object.values(service.rooms.get("Oblivionis")!.players).find((p) => p.isBot)!;

    await expect(transfer(service, host, bot.id)).rejects.toMatchObject({ code: "INVALID_TARGET" });
    expect(service.rooms.get("Oblivionis")!.hostPlayerId).toBe(hostResult.playerId);
  });

  test("手动转让的目标必须是正式玩家：旁观者被拒", async () => {
    const { service } = createTestContext();
    const { host, result: hostResult } = await createRoom(service, "2702");
    const watcher = await join(service, "2702", "旁观者");
    await execute(service, watcher.connection, {
      id: "become-spectator",
      type: "player.setSpectator",
      payload: { spectator: true },
    });

    await expect(transfer(service, host, watcher.result.playerId)).rejects.toMatchObject({
      code: "INVALID_TARGET",
    });
    expect(service.rooms.get("2702")!.hostPlayerId).toBe(hostResult.playerId);
  });

  test("转让给在线正式玩家照常成功", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "2703");
    const guest = await join(service, "2703", "接任者");

    await transfer(service, host, guest.result.playerId);

    expect(service.rooms.get("2703")!.hostPlayerId).toBe(guest.result.playerId);
  });

  test("房主被移出且只剩离线成员时，房主空缺而不是交给离线者，其上线后当场接任", async () => {
    const { service } = createTestContext();
    const { result: hostResult } = await createRoom(service, "2704");
    const sleeper = await join(service, "2704", "离线者");
    await service.unregisterConnection(sleeper.connection.record.id);

    await service.adminKickPlayer("2704", hostResult.playerId);
    const room = service.rooms.get("2704")!;
    expect(room.hostPlayerId).toBe("");

    const back = createConnection(service, "2704-back");
    await execute(service, back, {
      id: "reconnect",
      type: "room.reconnect",
      payload: { roomId: "2704", sessionToken: sleeper.result.sessionToken },
    });
    expect(room.hostPlayerId).toBe(sleeper.result.playerId);
    expect(getLastEventPayload<WhoIsFakerRoomSnapshot>(back, "room.snapshot")?.hostPlayerId).toBe(
      sleeper.result.playerId
    );
  });

  test("巡检每跳都会补上空缺的房主", async () => {
    const { service } = createTestContext();
    const { result: hostResult } = await createRoom(service, "2705");
    await join(service, "2705", "在线者");
    const room = service.rooms.get("2705")!;
    // 房主空缺（待选）：没有人上线触发接任时，只能靠巡检补上。
    room.hostPlayerId = "";

    await service.runHousekeeping();

    expect(room.hostPlayerId).toBe(hostResult.playerId);
  });

  test("恢复快照后房主一律带完整重连宽限，第一个回来的人不能抢走房主", async () => {
    const before = createTestContext();
    const { result: hostResult } = await createRoom(before.service, "2706");
    const guest = await join(before.service, "2706", "同房玩家");
    const savedAt = Date.UTC(2026, 3, 10, 0, 0, 0);
    const snapshots = before.service.exportSnapshots();
    // 停机前房主在线，快照里没有重连截止时刻。
    expect(snapshots[0]?.hostReconnectDeadlineAt).toBeUndefined();

    const after = createTestContext();
    after.setTime(savedAt + 1000);
    after.service.restoreSnapshots(snapshots, savedAt);
    const room = after.service.rooms.get("2706")!;
    expect(room.hostReconnectDeadlineAt).toBe(savedAt + 1000 + HOST_RECONNECT_TIMEOUT_MS);

    const back = createConnection(after.service, "2706-guest-back");
    await execute(after.service, back, {
      id: "guest-reconnect",
      type: "room.reconnect",
      payload: { roomId: "2706", sessionToken: guest.result.sessionToken },
    });
    expect(room.hostPlayerId).toBe(hostResult.playerId);
  });
});
