import { describe, expect, test } from "bun:test";
import {
  PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS,
  QUESTIONER_RECONNECT_TIMEOUT_MS,
} from "../../src/config/Constants";
import type { SnapshottedRoom } from "../../src/shared/RoomSnapshot";
import {
  connect,
  createWorld,
  joinAs,
  makeRoom,
  send,
  startRound,
  subscribeLobby,
  type World,
} from "./FacadeKit";

const round = (world: World, id: string) => world.room(id).round!;

describe("巡检里的离线清理", () => {
  test("离线超时的玩家按「超时」强制移除、重算角色配置、刷新活跃并从名册删除", async () => {
    const world = createWorld();
    const started = await startRound(world, "9001");
    const victim = started.others[0];
    await world.service.unregisterConnection(victim.conn.record.id);
    world.advance(PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS + 1);
    await world.service.runHousekeeping();
    const room = world.room("9001");
    expect(room.players[victim.id]).toBeUndefined();
    expect(round(world, "9001").assignments[victim.id]?.eliminatedReason).toBe("timeout");
    expect(room.lastActivityAt).toBe(world.now());
  });

  test("结算阶段的离线玩家只清占位，不再强制移除", async () => {
    const world = createWorld();
    const started = await startRound(world, "9002");
    const victim = started.others[0];
    round(world, "9002").phase = "gameOver";
    const historyBefore = structuredClone(round(world, "9002").history);
    await world.service.unregisterConnection(victim.conn.record.id);
    world.advance(PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS + 1);
    await world.service.runHousekeeping();
    expect(world.room("9002").players[victim.id]).toBeUndefined();
    expect(round(world, "9002").assignments[victim.id]?.alive).toBe(true);
    expect(round(world, "9002").history).toEqual(historyBefore);
    expect(world.room("9002").lastActivityAt).toBe(world.now());
  });

  test("离线出题人超时：本局以中止收场，而不是普通强制移除", async () => {
    const world = createWorld();
    const started = await startRound(world, "9003");
    await world.service.unregisterConnection(started.questioner.conn.record.id);
    // 单独验证「席位清理」这条路径：去掉出题人重连截止，免得截止巡检先把本局中止
    round(world, "9003").questionerReconnectDeadlineAt = undefined;
    // 先越过出题人重连截止（一分钟）再越过席位保留时长：此处直接越过后者，验证清理分支
    world.advance(PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS + 1);
    await world.service.runHousekeeping();
    const r = round(world, "9003");
    expect(r.phase).toBe("gameOver");
    expect(r.summary?.winner).toBe("aborted");
    expect(r.summary?.reason).toBe("出题人掉线超时，本局已结束");
    expect(world.room("9003").players[started.questioner.id]).toBeUndefined();
  });

  test("掉线清理后按人数重算角色配置", async () => {
    const world = createWorld();
    const host = await makeRoom(world, "9004");
    const guests = [];
    for (let i = 0; i < 8; i += 1) guests.push(await joinAs(world, "9004", `玩家${i}`));
    await send(world, host.conn, {
      id: "u",
      type: "room.updateSettings",
      payload: { roleConfig: { undercoverCount: 2, hasAngel: true, hasBlank: false } },
    });
    expect(world.room("9004").settings.roleConfig.hasAngel).toBe(true);
    for (const guest of guests.slice(0, 5))
      await world.service.unregisterConnection(guest.conn.record.id);
    world.advance(PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS + 1);
    await world.service.runHousekeeping();
    expect(world.room("9004").settings.roleConfig).toMatchObject({
      undercoverCount: 1,
      hasAngel: false,
    });
  });
});

describe("巡检里的截止与计时", () => {
  test("出题人重连截止：未到点不动、到点（含正好等于）中止本局", async () => {
    const world = createWorld();
    const started = await startRound(world, "9101");
    await world.service.unregisterConnection(started.questioner.conn.record.id);
    const deadline = round(world, "9101").questionerReconnectDeadlineAt!;
    expect(deadline).toBe(world.now() + QUESTIONER_RECONNECT_TIMEOUT_MS);
    world.advance(QUESTIONER_RECONNECT_TIMEOUT_MS - 1);
    await world.service.runHousekeeping();
    expect(round(world, "9101").phase).toBe("description");
    world.advance(1);
    await world.service.runHousekeeping();
    expect(round(world, "9101").phase).toBe("gameOver");
    expect(round(world, "9101").summary?.winner).toBe("aborted");
    expect(round(world, "9101").summary?.reason).toBe("出题人掉线超时，本局已结束");
  });

  test("没有出题人截止时不会误中止本局", async () => {
    const world = createWorld();
    await startRound(world, "9102");
    world.advance(QUESTIONER_RECONNECT_TIMEOUT_MS * 2);
    await world.service.runHousekeeping();
    expect(round(world, "9102").phase).toBe("description");
  });

  test("阶段计时：到点前不处理，正好到点处理，超时按挂计时时的阶段与模式执行", async () => {
    const world = createWorld();
    const started = await startRound(world, "9103");
    await send(world, started.questioner.conn, {
      id: "t",
      type: "game.startPhaseTimer",
      payload: { durationSeconds: 60 },
    });
    world.advance(59_999);
    await world.service.runHousekeeping();
    expect(round(world, "9103").phase).toBe("description");
    world.advance(1);
    await world.service.runHousekeeping();
    expect(round(world, "9103").phase).not.toBe("description");
  });

  test("发言模式随计时带入：补充发言期间到点，按补充发言的超时处理", async () => {
    const world = createWorld();
    const started = await startRound(world, "9104");
    for (const seat of started.speakers) {
      await send(world, seat.conn, {
        id: `d${seat.id}`,
        type: "game.submitDescription",
        payload: { text: "话" },
      });
    }
    await send(world, started.questioner.conn, {
      id: "rs",
      type: "game.requestSupplement",
      payload: { playerIds: [started.speakers[0].id] },
    });
    await send(world, started.questioner.conn, {
      id: "t",
      type: "game.startPhaseTimer",
      payload: { durationSeconds: 60 },
    });
    expect(round(world, "9104").phaseTimer?.speechMode).toBe("supplement");
    world.advance(60_000);
    await world.service.runHousekeeping();
    const r = round(world, "9104");
    // 补充发言超时：被点名者以空发言补齐，补充请求收掉
    expect(r.supplement).toBeUndefined();
    expect(r.speechMode).not.toBe("supplement");
  });
});

