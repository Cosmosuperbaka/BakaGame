import { expect, test } from "bun:test";

import type { RoomSnapshot } from "../src/domain/Model";
import {
  createConnection,
  createTestContext,
  execute,
  getLastEventPayload,
} from "./Helpers";

test("倒计时参数校验：仅允许 1、2、3 分钟（60s / 120s / 180s）", async () => {
  const context = createTestContext();
  const connHost = createConnection(context.service, "conn_host");

  await execute(context.service, connHost, {
    id: "msg_create",
    type: "room.create",
    payload: {
      roomId: "Oblivionis",
      name: "测试房间",
      visibility: "public",
      allowSpectators: true,
      userName: "房主",
    },
  });

  await execute(context.service, connHost, {
    id: "msg_add_bot_1",
    type: "test.addBot",
    payload: { count: 4 },
  });

  // 测试房跳转至描述阶段
  await execute(context.service, connHost, {
    id: "msg_jump",
    type: "test.jumpToPhase",
    payload: { phase: "description" },
  });

  // 尝试设置 30s（非法）
  await expect(
    execute(context.service, connHost, {
      id: "msg_timer_30",
      type: "game.startPhaseTimer",
      payload: { durationSeconds: 30 },
    }),
  ).rejects.toThrow("倒计时时长只能在1、2、3分钟之间选择");

  // 尝试设置 300s（非法）
  await expect(
    execute(context.service, connHost, {
      id: "msg_timer_300",
      type: "game.startPhaseTimer",
      payload: { durationSeconds: 300 },
    }),
  ).rejects.toThrow("倒计时时长只能在1、2、3分钟之间选择");

  // 设置 60s（合法）
  const res60 = await execute(context.service, connHost, {
    id: "msg_timer_60",
    type: "game.startPhaseTimer",
    payload: { durationSeconds: 60 },
  });
  expect((res60 as { phaseTimer: { durationSeconds: number } }).phaseTimer.durationSeconds).toBe(60);

  const snapshot = getLastEventPayload<RoomSnapshot>(connHost, "room.snapshot");
  expect(snapshot?.status.phaseTimer?.durationSeconds).toBe(60);
});

test("阶段约束与非对局阶段排除：assigningQuestioner、wordSubmission、waiting、gameOver 均不支持倒计时", async () => {
  const context = createTestContext();
  const connHost = createConnection(context.service, "conn_host");

  await execute(context.service, connHost, {
    id: "msg_create",
    type: "room.create",
    payload: {
      roomId: "Oblivionis",
      name: "测试房间",
      visibility: "public",
      allowSpectators: true,
      userName: "房主",
    },
  });

  // 1. waiting 阶段尝试设置倒计时（应被拒绝）
  await expect(
    execute(context.service, connHost, {
      id: "msg_timer_waiting",
      type: "game.startPhaseTimer",
      payload: { durationSeconds: 60 },
    }),
  ).rejects.toMatchObject({
    code: "ROUND_NOT_STARTED",
  });

  // 添加机器人并开局
  await execute(context.service, connHost, {
    id: "msg_add_bot",
    type: "test.addBot",
    payload: { count: 4 },
  });
  await execute(context.service, connHost, {
    id: "msg_host_ready",
    type: "player.setReady",
    payload: { ready: true },
  });
  await execute(context.service, connHost, {
    id: "msg_start",
    type: "game.advancePhase",
    payload: {},
  });

  let snapshot = getLastEventPayload<RoomSnapshot>(connHost, "room.snapshot")!;
  expect(snapshot.status.phase).toBe("assigningQuestioner");

  // 2. assigningQuestioner 阶段选择出题人不需要倒计时（应被拒绝）
  await expect(
    execute(context.service, connHost, {
      id: "msg_timer_assigning",
      type: "game.startPhaseTimer",
      payload: { durationSeconds: 60 },
    }),
  ).rejects.toThrow("当前阶段不支持设置倒计时");

  // 指定出题人进入 wordSubmission
  const hostPlayerId = snapshot.hostPlayerId;
  await execute(context.service, connHost, {
    id: "msg_assign",
    type: "game.assignQuestioner",
    payload: { playerId: hostPlayerId },
  });

  snapshot = getLastEventPayload<RoomSnapshot>(connHost, "room.snapshot")!;
  expect(snapshot.status.phase).toBe("wordSubmission");

  // 3. wordSubmission 阶段出题不需要倒计时（应被拒绝）
  await expect(
    execute(context.service, connHost, {
      id: "msg_timer_word_sub",
      type: "game.startPhaseTimer",
      payload: { durationSeconds: 60 },
    }),
  ).rejects.toThrow("当前阶段不支持设置倒计时");
});

