import { describe, expect, test } from "bun:test";
import { createRoom } from "./Fixtures";
import { HOST_RECONNECT_TIMEOUT_MS } from "../../src/config/Constants";
import { type WhoIsFakerRoomSnapshot } from "../../src/shared/Index";
import { createConnection, createTestContext, execute, getLastEventPayload } from ".././Helpers";

const join = async (
  service: ReturnType<typeof createTestContext>["service"],
  roomId: string,
  name: string
) => {
  const connection = createConnection(service, `${roomId}-${name}`);
  const result = (await execute(service, connection, {
    id: `${roomId}-${name}-join`,
    type: "room.join",
    roomId,
    payload: { userName: name },
  })) as { playerId: string; sessionToken: string };
  return { connection, result };
};

const hostOf = (connection: ReturnType<typeof createConnection>) =>
  getLastEventPayload<WhoIsFakerRoomSnapshot>(connection, "room.snapshot")?.hostPlayerId;

describe("座位绑定时的房主接任", () => {
  test("房主宽限已过而巡检还没到时，新加入的正式玩家当场接任并公告", async () => {
    const { service, advanceTime } = createTestContext();
    const { host } = await createRoom(service, "2601");
    await service.unregisterConnection(host.record.id);
    advanceTime(HOST_RECONNECT_TIMEOUT_MS);

    const { connection, result } = await join(service, "2601", "后来者");

    expect(hostOf(connection)).toBe(result.playerId);
    const room = service.rooms.get("2601")!;
    expect(room.hostReconnectDeadlineAt).toBeUndefined();
    expect(room.chat.some((message) => message.text.includes("房主已转移给 后来者"))).toBe(true);
  });

  test("房主宽限还没过时，新加入的人不会抢走房主", async () => {
    const { service, advanceTime } = createTestContext();
    const { host, result: hostResult } = await createRoom(service, "2602");
    await service.unregisterConnection(host.record.id);
    advanceTime(HOST_RECONNECT_TIMEOUT_MS - 1);

    const { connection } = await join(service, "2602", "后来者");

    expect(hostOf(connection)).toBe(hostResult.playerId);
  });

  test("回来的是旁观者而在线正式玩家还在时，房主交给正式玩家", async () => {
    const { service, advanceTime } = createTestContext();
    const { host } = await createRoom(service, "2603");
    const active = await join(service, "2603", "正式玩家");
    const watcher = await join(service, "2603", "旁观者");
    await execute(service, watcher.connection, {
      id: "become-spectator",
      type: "player.setSpectator",
      payload: { spectator: true },
    });
    await service.unregisterConnection(watcher.connection.record.id);
    await service.unregisterConnection(host.record.id);
    advanceTime(HOST_RECONNECT_TIMEOUT_MS);

    const back = createConnection(service, "2603-watcher-back");
    await execute(service, back, {
      id: "watcher-reconnect",
      type: "room.reconnect",
      payload: { roomId: "2603", sessionToken: watcher.result.sessionToken },
    });

    expect(hostOf(back)).toBe(active.result.playerId);
  });
});
