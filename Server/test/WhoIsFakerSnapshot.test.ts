import { describe, expect, test } from "bun:test";

import {
  HOST_RECONNECT_TIMEOUT_MS,
  QUESTIONER_RECONNECT_TIMEOUT_MS,
} from "../src/config/Constants";
import type { SnapshottedRoom } from "../src/shared/RoomSnapshot";
import { createConnection, createTestContext, execute } from "./Helpers";

const ROOM_ID = "1234";

const createRoom = async (
  service: ReturnType<typeof createTestContext>["service"],
  roomId = ROOM_ID
) => {
  const host = createConnection(service, `${roomId}-host`);
  const result = (await execute(service, host, {
    id: `${roomId}-create`,
    type: "room.create",
    payload: {
      roomId,
      name: `${roomId}-房间`,
      visibility: "public",
      allowSpectators: true,
      userName: "房主",
    },
  })) as { roomId: string; playerId: string; sessionToken: string };
  return { host, result };
};

const join = async (
  service: ReturnType<typeof createTestContext>["service"],
  roomId: string,
  name: string
) => {
  const connection = createConnection(service, `${roomId}-${name}`);
  const result = (await execute(service, connection, {
    id: `${roomId}-join-${name}`,
    type: "room.join",
    roomId,
    payload: { userName: name },
  })) as { playerId: string };
  return { connection, playerId: result.playerId };
};

const roomOf = (rooms: readonly SnapshottedRoom[], index = 0): Record<string, unknown> =>
  rooms[index] as unknown as Record<string, unknown>;

const playersOf = (room: Record<string, unknown>): Record<string, Record<string, unknown>> =>
  room.players as Record<string, Record<string, unknown>>;

