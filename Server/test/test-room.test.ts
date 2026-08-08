import { expect, test } from "bun:test";

import type { PrivateState, RoomSnapshot } from "../src/domain/model";
import { ROOM_ID_TEST_MODE } from "../src/domain/model";
import { createConnection, createTestContext, execute, getLastEventPayload } from "./helpers";

// ==================== 测试房间与真实规则一致性 ====================
//
// 这组用例锁住「测试房间必须与普通房间同规则」这条约束：
// 曾经测试房间是纯客户端 mock，可以投自己、卧底数算错、
// 身份预测跨局继承、白板猜中后游戏不结束。

/** 建测试房间，并按需补入机器人，返回房主连接。 */
const createTestRoom = async (
  service: ReturnType<typeof createTestContext>["service"],
  botCount: number,
) => {
  const host = createConnection(service, "test-host");
  const result = (await execute(service, host, {
    id: "create",
    type: "room.create",
    payload: {
      roomId: ROOM_ID_TEST_MODE,
      name: "本地房间",
      visibility: "public",
      allowSpectators: true,
      userName: "玩家",
    },
  })) as { playerId: string };

  if (botCount > 0) {
    await execute(service, host, {
      id: "add-bots",
      type: "test.addBot",
      payload: { count: botCount },
    });
  }

  return { host, playerId: result.playerId };
};

const snapshotOf = (connection: ReturnType<typeof createConnection>) =>
  getLastEventPayload<RoomSnapshot>(connection, "room.snapshot")!;

const privateOf = (connection: ReturnType<typeof createConnection>) =>
  getLastEventPayload<PrivateState>(connection, "game.privateState")!;

test("房主转给机器人后移除该机器人，房主自动转移给仍在的玩家", async () => {
  const { service } = createTestContext();
  const { host, playerId } = await createTestRoom(service, 2);
  const botId = snapshotOf(host).players.find((player) => player.name === "机器人A")!.id;

  await execute(service, host, {
    id: "transfer",
    type: "room.transferHost",
    payload: { playerId: botId },
  });
  expect(snapshotOf(host).hostPlayerId).toBe(botId);

  await execute(service, host, {
    id: "remove",
    type: "test.removeBot",
    payload: { playerId: botId },
  });

  const snapshot = snapshotOf(host);
  // 房主不能悬空在已被移除的机器人身上。
  expect(snapshot.players.some((player) => player.id === botId)).toBe(false);
  expect(snapshot.hostPlayerId).toBe(playerId);
});

test("房主落在机器人身上时，名单一变就交回真人", async () => {
  const { service } = createTestContext();
  const { host, playerId } = await createTestRoom(service, 2);
  const before = snapshotOf(host);
  const botA = before.players.find((player) => player.name === "机器人A")!.id;
  const botB = before.players.find((player) => player.name === "机器人B")!.id;

  await execute(service, host, {
    id: "transfer",
    type: "room.transferHost",
    payload: { playerId: botA },
  });
  expect(snapshotOf(host).hostPlayerId).toBe(botA);

  // 界面上的「减一个」不带 playerId，服务端取末尾的机器人B。
  // 房主停在机器人A上会锁死房间：机器人不会开局，真人又因非房主拿不到管理操作。
  await execute(service, host, {
    id: "remove-tail",
    type: "test.removeBot",
    payload: { count: 1 },
  });

  const after = snapshotOf(host);
  expect(after.players.some((player) => player.id === botB)).toBe(false);
  expect(after.players.some((player) => player.id === botA)).toBe(true);
  expect(after.hostPlayerId).toBe(playerId);
});

test("游戏进行中加入的机器人进旁观，不进玩家列", async () => {
  const { service } = createTestContext();
  const { host } = await createTestRoom(service, 4);

  await execute(service, host, {
    id: "jump-description",
    type: "test.jumpToPhase",
    payload: { phase: "description" },
  });

  await execute(service, host, {
    id: "add-ingame",
    type: "test.addBot",
    payload: { count: 1 },
  });

  const snapshot = snapshotOf(host);
  const latecomer = snapshot.players.find((player) => player.name === "机器人E");
  // 与真人加入同规则：局内只能旁观。
  expect(latecomer?.membership).toBe("spectator");
  expect(snapshot.players.filter((player) => player.membership === "active")).toHaveLength(5);
});