test("权限校验：仅出题人（主持人）可设置与取消倒计时，普通玩家无权操作", async () => {
  const context = createTestContext();
  const connHost = createConnection(context.service, "conn_host");
  const connPlayer = createConnection(context.service, "conn_player");

  await execute(context.service, connHost, {
    id: "msg_create",
    type: "room.create",
    payload: {
      roomId: "1001",
      name: "普通房间",
      visibility: "public",
      allowSpectators: true,
      userName: "出题人房主",
    },
  });

  await execute(context.service, connPlayer, {
    id: "msg_join",
    type: "room.join",
    roomId: "1001",
    payload: { userName: "普通玩家" },
  });

  // 创建另外3个玩家凑齐5人
  const conn3 = createConnection(context.service, "conn_3");
  const conn4 = createConnection(context.service, "conn_4");
  const conn5 = createConnection(context.service, "conn_5");

  for (const [c, name] of [
    [conn3, "玩家3"],
    [conn4, "玩家4"],
    [conn5, "玩家5"],
  ] as const) {
    await execute(context.service, c, {
      id: `msg_join_${name}`,
      type: "room.join",
      roomId: "1001",
      payload: { userName: name },
    });
    await execute(context.service, c, {
      id: `msg_ready_${name}`,
      type: "player.setReady",
      payload: { ready: true },
    });
  }

  await execute(context.service, connPlayer, {
    id: "msg_ready_p2",
    type: "player.setReady",
    payload: { ready: true },
  });
  await execute(context.service, connHost, {
    id: "msg_host_ready",
    type: "player.setReady",
    payload: { ready: true },
  });

  await execute(context.service, connHost, {
    id: "msg_start",
    type: "game.advancePhase",
    payload: {},
  });

  const snapshot = getLastEventPayload<RoomSnapshot>(connHost, "room.snapshot")!;
  const hostId = snapshot.hostPlayerId;

  // 指定房主为出题人
  await execute(context.service, connHost, {
    id: "msg_assign",
    type: "game.assignQuestioner",
    payload: { playerId: hostId },
  });

  // 出题人提交词语，进入 description 阶段
  await execute(context.service, connHost, {
    id: "msg_words",
    type: "game.submitWords",
    payload: { words: ["苹果", "香蕉"] },
  });

  // 普通玩家尝试设置倒计时（应被拒绝）
  await expect(
    execute(context.service, connPlayer, {
      id: "msg_timer_player",
      type: "game.startPhaseTimer",
      payload: { durationSeconds: 60 },
    }),
  ).rejects.toThrow("只有出题人可以执行该操作");

  // 出题人设置倒计时
  await execute(context.service, connHost, {
    id: "msg_timer_host",
    type: "game.startPhaseTimer",
    payload: { durationSeconds: 120 },
  });

  let currentSnapshot = getLastEventPayload<RoomSnapshot>(connHost, "room.snapshot")!;
  expect(currentSnapshot.status.phaseTimer?.durationSeconds).toBe(120);

  // 普通玩家尝试取消倒计时（应被拒绝）
  await expect(
    execute(context.service, connPlayer, {
      id: "msg_timer_stop_player",
      type: "game.stopPhaseTimer",
      payload: {},
    }),
  ).rejects.toThrow("只有出题人可以执行该操作");

  // 出题人取消倒计时
  await execute(context.service, connHost, {
    id: "msg_timer_stop_host",
    type: "game.stopPhaseTimer",
    payload: {},
  });

  currentSnapshot = getLastEventPayload<RoomSnapshot>(connHost, "room.snapshot")!;
  expect(currentSnapshot.status.phaseTimer).toBeUndefined();
});