describe("WhoIsFaker 房间快照", () => {
  test("导出的对象与线上房间脱钩，且能被新进程恢复", async () => {
    const ctx = createTestContext();
    const { result } = await createRoom(ctx.service);
    await join(ctx.service, ROOM_ID, "玩家二");

    const snapshots = ctx.service.exportSnapshots();
    expect(snapshots).toHaveLength(1);
    expect(Object.keys(playersOf(roomOf(snapshots)))).toHaveLength(2);

    // 导出的是副本：改动快照不能反过来影响线上房间。
    playersOf(roomOf(snapshots))[result.playerId].name = "被改了";
    const again = ctx.service.exportSnapshots();
    expect(playersOf(roomOf(again))[result.playerId].name).toBe("房主");

    const restarted = createTestContext();
    restarted.setTime(Date.UTC(2026, 3, 10, 0, 0, 30));
    expect(restarted.service.restoreSnapshots(snapshots, Date.UTC(2026, 3, 10, 0, 0, 0))).toBe(1);
    expect(restarted.service.getHealthSnapshot().roomCount).toBe(1);
  });

  test("恢复后所有座位离线且连接句柄清空", async () => {
    const ctx = createTestContext();
    await createRoom(ctx.service);
    await join(ctx.service, ROOM_ID, "玩家二");

    const savedAt = Date.UTC(2026, 3, 10, 0, 0, 0);
    const restarted = createTestContext();
    restarted.setTime(savedAt + 20_000);
    restarted.service.restoreSnapshots(ctx.service.exportSnapshots(), savedAt);

    const room = roomOf(restarted.service.exportSnapshots());
    for (const player of Object.values(playersOf(room))) {
      expect(player.online).toBe(false);
      expect(player.connectionId).toBeUndefined();
    }
    expect(restarted.service.getHealthSnapshot().onlinePlayerCount).toBe(0);
  });

  test("停机时长不动倒计时：endsAt 按暂停时长整体后移", async () => {
    const ctx = createTestContext();
    await createRoom(ctx.service);
    const savedAt = Date.UTC(2026, 3, 10, 0, 0, 0);
    const snapshots = ctx.service.exportSnapshots();
    const room = roomOf(snapshots);
    // 停机 5 分钟，且原定截止时刻已在停机期间过去。
    const originalEndsAt = savedAt + 120_000;
    room.round = {
      id: "round_1",
      phase: "voting",
      day: 1,
      assignments: {},
      descriptionCycle: 0,
      descriptionOrder: [],
      tieBreakCount: 0,
      descriptions: [],
      descriptionSubmittedBy: [],
      phaseTimer: { durationSeconds: 120, endsAt: originalEndsAt, phase: "voting" },
    };

    const paused = 300_000;
    const restarted = createTestContext();
    restarted.setTime(savedAt + paused);
    restarted.service.restoreSnapshots(snapshots, savedAt);

    const restoredRoom = roomOf(restarted.service.exportSnapshots());
    const timer = (restoredRoom.round as Record<string, unknown>).phaseTimer as {
      endsAt: number;
    };
    expect(timer.endsAt).toBe(originalEndsAt + paused);
  });

  test("停机不算玩家掉线：lastSeenAt 与重连截止时刻都从恢复时刻重新计", async () => {
    const ctx = createTestContext();
    const { result } = await createRoom(ctx.service);
    const savedAt = Date.UTC(2026, 3, 10, 0, 0, 0);
    const snapshots = ctx.service.exportSnapshots();
    const room = roomOf(snapshots);
    room.hostReconnectDeadlineAt = savedAt - 1;
    room.round = {
      id: "round_1",
      phase: "voting",
      day: 1,
      assignments: {},
      descriptionCycle: 0,
      descriptionOrder: [],
      tieBreakCount: 0,
      descriptions: [],
      descriptionSubmittedBy: [],
      questionerReconnectDeadlineAt: savedAt - 1,
    };

    // 停机 5 分钟，已经超过掉线清理阈值（3 分钟）。
    const resumedAt = savedAt + 300_000;
    const restarted = createTestContext();
    restarted.setTime(resumedAt);
    restarted.service.restoreSnapshots(snapshots, savedAt);

    const restoredRoom = roomOf(restarted.service.exportSnapshots());
    expect(playersOf(restoredRoom)[result.playerId].lastSeenAt).toBe(resumedAt);
    expect(restoredRoom.lastActivityAt).toBe(resumedAt);
    expect(restoredRoom.hostReconnectDeadlineAt).toBe(resumedAt + HOST_RECONNECT_TIMEOUT_MS);
    const round = restoredRoom.round as Record<string, unknown>;
    expect(round.questionerReconnectDeadlineAt).toBe(resumedAt + QUESTIONER_RECONNECT_TIMEOUT_MS);
  });

  test("停机不计入空房宽限：emptySinceAt 被清空", async () => {
    const ctx = createTestContext();
    await createRoom(ctx.service);
    const savedAt = Date.UTC(2026, 3, 10, 0, 0, 0);
    const snapshots = ctx.service.exportSnapshots();
    roomOf(snapshots).emptySinceAt = savedAt - 100_000;

    const restarted = createTestContext();
    restarted.setTime(savedAt + 20_000);
    restarted.service.restoreSnapshots(snapshots, savedAt);
    expect(roomOf(restarted.service.exportSnapshots()).emptySinceAt).toBeUndefined();

    // 行为兜底：巡检不该把它当成「已经空了 100 秒」而销毁。
    await restarted.service.runHousekeeping();
    expect(restarted.service.getHealthSnapshot().roomCount).toBe(1);
  });

  test("恢复后新建座位不与已有 id 冲突", async () => {
    const ctx = createTestContext();
    const { result } = await createRoom(ctx.service);
    await join(ctx.service, ROOM_ID, "玩家二");
    const savedAt = Date.UTC(2026, 3, 10, 0, 0, 0);

    const restarted = createTestContext();
    restarted.setTime(savedAt + 20_000);
    restarted.service.restoreSnapshots(ctx.service.exportSnapshots(), savedAt);

    const late = await join(restarted.service, ROOM_ID, "玩家三");
    expect(late.playerId).not.toBe(result.playerId);
    expect(roomOf(restarted.service.exportSnapshots()).players).toHaveProperty(late.playerId);
  });

  test("形状不合法的快照整间丢弃，不抛错", async () => {
    const restarted = createTestContext();
    const savedAt = Date.UTC(2026, 3, 10, 0, 0, 0);
    restarted.setTime(savedAt);
    const restored = restarted.service.restoreSnapshots(
      [{ id: "" }, {} as SnapshottedRoom, { id: ROOM_ID } as SnapshottedRoom],
      savedAt
    );
    expect(restored).toBe(0);
    expect(restarted.service.getHealthSnapshot().roomCount).toBe(0);
  });
});