test("本局没有白板时不能跳转到白板猜词，且不会篡改任何人身份", async () => {
  const { service } = createTestContext();
  const { host, playerId } = await createTestRoom(service, 4);

  await execute(service, host, {
    id: "jump-description",
    type: "test.jumpToPhase",
    payload: { phase: "description" },
  });

  const roleBefore = privateOf(host).role;
  let errorCode: string | undefined;

  try {
    await execute(service, host, {
      id: "jump-blank",
      type: "test.jumpToPhase",
      payload: { phase: "blankGuess" },
    });
  } catch (error) {
    errorCode = (error as { code?: string }).code;
  }

  expect(errorCode).toBe("INVALID_PHASE");
  // 阶段与身份都不该被这次失败的跳转改动。
  expect(snapshotOf(host).status.phase).toBe("description");
  expect(privateOf(host).role).toBe(roleBefore);
  expect(privateOf(host).playerId).toBe(playerId);
});

test("结算后所有人的准备状态都被重置", async () => {
  const { service } = createTestContext();
  const { host } = await createTestRoom(service, 4);

  await execute(service, host, {
    id: "jump-over",
    type: "test.jumpToPhase",
    payload: { phase: "gameOver" },
  });

  const snapshot = snapshotOf(host);
  expect(snapshot.status.phase).toBe("gameOver");
  expect(snapshot.players.every((player) => !player.isReady)).toBe(true);
});

test("测试房间可以随时增减机器人，人数上限生效", async () => {
  const { service } = createTestContext();
  const { host } = await createTestRoom(service, 4);

  expect(snapshotOf(host).players.filter((player) => player.isBot)).toHaveLength(4);

  await execute(service, host, {
    id: "remove-one",
    type: "test.removeBot",
    payload: { count: 1 },
  });
  expect(snapshotOf(host).players.filter((player) => player.isBot)).toHaveLength(3);

  // 上限 12 人（含房主），继续加只会加到满，不会无限膨胀。
  await execute(service, host, {
    id: "add-many",
    type: "test.addBot",
    payload: { count: 20 },
  });
  expect(snapshotOf(host).players).toHaveLength(12);
});

test("测试房间不能投自己，与普通房间同规则", async () => {
  const { service } = createTestContext();
  const { host, playerId } = await createTestRoom(service, 4);

  await execute(service, host, {
    id: "jump-voting",
    type: "test.jumpToPhase",
    payload: { phase: "voting" },
  });

  let errorCode: string | undefined;

  try {
    await execute(service, host, {
      id: "self-vote",
      type: "game.submitVote",
      payload: { targetId: playerId },
    });
  } catch (error) {
    errorCode = (error as { code?: string }).code;
  }

  expect(errorCode).toBe("INVALID_VOTE");
});

test("测试房间夜晚不能刀自己", async () => {
  const { service } = createTestContext();
  const { host, playerId } = await createTestRoom(service, 4);

  await execute(service, host, {
    id: "jump-night",
    type: "test.jumpToPhase",
    payload: { phase: "night" },
  });
  await execute(service, host, {
    id: "be-undercover",
    type: "test.setMyRole",
    payload: { role: "undercover" },
  });

  let errorCode: string | undefined;

  try {
    await execute(service, host, {
      id: "self-knife",
      type: "game.submitNightAction",
      payload: { targetId: playerId },
    });
  } catch (error) {
    errorCode = (error as { code?: string }).code;
  }

  expect(errorCode).toBe("INVALID_TARGET");
});

test("卧底数上限按参战人数计算，机器人增减后同步", async () => {
  const { service } = createTestContext();
  const { host } = await createTestRoom(service, 3);

  // 4 名正式玩家、无旁观 → 出题人占掉 1 个名额，参战 3 人 → 上限 max(1, ceil(3/4)) = 1。
  expect(snapshotOf(host).roleLimits.maxUndercoverCount).toBe(1);

  await execute(service, host, {
    id: "add-more",
    type: "test.addBot",
    payload: { count: 5 },
  });

  // 9 名正式玩家 → 参战 8 人 → 上限 ceil(8/4) = 2。
  const grown = snapshotOf(host);
  expect(grown.players).toHaveLength(9);
  expect(grown.roleLimits.maxUndercoverCount).toBe(2);
  expect(grown.roleLimits.canEnableBlank).toBe(true);

  await execute(service, host, {
    id: "shrink",
    type: "test.removeBot",
    payload: { count: 5 },
  });

  // 人数减回去，上限也必须跟着降，且已配置的卧底数被夹回合法值。
  const shrunk = snapshotOf(host);
  expect(shrunk.roleLimits.maxUndercoverCount).toBe(1);
  expect(shrunk.settings.roleConfig.undercoverCount).toBeLessThanOrEqual(1);
  expect(shrunk.roleLimits.canEnableBlank).toBe(false);
});