test("阶段自然推进时自动销毁倒计时，不会泄露到下一阶段", async () => {
  const context = createTestContext();
  const connHost = createConnection(context.service, "conn_host");

  await execute(context.service, connHost, {
    id: "msg_create",
    type: "room.create",
    payload: {
      roomId: "Oblivionis",
      name: "测试房间",
      visibility: "public",
      allowSpectators: true,
      userName: "房主",
    },
  });

  await execute(context.service, connHost, {
    id: "msg_add_bot",
    type: "test.addBot",
    payload: { count: 4 },
  });

  await execute(context.service, connHost, {
    id: "msg_host_ready",
    type: "player.setReady",
    payload: { ready: true },
  });

  await execute(context.service, connHost, {
    id: "msg_start",
    type: "game.advancePhase",
    payload: {},
  });

  let snapshot = getLastEventPayload<RoomSnapshot>(connHost, "room.snapshot")!;
  const hostId = snapshot.hostPlayerId;

  await execute(context.service, connHost, {
    id: "msg_assign",
    type: "game.assignQuestioner",
    payload: { playerId: hostId },
  });

  await execute(context.service, connHost, {
    id: "msg_words",
    type: "game.submitWords",
    payload: { words: ["苹果", "香蕉"] },
  });

  // 在描述阶段开启 3 分钟倒计时
  await execute(context.service, connHost, {
    id: "msg_timer_start",
    type: "game.startPhaseTimer",
    payload: { durationSeconds: 180 },
  });
  snapshot = getLastEventPayload<RoomSnapshot>(connHost, "room.snapshot")!;
  expect(snapshot.status.phaseTimer?.durationSeconds).toBe(180);

  // 手动推进到投票阶段
  await execute(context.service, connHost, {
    id: "msg_advance",
    type: "game.advancePhase",
    payload: {},
  });

  snapshot = getLastEventPayload<RoomSnapshot>(connHost, "room.snapshot")!;
  expect(snapshot.status.phase).toBe("voting");
  // 倒计时已在阶段转换时自动销毁
  expect(snapshot.status.phaseTimer).toBeUndefined();
});

test("描述阶段超时自动补齐发言并推进至投票阶段", async () => {
  const context = createTestContext();
  const connHost = createConnection(context.service, "conn_host");
  const connPlayer = createConnection(context.service, "conn_player");

  await execute(context.service, connHost, {
    id: "msg_create",
    type: "room.create",
    payload: {
      roomId: "Oblivionis",
      name: "测试房间",
      visibility: "public",
      allowSpectators: true,
      userName: "房主",
    },
  });

  await execute(context.service, connPlayer, {
    id: "msg_join",
    type: "room.join",
    roomId: "Oblivionis",
    payload: { userName: "玩家2" },
  });

  await execute(context.service, connHost, {
    id: "msg_add_bot",
    type: "test.addBot",
    payload: { count: 3 },
  });

  await execute(context.service, connPlayer, {
    id: "msg_ready",
    type: "player.setReady",
    payload: { ready: true },
  });

  await execute(context.service, connHost, {
    id: "msg_host_ready",
    type: "player.setReady",
    payload: { ready: true },
  });

  await execute(context.service, connHost, {
    id: "msg_start",
    type: "game.advancePhase",
    payload: {},
  });

  const snapshot = getLastEventPayload<RoomSnapshot>(connHost, "room.snapshot")!;
  const hostId = snapshot.hostPlayerId;

  // 房主出题
  await execute(context.service, connHost, {
    id: "msg_assign",
    type: "game.assignQuestioner",
    payload: { playerId: hostId },
  });

  await execute(context.service, connHost, {
    id: "msg_words",
    type: "game.submitWords",
    payload: { words: ["苹果", "香蕉"] },
  });

  let currentSnapshot = getLastEventPayload<RoomSnapshot>(connHost, "room.snapshot")!;
  expect(currentSnapshot.status.phase).toBe("description");

  // 出题人开启 1 分钟倒计时
  await execute(context.service, connHost, {
    id: "msg_timer",
    type: "game.startPhaseTimer",
    payload: { durationSeconds: 60 },
  });

  currentSnapshot = getLastEventPayload<RoomSnapshot>(connHost, "room.snapshot")!;
  expect(currentSnapshot.status.phaseTimer?.durationSeconds).toBe(60);

  // 玩家2尚未提交发言，时间前进61秒触发超时
  context.advanceTime(61000);
  await context.service.runHousekeeping();

  currentSnapshot = getLastEventPayload<RoomSnapshot>(connHost, "room.snapshot")!;
  // 描述阶段应自动补齐“（超时未发言）”并推进到投票阶段
  expect(currentSnapshot.status.phase).toBe("voting");
  expect(currentSnapshot.status.phaseTimer).toBeUndefined();
  expect(currentSnapshot.descriptions.some((d) => d.text === "（超时未发言）")).toBe(true);
});