describe("连接与离线", () => {
  test("旧连接在重连之后断开，不影响座位在线态", async () => {
    const world = createWorld();
    const host = await makeRoom(world, "9201");
    const guest = await joinAs(world, "9201", "乙");
    const fresh = connect(world, "fresh");
    await send(world, fresh, {
      id: "rc",
      type: "room.reconnect",
      payload: { roomId: "9201", sessionToken: guest.token },
    });
    await world.service.unregisterConnection(guest.conn.record.id);
    expect(world.room("9201").players[guest.id]?.online).toBe(true);
    expect(host.id).toBeTruthy();
  });
});

describe("快照与恢复", () => {
  test("导出：undefined 字段被剔除；无法序列化的房间被跳过并告警", async () => {
    const world = createWorld();
    await makeRoom(world, "9301");
    await makeRoom(world, "9302");
    world.room("9301").passwordHash = undefined;
    (world.room("9302") as unknown as { poison: bigint }).poison = 1n;
    const snapshots = world.service.exportSnapshots();
    expect(snapshots.map((s) => s.id)).toEqual(["9301"]);
    expect("passwordHash" in snapshots[0]).toBe(false);
    expect(world.warns).toContain("房间快照导出失败，已跳过该房间");
  });

  test("恢复：时间基准、开局时间、发号器、计时重挂、出题人截止与更新时间", async () => {
    const source = createWorld();
    const started = await startRound(source, "9303");
    await send(source, started.questioner.conn, {
      id: "t",
      type: "game.startPhaseTimer",
      payload: { durationSeconds: 60 },
    });
    await source.service.unregisterConnection(started.questioner.conn.record.id);
    const savedAt = source.now();
    const snapshots = source.service.exportSnapshots();
    const maxIdBefore = Object.keys(source.room("9303").players);

    const target = createWorld();
    target.advance(3 * 60_000);
    expect(target.service.restoreSnapshots(snapshots, savedAt)).toBe(1);
    const room = target.room("9303");
    expect(room.updatedAt).toBe(target.now());
    expect(target.service.ctx.roundStartedAtById.get(room.round!.id)).toBe(savedAt);
    expect(room.round!.questionerReconnectDeadlineAt).toBe(
      target.now() + QUESTIONER_RECONNECT_TIMEOUT_MS
    );
    // 倒计时按停机时长平移，并重新挂上（到点前不会立刻处理）
    expect(room.round!.phaseTimer!.endsAt).toBeGreaterThan(target.now());
    // 发号器越过已用序号：新入房的人不会与恢复出来的人撞号
    const guest = await joinAs(target, "9303", "新人");
    expect(maxIdBefore).not.toContain(guest.id);
    const ids = Object.keys(room.players);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("恢复：形状不对的房间静默跳过；处理中抛错的房间记告警并跳过", async () => {
    const source = createWorld();
    await makeRoom(source, "9304");
    const [ok] = source.service.exportSnapshots();
    const target = createWorld();
    const broken = { ...ok, id: "9305", players: { x: null } } as unknown as SnapshottedRoom;
    const shapeless = { id: "9306" } as unknown as SnapshottedRoom;
    expect(target.service.restoreSnapshots([shapeless], target.now())).toBe(0);
    expect(target.warns).toEqual([]);
    expect(target.service.restoreSnapshots([broken], target.now())).toBe(0);
    expect(target.warns).toContain("房间快照恢复失败，已跳过该房间");
  });
});

describe("后台与健康", () => {
  test("后台列表带阶段、可见性、回合数与测试房隐藏标记", async () => {
    const world = createWorld();
    await makeRoom(world, "9401", { visibility: "private", password: "p" });
    await makeRoom(world, "Oblivionis");
    const started = await startRound(world, "9402");
    expect(started.host.id).toBeTruthy();
    const views = world.service.adminListRooms();
    const byId = new Map(views.map((v) => [v.roomId, v]));
    expect(byId.get("9401")).toMatchObject({
      phase: "waiting",
      visibility: "private",
      roundNumber: 0,
      hidden: false,
    });
    expect(byId.get("Oblivionis")).toMatchObject({ hidden: true });
    expect(byId.get("9402")).toMatchObject({ phase: "description", visibility: "public" });
    world.room("9402").roundCount = 3;
    expect(world.service.adminListRooms().find((v) => v.roomId === "9402")?.roundNumber).toBe(3);
  });

  test("健康快照：房间数与连接数", async () => {
    const world = createWorld();
    await makeRoom(world, "9403");
    await subscribeLobby(world);
    const health = world.service.getHealthSnapshot();
    expect(health.roomCount).toBe(1);
    expect(health.connectionCount).toBe(2);
    expect(health.onlinePlayerCount).toBe(1);
  });
});