test("白板猜中后本局立即结束，白板获胜", async () => {
  const { service } = createTestContext();
  const { host, playerId } = await createTestRoom(service, 4);

  await execute(service, host, {
    id: "jump-desc",
    type: "test.jumpToPhase",
    payload: { phase: "description" },
  });
  await execute(service, host, {
    id: "be-blank",
    type: "test.setMyRole",
    payload: { role: "blank" },
  });

  // 白板可以在描述阶段主动猜词，不必等到 blankGuess 阶段。
  expect(privateOf(host).canSubmitBlankGuess).toBe(true);

  const result = (await execute(service, host, {
    id: "guess",
    type: "game.submitBlankGuess",
    payload: { words: ["苹果", "香蕉"] },
  })) as { success: boolean };

  expect(result.success).toBe(true);

  const finished = snapshotOf(host);
  expect(finished.status.phase).toBe("gameOver");
  expect(finished.summary?.winner).toBe("blank");
  expect(
    finished.summary?.awardedScores.find((score) => score.playerId === playerId)?.delta,
  ).toBe(2);
});

test("白板主动猜错不结束游戏，但机会用尽", async () => {
  const { service } = createTestContext();
  const { host } = await createTestRoom(service, 4);

  await execute(service, host, {
    id: "jump-desc",
    type: "test.jumpToPhase",
    payload: { phase: "description" },
  });
  await execute(service, host, {
    id: "be-blank",
    type: "test.setMyRole",
    payload: { role: "blank" },
  });

  const result = (await execute(service, host, {
    id: "wrong-guess",
    type: "game.submitBlankGuess",
    payload: { words: ["西瓜", "菠萝"] },
  })) as { success: boolean };

  expect(result.success).toBe(false);
  expect(snapshotOf(host).status.phase).toBe("description");
  expect(privateOf(host).blankGuessUsed).toBe(true);
  expect(privateOf(host).canSubmitBlankGuess).toBe(false);
});

test("每局的 roundId 都不同，供客户端清空身份预测", async () => {
  const { service } = createTestContext();
  const { host } = await createTestRoom(service, 4);

  await execute(service, host, {
    id: "jump-desc",
    type: "test.jumpToPhase",
    payload: { phase: "description" },
  });
  const firstRoundId = snapshotOf(host).status.roundId;
  expect(firstRoundId).toBeDefined();

  await execute(service, host, {
    id: "back-to-waiting",
    type: "test.jumpToPhase",
    payload: { phase: "waiting" },
  });
  expect(snapshotOf(host).status.roundId).toBeUndefined();

  await execute(service, host, {
    id: "jump-desc-again",
    type: "test.jumpToPhase",
    payload: { phase: "description" },
  });
  expect(snapshotOf(host).status.roundId).not.toBe(firstRoundId);
});

test("机器人会补齐发言与投票，出题人能一路推进到结算", async () => {
  const { service } = createTestContext();
  // 房主当出题人，5 个机器人参战。
  const { host, playerId } = await createTestRoom(service, 5);

  // 真人要自己勾准备；机器人加入时即为已准备，无需逐个勾。
  await execute(service, host, {
    id: "ready",
    type: "player.setReady",
    payload: { ready: true },
  });
  await execute(service, host, { id: "start", type: "game.advancePhase", payload: {} });
  await execute(service, host, {
    id: "assign",
    type: "game.assignQuestioner",
    payload: { playerId },
  });
  await execute(service, host, {
    id: "words",
    type: "game.submitWords",
    payload: { words: ["苹果", "香蕉"] },
  });

  // 机器人已在进入描述阶段时补齐全部发言，出题人可直接推进。
  const described = snapshotOf(host);
  expect(described.status.phase).toBe("description");
  expect(described.descriptions).toHaveLength(5);

  await execute(service, host, { id: "to-vote", type: "game.advancePhase", payload: {} });
  expect(snapshotOf(host).status.phase).toBe("voting");

  // 投票同样由机器人补齐，出题人结算后进入夜晚或直接分出胜负。
  await execute(service, host, { id: "resolve-vote", type: "game.advancePhase", payload: {} });
  const afterVote = snapshotOf(host);
  expect(["night", "tieBreak", "gameOver", "blankGuess"]).toContain(afterVote.status.phase);
});