test("投票阶段超时自动为未投票玩家提交弃票并结算", async () => {
  const context = createTestContext();
  const connHost = createConnection(context.service, "conn_host");

  await execute(context.service, connHost, {
    id: "msg_create",
    type: "room.create",
    payload: {
      roomId: "Oblivionis",
      name: "测试房间",
      visibility: "public",
      allowSpectators: true,
      userName: "房主",
    },
  });

  await execute(context.service, connHost, {
    id: "msg_add_bot",
    type: "test.addBot",
    payload: { count: 4 },
  });

  // 测试房直接跳转至投票阶段
  await execute(context.service, connHost, {
    id: "msg_jump",
    type: "test.jumpToPhase",
    payload: { phase: "voting" },
  });

  let snapshot = getLastEventPayload<RoomSnapshot>(connHost, "room.snapshot")!;
  expect(snapshot.status.phase).toBe("voting");

  // 开启 1 分钟倒计时
  await execute(context.service, connHost, {
    id: "msg_timer",
    type: "game.startPhaseTimer",
    payload: { durationSeconds: 60 },
  });

  // 推进 61 秒触发超时
  context.advanceTime(61000);
  await context.service.runHousekeeping();

  snapshot = getLastEventPayload<RoomSnapshot>(connHost, "room.snapshot")!;
  // 全员弃票后无人出局，进入夜晚阶段
  expect(snapshot.status.phase).toBe("night");
  expect(snapshot.status.phaseTimer).toBeUndefined();
});

test("夜晚阶段超时自动放弃行动并推进结算", async () => {
  const context = createTestContext();
  const connHost = createConnection(context.service, "conn_host");

  await execute(context.service, connHost, {
    id: "msg_create",
    type: "room.create",
    payload: {
      roomId: "Oblivionis",
      name: "测试房间",
      visibility: "public",
      allowSpectators: true,
      userName: "房主",
    },
  });

  await execute(context.service, connHost, {
    id: "msg_add_bot",
    type: "test.addBot",
    payload: { count: 4 },
  });

  await execute(context.service, connHost, {
    id: "msg_jump_night",
    type: "test.jumpToPhase",
    payload: { phase: "night" },
  });

  let snapshot = getLastEventPayload<RoomSnapshot>(connHost, "room.snapshot")!;
  expect(snapshot.status.phase).toBe("night");

  // 开启倒计时
  await execute(context.service, connHost, {
    id: "msg_timer",
    type: "game.startPhaseTimer",
    payload: { durationSeconds: 60 },
  });

  context.advanceTime(61000);
  await context.service.runHousekeeping();

  snapshot = getLastEventPayload<RoomSnapshot>(connHost, "room.snapshot")!;
  // 夜晚超时自动放弃行动并天亮进入描述阶段
  expect(snapshot.status.phase).toBe("description");
  expect(snapshot.status.phaseTimer).toBeUndefined();
});
