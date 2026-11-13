import { describe, expect, test } from "bun:test";

import {
  ROOM_EMPTY_GRACE_PERIOD_MS,
  ROOM_EXPIRING_WARNING_MS,
  ROOM_IDLE_TIMEOUT_MS,
  SPECTATOR_OFFLINE_GRACE_MS,
} from "../../src/config/Constants";
import { WhoIsFakerService } from "../../src/application/WhoIsFakerService";
import { NOOP_GAME_RECORDER } from "../../src/domain/GameRecord";
import { EventLogger, type LogEntry } from "../../src/infrastructure/EventLogger";
import { TEST_ROOMS_ON } from "../TestRoomPolicy";
import { createTestContext, execute, getEventPayloads, getLastEventPayload } from "../Helpers";
import { createRoom, joinPlayers } from "./Fixtures";

type Packet = { event?: string };

describe("闲置预警与回收", () => {
  const chat = (
    service: ReturnType<typeof createTestContext>["service"],
    host: Awaited<ReturnType<typeof createRoom>>["host"],
    text: string
  ) => execute(service, host, { id: `chat-${text}`, type: "chat.send", payload: { text } });

  test("闲置关房前按提前量预警一次，同一段闲置不重复；有新活动后下一段闲置重新预警", async () => {
    const { service, advanceTime } = createTestContext();
    const { host } = await createRoom(service, "5001");
    const warnings = () => getEventPayloads(host, "room.expiring");

    advanceTime(ROOM_IDLE_TIMEOUT_MS - ROOM_EXPIRING_WARNING_MS - 1);
    await service.runHousekeeping();
    expect(warnings()).toHaveLength(0);

    advanceTime(1);
    await service.runHousekeeping();
    expect(warnings()).toEqual([{ roomId: "5001", reason: "idle_timeout" }]);

    // 同一段闲置里再巡检不重复预警，房间也还没关。
    advanceTime(1_000);
    await service.runHousekeeping();
    expect(warnings()).toHaveLength(1);
    expect(service.rooms.has("5001")).toBe(true);

    // 有人说话 = 新的活动：旧的预警作废，下一段闲置会重新预警。
    await chat(service, host, "我还在");
    advanceTime(ROOM_IDLE_TIMEOUT_MS - ROOM_EXPIRING_WARNING_MS);
    await service.runHousekeeping();
    expect(warnings()).toHaveLength(2);
    expect(service.rooms.has("5001")).toBe(true);

    advanceTime(ROOM_EXPIRING_WARNING_MS);
    await service.runHousekeeping();
    expect(getLastEventPayload(host, "room.closed")).toEqual({
      roomId: "5001",
      reason: "idle_timeout",
    });
    expect(warnings()).toHaveLength(2);
  });

  test("两次巡检之间直接越过闲置超时：同一轮先发预警再按闲置关房", async () => {
    const { service, advanceTime } = createTestContext();
    const { host } = await createRoom(service, "5002");

    advanceTime(ROOM_IDLE_TIMEOUT_MS + 1);
    await service.runHousekeeping();

    const events = (host.sent as Packet[])
      .map((item) => item.event)
      .filter((event) => event === "room.expiring" || event === "room.closed");
    expect(events).toEqual(["room.expiring", "room.closed"]);
    expect(service.rooms.has("5002")).toBe(false);
  });

  test("空房宽限期内只决定要不要关房，不暂停巡检的其余步骤", async () => {
    const { service, advanceTime } = createTestContext();
    const { host } = await createRoom(service, "5003");
    const [spectator] = await joinPlayers(service, "5003", 1, "旁观者");
    await execute(service, spectator.connection, {
      id: "watch",
      type: "player.setSpectator",
      payload: { spectator: true },
    });
    await service.unregisterConnection(spectator.connection.record.id);
    await service.unregisterConnection(host.record.id);

    // 全员离线但仍在空房宽限内：房间留着，同时 0 分旁观者的短保留照常到期清理。
    advanceTime(SPECTATOR_OFFLINE_GRACE_MS);
    expect(SPECTATOR_OFFLINE_GRACE_MS).toBeLessThan(ROOM_EMPTY_GRACE_PERIOD_MS);
    await service.runHousekeeping();

    const room = service.rooms.get("5003");
    expect(room).toBeDefined();
    expect(room?.players[spectator.joinResult.playerId]).toBeUndefined();
  });

  test("空房关房与闲置关房的原因不同：空房记 empty，闲置记 idle_timeout", async () => {
    // 空房没有任何连接可通知，关闭原因只留在日志里。
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
    const { host } = await createRoom(service, "5004");
    await createRoom(service, "5005");
    await service.unregisterConnection(host.record.id);

    now += ROOM_EMPTY_GRACE_PERIOD_MS + 1;
    await service.runHousekeeping();
    expect(service.rooms.has("5004")).toBe(false);

    now += ROOM_IDLE_TIMEOUT_MS;
    await service.runHousekeeping();
    expect(service.rooms.has("5005")).toBe(false);

    const closed = entries
      .filter((entry) => entry.type === "room.closed")
      .map((entry) => [entry.roomId, (entry.payload as { reason: string }).reason]);
    expect(closed).toEqual([
      ["5004", "empty"],
      ["5005", "idle_timeout"],
    ]);
  });

  test("一间房巡检抛错：记一条带房号的错误日志，不影响其余房间", async () => {
    const errors: Array<[string, unknown]> = [];
    class RecordingLogger extends EventLogger {
      override error(message: string, context?: Record<string, unknown>) {
        errors.push([message, context?.roomId]);
        super.error(message, context);
      }
    }
    let now = Date.UTC(2026, 3, 10);
    const service = new WhoIsFakerService({
      now: () => now,
      testRooms: TEST_ROOMS_ON,
      eventLogger: new RecordingLogger(),
      gameRecorder: {
        ...NOOP_GAME_RECORDER,
        finishRoom: (entry) => {
          if (entry.roomId === "5006") throw new Error("对局记录器故障");
        },
      },
    });
    for (const roomId of ["5006", "5007"]) {
      const { host } = await createRoom(service, roomId);
      await service.unregisterConnection(host.record.id);
    }
    await service.runHousekeeping();
    now += ROOM_EMPTY_GRACE_PERIOD_MS + 1;
    await service.runHousekeeping();

    expect(errors).toEqual([["房间巡检失败", "5006"]]);
    expect([...service.rooms.keys()]).toEqual(["5006"]);
  });
});
