import { expect, test } from "bun:test";

import type { PrivateState, RoomSnapshot } from "../src/domain/model";
import { ABSTAIN_TARGET_ID, ROOM_ID_TEST_MODE } from "../src/domain/model";
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

test("投票阶段可以弃票，弃票记入已投并能正常结算", async () => {
  const { service } = createTestContext();
  // 房主当出题人，5 个机器人参战；另加一名真人负责弃票。
  const { host, playerId } = await createTestRoom(service, 5);

  const voter = createConnection(service, "abstain-voter");
  await execute(service, voter, {
    id: "join-voter",
    type: "room.join",
    roomId: ROOM_ID_TEST_MODE,
    payload: { userName: "弃票者" },
  });

  await execute(service, voter, {
    id: "voter-ready",
    type: "player.setReady",
    payload: { ready: true },
  });
  await execute(service, host, {
    id: "host-ready",
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

  // 机器人进入描述阶段即补齐发言，真人还要自己说一句才算齐。
  await execute(service, voter, {
    id: "voter-describe",
    type: "game.submitDescription",
    payload: { text: "一种常见的水果" },
  });
  await execute(service, host, { id: "to-vote", type: "game.advancePhase", payload: {} });
  expect(snapshotOf(host).status.phase).toBe("voting");

  await execute(service, voter, {
    id: "abstain",
    type: "game.submitVote",
    payload: { targetId: ABSTAIN_TARGET_ID },
  });

  // 弃票也是一次完成的投票：私有状态要能回显，否则客户端无法显示「已弃票」。
  expect(privateOf(voter).myCurrentVoteTargetId).toBe(ABSTAIN_TARGET_ID);

  // 全员已投，出题人应当能直接结算，而不是卡在「仍有玩家尚未投票」。
  // 弃票不计入任何人的得票，因此出局者只能是被机器人投出来的那位。
  await execute(service, host, { id: "resolve", type: "game.advancePhase", payload: {} });
  expect(snapshotOf(host).status.phase).not.toBe("voting");
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

/** 让房主成为白板并停在描述阶段，用于猜词相关用例。 */
const prepareBlank = async (
  service: ReturnType<typeof createTestContext>["service"],
  host: ReturnType<typeof createConnection>,
) => {
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
};

test("白板猜词是阻塞阶段：进入后全房停下，猜中即刻结束", async () => {
  const { service } = createTestContext();
  const { host, playerId } = await createTestRoom(service, 4);
  await prepareBlank(service, host);

  // 未进入阻塞阶段时不能直接提交，必须先发起猜词。
  let earlyError: string | undefined;
  try {
    await execute(service, host, {
      id: "guess-too-early",
      type: "game.submitBlankGuess",
      payload: { words: ["苹果", "香蕉"] },
    });
  } catch (error) {
    earlyError = (error as { code?: string }).code;
  }
  expect(earlyError).toBe("ACTION_FORBIDDEN");

  await execute(service, host, {
    id: "enter",
    type: "game.enterBlankGuess",
    payload: {},
  });

  // 阶段切到 blankGuess，全房都能看到是谁、因何进入。
  const entered = snapshotOf(host);
  expect(entered.status.phase).toBe("blankGuess");
  expect(entered.status.blankGuessPlayerId).toBe(playerId);
  expect(entered.status.blankGuessReason).toBe("active");

  // 输入草稿实时广播，其他人能看到白板正在猜什么。
  await execute(service, host, {
    id: "draft",
    type: "game.updateBlankGuessDraft",
    payload: { words: ["苹", ""] },
  });
  expect(snapshotOf(host).status.blankGuessDraft).toEqual(["苹", ""]);

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

test("猜词未完全匹配时交主持人裁定，判对则白板获胜", async () => {
  const { service } = createTestContext();
  // 房主当白板，出题人另找一名真人，这样才有人能裁定。
  const { host } = await createTestRoom(service, 4);

  const questioner = createConnection(service, "review-questioner");
  const questionerJoin = (await execute(service, questioner, {
    id: "join-questioner",
    type: "room.join",
    roomId: ROOM_ID_TEST_MODE,
    payload: { userName: "主持人" },
  })) as { playerId: string };

  await execute(service, questioner, {
    id: "jump-words",
    type: "test.jumpToPhase",
    payload: { phase: "wordSubmission" },
  });
  await execute(service, questioner, {
    id: "words",
    type: "game.submitWords",
    payload: { words: ["苹果", "香蕉"] },
  });
  await execute(service, host, {
    id: "be-blank",
    type: "test.setMyRole",
    payload: { role: "blank" },
  });
  expect(snapshotOf(host).status.questionerPlayerId).toBe(questionerJoin.playerId);

  await execute(service, host, { id: "enter", type: "game.enterBlankGuess", payload: {} });

  // 「香焦」只差一字，自动比对判否，但阶段不结束、机会已消耗。
  const wrong = (await execute(service, host, {
    id: "near-miss",
    type: "game.submitBlankGuess",
    payload: { words: ["苹果", "香焦"] },
  })) as { success: boolean; pendingReview: boolean };

  expect(wrong.success).toBe(false);
  expect(wrong.pendingReview).toBe(true);
  const waiting = snapshotOf(host);
  expect(waiting.status.phase).toBe("blankGuess");
  expect(waiting.status.blankGuessPendingReview).toBe(true);
  expect(waiting.status.blankGuessDraft).toEqual(["苹果", "香焦"]);
  expect(privateOf(host).blankGuessUsed).toBe(true);

  // 只有出题人能裁定。
  let forbidden: string | undefined;
  try {
    await execute(service, host, {
      id: "self-review",
      type: "game.reviewBlankGuess",
      payload: { approve: true },
    });
  } catch (error) {
    forbidden = (error as { code?: string }).code;
  }
  expect(forbidden).toBe("FORBIDDEN");

  await execute(service, questioner, {
    id: "approve",
    type: "game.reviewBlankGuess",
    payload: { approve: true },
  });

  const finished = snapshotOf(host);
  expect(finished.status.phase).toBe("gameOver");
  expect(finished.summary?.winner).toBe("blank");
  expect(finished.summary?.blankGuesses.at(-1)?.approvedByQuestioner).toBe(true);
});

test("残局触发的猜词猜错后，主持人判错则按残局条件结算", async () => {
  // finale 路径带 deferredWinner：改为「猜错先挂起等裁定」之后，
  // 这条路要仍然能走到原本该有的胜负结果，而不是停在待裁定。
  const { service } = createTestContext();
  const { host } = await createTestRoom(service, 4);

  const blank = createConnection(service, "finale-blank");
  await execute(service, blank, {
    id: "join-blank",
    type: "room.join",
    roomId: ROOM_ID_TEST_MODE,
    payload: { userName: "白板" },
  });

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
  await execute(service, blank, {
    id: "be-blank",
    type: "test.setMyRole",
    payload: { role: "blank" },
  });

  // 跳到 blankGuess 会带上 finale 之外的上下文，这里直接用主动路径进入，
  // 再断言「猜错 → 裁定 → 有明确结局」这段收尾在任何 reason 下都成立。
  await execute(service, blank, { id: "enter", type: "game.enterBlankGuess", payload: {} });
  await execute(service, blank, {
    id: "wrong",
    type: "game.submitBlankGuess",
    payload: { words: ["西瓜", "菠萝"] },
  });
  expect(snapshotOf(host).status.blankGuessPendingReview).toBe(true);

  await execute(service, host, {
    id: "reject",
    type: "game.reviewBlankGuess",
    payload: { approve: false },
  });

  // 裁定之后必须离开 blankGuess，且不再留有待裁定标记。
  const after = snapshotOf(host);
  expect(after.status.phase).not.toBe("blankGuess");
  expect(after.status.blankGuessPendingReview).toBeUndefined();
  expect(after.status.blankGuessPlayerId).toBeUndefined();
});

test("结算后开新局，上一局的待裁定状态不会残留", async () => {
  const { service } = createTestContext();
  const { host } = await createTestRoom(service, 4);

  const blank = createConnection(service, "reset-blank");
  await execute(service, blank, {
    id: "join-blank",
    type: "room.join",
    roomId: ROOM_ID_TEST_MODE,
    payload: { userName: "白板" },
  });

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
  await execute(service, blank, {
    id: "be-blank",
    type: "test.setMyRole",
    payload: { role: "blank" },
  });
  await execute(service, blank, { id: "enter", type: "game.enterBlankGuess", payload: {} });
  await execute(service, blank, {
    id: "near-miss",
    type: "game.submitBlankGuess",
    payload: { words: ["苹果", "香焦"] },
  });
  expect(snapshotOf(host).status.blankGuessPendingReview).toBe(true);

  // 待裁定期间直接结束本局并回到等待，再开一局。
  await execute(service, host, {
    id: "to-over",
    type: "test.jumpToPhase",
    payload: { phase: "gameOver" },
  });
  await execute(service, host, {
    id: "to-waiting",
    type: "test.jumpToPhase",
    payload: { phase: "waiting" },
  });

  const waiting = snapshotOf(host);
  expect(waiting.status.blankGuessPendingReview).toBeUndefined();
  expect(waiting.status.blankGuessPlayerId).toBeUndefined();
  expect(waiting.status.phase).toBe("waiting");
});

test("猜词中的白板被踢出后阶段不会卡住", async () => {
  // blankGuess 是阻塞阶段且没有手动推进入口：如果猜词的人离场后
  // 阶段还留在 blankGuess，全房就永远动不了。
  const { service } = createTestContext();
  const { host } = await createTestRoom(service, 4);

  const blank = createConnection(service, "abandon-blank");
  const blankJoin = (await execute(service, blank, {
    id: "join-blank",
    type: "room.join",
    roomId: ROOM_ID_TEST_MODE,
    payload: { userName: "白板" },
  })) as { playerId: string };

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
  await execute(service, blank, {
    id: "be-blank",
    type: "test.setMyRole",
    payload: { role: "blank" },
  });

  await execute(service, blank, { id: "enter", type: "game.enterBlankGuess", payload: {} });
  expect(snapshotOf(host).status.phase).toBe("blankGuess");

  // 房主把正在猜词的人踢出去。
  await execute(service, host, {
    id: "kick-blank",
    type: "room.kick",
    payload: { playerId: blankJoin.playerId },
  });

  const after = snapshotOf(host);
  expect(after.status.phase).not.toBe("blankGuess");
  expect(after.status.blankGuessPlayerId).toBeUndefined();
});

test("待裁定时主持人被踢出，本局不会卡在待裁定", async () => {
  // pendingReview 只能由出题人推进。出题人一走，若阶段仍停在待裁定，
  // 全房同样再没有出口。
  const { service } = createTestContext();
  const { host } = await createTestRoom(service, 4);

  const questioner = createConnection(service, "gone-questioner");
  const questionerJoin = (await execute(service, questioner, {
    id: "join-questioner",
    type: "room.join",
    roomId: ROOM_ID_TEST_MODE,
    payload: { userName: "主持人" },
  })) as { playerId: string };

  await execute(service, questioner, {
    id: "jump-words",
    type: "test.jumpToPhase",
    payload: { phase: "wordSubmission" },
  });
  await execute(service, questioner, {
    id: "words",
    type: "game.submitWords",
    payload: { words: ["苹果", "香蕉"] },
  });
  await execute(service, host, {
    id: "be-blank",
    type: "test.setMyRole",
    payload: { role: "blank" },
  });

  await execute(service, host, { id: "enter", type: "game.enterBlankGuess", payload: {} });
  await execute(service, host, {
    id: "near-miss",
    type: "game.submitBlankGuess",
    payload: { words: ["苹果", "香焦"] },
  });
  expect(snapshotOf(host).status.blankGuessPendingReview).toBe(true);

  // 房主把出题人踢掉（踢出题人本身会中止本局）。
  await execute(service, host, {
    id: "kick-questioner",
    type: "room.kick",
    payload: { playerId: questionerJoin.playerId },
  });

  const after = snapshotOf(host);
  expect(after.status.blankGuessPendingReview).toBeUndefined();
  expect(after.status.phase).not.toBe("blankGuess");
});

test("主持人判错时回到原阶段继续游戏，机会不再返还", async () => {
  const { service } = createTestContext();
  const { host } = await createTestRoom(service, 4);

  const questioner = createConnection(service, "reject-questioner");
  await execute(service, questioner, {
    id: "join-questioner",
    type: "room.join",
    roomId: ROOM_ID_TEST_MODE,
    payload: { userName: "主持人" },
  });

  await execute(service, questioner, {
    id: "jump-words",
    type: "test.jumpToPhase",
    payload: { phase: "wordSubmission" },
  });
  await execute(service, questioner, {
    id: "words",
    type: "game.submitWords",
    payload: { words: ["苹果", "香蕉"] },
  });
  await execute(service, host, {
    id: "be-blank",
    type: "test.setMyRole",
    payload: { role: "blank" },
  });

  await execute(service, host, { id: "enter", type: "game.enterBlankGuess", payload: {} });
  await execute(service, host, {
    id: "wrong-guess",
    type: "game.submitBlankGuess",
    payload: { words: ["西瓜", "菠萝"] },
  });
  await execute(service, questioner, {
    id: "reject",
    type: "game.reviewBlankGuess",
    payload: { approve: false },
  });

  // 回到发起猜词时的阶段，游戏继续；机会已经用掉，不能再猜。
  expect(snapshotOf(host).status.phase).toBe("description");
  expect(snapshotOf(host).status.blankGuessPlayerId).toBeUndefined();
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
