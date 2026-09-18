import { describe, expect, test } from "bun:test";

import { CCBService, type CCBCharacterSource } from "../src/application/CCBService";
import type { ConnectionRecord } from "../src/domain/Model";
import {
  CCB_ATTEMPT_MARKS,
  CCB_END_MARK,
  CCB_MASKED_TAG,
  type CCBCharacterView,
} from "../src/domain/CCBRules";
import type {
  CCBAnswerView,
  CCBClientMessage,
  CCBFeedback,
  CCBGameSettings,
  CCBPrivateState,
  CCBRoomSnapshot,
} from "../src/shared/Index";

// ==================== 脚手架 ====================

interface TestConnection {
  record: ConnectionRecord;
  sent: Array<{ type?: string; event?: string; payload?: unknown }>;
}

const createService = () => {
  let currentTime = Date.UTC(2026, 8, 17, 0, 0, 0);
  const service = new CCBService({
    now: () => currentTime,
    characters: characterSource,
  });
  return {
    service,
    now: () => currentTime,
    advanceTime: (milliseconds: number) => {
      currentTime += milliseconds;
    },
  };
};

const createServiceWithoutData = () => {
  let currentTime = Date.UTC(2026, 8, 17, 0, 0, 0);
  return {
    service: new CCBService({ now: () => currentTime }),
    now: () => currentTime,
    advanceTime: (milliseconds: number) => {
      currentTime += milliseconds;
    },
  };
};

const connection = (service: CCBService, id: string): TestConnection => {
  const state: TestConnection = { record: undefined as unknown as ConnectionRecord, sent: [] };
  const record: ConnectionRecord = {
    id,
    lobbySubscribed: false,
    send: (payload) => state.sent.push(payload as TestConnection["sent"][number]),
    sendPacket: (payload) => state.sent.push(payload as TestConnection["sent"][number]),
    resetStateSync: () => undefined,
    sendStateSyncCalibration: (payload) =>
      state.sent.push(payload as TestConnection["sent"][number]),
    close: () => undefined,
  };
  state.record = record;
  service.registerConnection(record);
  return state;
};

const execute = (service: CCBService, client: TestConnection, message: CCBClientMessage) =>
  service.execute(client.record.id, message);

const eventsOf = <T>(client: TestConnection, event: string): T[] =>
  client.sent
    .filter((item) => item.type === "event" && item.event === event)
    .map((item) => item.payload as T);

const lastEvent = <T>(client: TestConnection, event: string): T => eventsOf<T>(client, event).at(-1) as T;

const snapshotOf = (client: TestConnection) => lastEvent<CCBRoomSnapshot>(client, "ccb.room.snapshot");
const privateStateOf = (client: TestConnection) => lastEvent<CCBPrivateState>(client, "ccb.game.privateState");

const scoreOf = (client: TestConnection) =>
  snapshotOf(client).players.find((player) => player.id === client.record.playerId)!.score;

/** 玩家在快照里的那一行（标记、分数、finished 都在这里）。 */
const viewOf = (client: TestConnection) =>
  snapshotOf(client).players.find((player) => player.id === client.record.playerId)!;

/** 建房 + 全员准备，但**不开局** —— 手动出题与队伍设置都要从「等待」阶段开始。 */
const prepareRoom = async (
  service: CCBService,
  host: TestConnection,
  guests: TestConnection[],
  settings: Partial<CCBGameSettings> = {},
) => {
  await execute(service, host, {
    id: "create",
    type: "ccb.room.create",
    payload: {
      roomId: "1234",
      name: "猜角色房",
      visibility: "public",
      allowSpectators: true,
      userName: "房主",
      settings,
    },
  });
  for (const [index, guest] of guests.entries()) {
    await execute(service, guest, {
      id: `join-${index}`,
      type: "ccb.room.join",
      roomId: "1234",
      payload: { userName: `玩家${index + 1}` },
    });
    await execute(service, guest, {
      id: `ready-${index}`,
      type: "ccb.player.setReady",
      payload: { ready: true },
    });
  }
};

const setTeam = (service: CCBService, client: TestConnection, team: number | null) =>
  execute(service, client, { id: "team", type: "ccb.player.setTeam", payload: { team } });

// ==================== 假数据源 ====================

/**
 * 两个角色：
 * - 1 号：热度 100、最高分 8.0、登场作品 [10]、标签 紫瞳
 * - 2 号：热度 200、最高分 9.0、登场作品 [10, 20]、标签 紫瞳/腹黑
 * 两者共享作品 10，所以「猜 2、答案是 1」应当被判为作品分候选。
 */
const view = (overrides: Partial<CCBCharacterView> & { id: number }): CCBCharacterView => ({
  name: `name-${overrides.id}`,
  nameCn: `中文-${overrides.id}`,
  gender: "female",
  popularity: 100,
  appearances: ["作品"],
  appearancesCn: ["作品"],
  appearanceIds: [10],
  latestAppearance: 2010,
  earliestAppearance: 2008,
  highestRating: 8,
  metaTags: ["紫瞳"],
  rawTags: [["紫瞳", 5]],
  characterTags: [],
  animeVAs: [],
  ...overrides,
});

const characters: Record<number, CCBCharacterView> = {
  1: view({ id: 1 }),
  2: view({ id: 2, popularity: 200, highestRating: 9, appearanceIds: [10, 20], latestAppearance: 2011 }),
  // 3、4 号与答案**没有共同作品**（连作品名都不一样，否则会回落到名字交集），
  // 于是猜它们只记 ❌、不记 💡 —— 「猜一次到底算几次」的用例需要这种干扰项。
  3: view({
    id: 3,
    appearanceIds: [30],
    appearances: ["作品B"],
    appearancesCn: ["作品乙"],
    popularity: 50,
    latestAppearance: 2015,
    earliestAppearance: 2014,
  }),
  4: view({
    id: 4,
    appearanceIds: [40],
    appearances: ["作品C"],
    appearancesCn: ["作品丙"],
    popularity: 60,
    latestAppearance: 2016,
    earliestAppearance: 2015,
  }),
};

const characterSource: CCBCharacterSource = {
  pickRandomSubject: () => ({ id: 10, name: "作品", nameCn: "作品" }),
  pickRandomCharacter: () => 1,
  buildCharacterView: (characterId) => characters[characterId],
  searchCharacters: () => [],
};

const feedbackOf = (client: TestConnection): CCBFeedback => {
  const guesses = privateStateOf(client).ownGuesses;
  return guesses[guesses.length - 1]!.feedback;
};

// ==================== 用例 ====================

const startGame = async (
  service: CCBService,
  host: TestConnection,
  guests: TestConnection[],
  settings: Partial<CCBGameSettings> = {},
) => {
  await execute(service, host, {
    id: "create",
    type: "ccb.room.create",
    payload: {
      roomId: "1234",
      name: "猜角色房",
      visibility: "public",
      allowSpectators: true,
      userName: "房主",
      settings: { maxAttempts: 5, ...settings },
    },
  });
  for (const [index, guest] of guests.entries()) {
    await execute(service, guest, {
      id: `join-${index}`,
      type: "ccb.room.join",
      roomId: "1234",
      payload: { userName: `玩家${index + 1}` },
    });
    await execute(service, guest, {
      id: `ready-${index}`,
      type: "ccb.player.setReady",
      payload: { ready: true },
    });
  }
  return execute(service, host, {
    id: "start",
    type: "ccb.game.start",
    payload: {},
  });
};

describe("CCB 对局：数据源缺失时不得假装能玩", () => {
  test("未注入角色数据集时开局报 CCB_DATA_UNAVAILABLE", async () => {
    const { service } = createServiceWithoutData();
    const host = connection(service, "c-host");
    await execute(service, host, {
      id: "create",
      type: "ccb.room.create",
      payload: {
        roomId: "1234",
        name: "房",
        visibility: "public",
        allowSpectators: true,
        userName: "房主",
      },
    });
    await expect(
      execute(service, host, { id: "start", type: "ccb.game.start", payload: {} }),
    ).rejects.toMatchObject({ code: "CCB_DATA_UNAVAILABLE" });
  });
});

describe("CCB 对局：开局与私有状态", () => {
  test("开局后进入 guessing，答案不下发，房主与参与者能力位正确", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const guest = connection(service, "c-guest");
    await startGame(service, host, [guest]);

    expect(snapshotOf(host).phase).toBe("guessing");
    expect(snapshotOf(host).roundNumber).toBe(1);
    // 答案只有结算后才公开
    expect(snapshotOf(host).answer).toBeUndefined();

    // 出题人（房主）不能猜，参与者可以
    expect(privateStateOf(host).canGuess).toBe(false);
    expect(privateStateOf(host).canStartRound).toBe(false);
    expect(privateStateOf(guest).canGuess).toBe(true);
    expect(privateStateOf(guest).remainingGuesses).toBe(5);
    expect(privateStateOf(guest).ownGuesses).toEqual([]);
  });

  test("有玩家未准备时不开局", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const guest = connection(service, "c-guest");
    await execute(service, host, {
      id: "create",
      type: "ccb.room.create",
      payload: {
        roomId: "1234",
        name: "房",
        visibility: "public",
        allowSpectators: true,
        userName: "房主",
      },
    });
    await execute(service, guest, {
      id: "join",
      type: "ccb.room.join",
      roomId: "1234",
      payload: { userName: "玩家" },
    });
    await expect(
      execute(service, host, { id: "start", type: "ccb.game.start", payload: {} }),
    ).rejects.toMatchObject({ code: "PLAYER_NOT_READY" });
  });
});

describe("CCB 对局：猜测与标记", () => {
  test("猜错写 ❌、扣一次次数，反馈取服务端计算结果", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const guest = connection(service, "c-guest");
    await startGame(service, host, [guest]);

    const result = (await execute(service, guest, {
      id: "g1",
      type: "ccb.game.guess",
      payload: { characterId: 2 },
    })) as { correct: boolean };

    expect(result.correct).toBe(false);
    const me = snapshotOf(guest).players.find((player) => player.id === guest.record.playerId)!;
    expect(me.marks).toBe(CCB_ATTEMPT_MARKS.wrong + CCB_ATTEMPT_MARKS.partial);
    // ⚠️ `💡` 也是尝试标记，所以一次「猜错且沾边」按原版口径计 **2** 次，不是 1 次。
    expect(me.guessCount).toBe(2);
    // 与答案共享作品 10，因此反馈里应带共同作品
    expect(feedbackOf(guest).shared_appearances.count).toBe(1);
    expect(privateStateOf(guest).remainingGuesses).toBe(3);
  });

  test("首猜即中记 👑（大赢家），得分 2 + 12", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const guest = connection(service, "c-guest");
    await startGame(service, host, [guest]);

    await execute(service, guest, { id: "g1", type: "ccb.game.guess", payload: { characterId: 1 } });
    const me = snapshotOf(guest).players.find((player) => player.id === guest.record.playerId)!;
    expect(me.marks).toBe(CCB_ATTEMPT_MARKS.correct + CCB_END_MARK.bigWin);
    expect(me.score).toBe(14);
    expect(me.finished).toBe(true);
    expect(snapshotOf(guest).phase).toBe("settled");
  });

  test("第二猜才中记 ✌，并拿到「好快的猜」+2", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const guest = connection(service, "c-guest");
    await startGame(service, host, [guest]);

    await execute(service, guest, { id: "g1", type: "ccb.game.guess", payload: { characterId: 2 } });
    await execute(service, guest, { id: "g2", type: "ccb.game.guess", payload: { characterId: 1 } });
    const me = snapshotOf(guest).players.find((player) => player.id === guest.record.playerId)!;
    expect(me.marks).toBe(
      CCB_ATTEMPT_MARKS.wrong + CCB_ATTEMPT_MARKS.partial + CCB_ATTEMPT_MARKS.correct + CCB_END_MARK.win,
    );
    expect(me.score).toBe(4);
  });

  test("次数用尽记 💀 并结束本局", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const guest = connection(service, "c-guest");
    await execute(service, host, {
      id: "create",
      type: "ccb.room.create",
      payload: {
        roomId: "1234",
        name: "房",
        visibility: "public",
        allowSpectators: true,
        userName: "房主",
        settings: { maxAttempts: 1 },
      },
    });
    await execute(service, guest, {
      id: "join",
      type: "ccb.room.join",
      roomId: "1234",
      payload: { userName: "玩家" },
    });
    await execute(service, guest, {
      id: "ready",
      type: "ccb.player.setReady",
      payload: { ready: true },
    });
    await execute(service, host, { id: "start", type: "ccb.game.start", payload: {} });

    await execute(service, guest, { id: "g1", type: "ccb.game.guess", payload: { characterId: 2 } });
    const me = snapshotOf(guest).players.find((player) => player.id === guest.record.playerId)!;
    expect(me.marks).toBe(
      CCB_ATTEMPT_MARKS.wrong + CCB_ATTEMPT_MARKS.partial + CCB_END_MARK.dead,
    );
    expect(me.finished).toBe(true);
    expect(privateStateOf(guest).canGuess).toBe(false);
  });

  test("同一角色不能猜两次；globalPick 开启时别人猜过也不能猜", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const guest = connection(service, "c-guest");
    await startGame(service, host, [guest]);

    await execute(service, guest, { id: "g1", type: "ccb.game.guess", payload: { characterId: 2 } });
    await expect(
      execute(service, guest, { id: "g2", type: "ccb.game.guess", payload: { characterId: 2 } }),
    ).rejects.toMatchObject({ code: "CHARACTER_ALREADY_PICKED" });
  });

  test("未开局时不能猜测", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    await execute(service, host, {
      id: "create",
      type: "ccb.room.create",
      payload: {
        roomId: "1234",
        name: "房",
        visibility: "public",
        allowSpectators: true,
        userName: "房主",
      },
    });
    await expect(
      execute(service, host, { id: "g", type: "ccb.game.guess", payload: { characterId: 1 } }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" });
  });
});

describe("CCB 对局：结算与推进", () => {
  test("普通模式出现胜者立即结算（不等其他人猜完），答案随快照公开", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const first = connection(service, "c-first");
    const second = connection(service, "c-second");
    await startGame(service, host, [first, second]);

    // 第三名玩家一次都没猜，但普通模式一旦有人猜中就直接结算。
    await execute(service, first, { id: "g1", type: "ccb.game.guess", payload: { characterId: 1 } });
    const answer = snapshotOf(host).answer as CCBAnswerView;
    expect(answer).toMatchObject({ id: 1, revealed: true });
    expect(snapshotOf(host).phase).toBe("settled");
    expect(privateStateOf(second).canGuess).toBe(false);
    // 结算后房主可以开下一局
    expect(privateStateOf(host).canStartRound).toBe(true);
  });

  test("投降记 🏳️ 且立即结束该玩家本局", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const guest = connection(service, "c-guest");
    await startGame(service, host, [guest]);

    await execute(service, guest, { id: "s", type: "ccb.game.surrender", payload: {} });
    const me = snapshotOf(guest).players.find((player) => player.id === guest.record.playerId)!;
    expect(me.marks).toBe(CCB_END_MARK.surrender);
    expect(me.finished).toBe(true);
  });

  test("限时到点记 ⏱️ 并结算", async () => {
    const { service, now, advanceTime } = createService();
    const host = connection(service, "c-host");
    const guest = connection(service, "c-guest");
    await execute(service, host, {
      id: "create",
      type: "ccb.room.create",
      payload: {
        roomId: "1234",
        name: "房",
        visibility: "public",
        allowSpectators: true,
        userName: "房主",
        settings: { timeLimitMs: 60_000 },
      },
    });
    await execute(service, guest, {
      id: "join",
      type: "ccb.room.join",
      roomId: "1234",
      payload: { userName: "玩家" },
    });
    await execute(service, guest, {
      id: "ready",
      type: "ccb.player.setReady",
      payload: { ready: true },
    });
    await execute(service, host, { id: "start", type: "ccb.game.start", payload: {} });

    const deadline = snapshotOf(guest).guessDeadlineAt;
    expect(typeof deadline).toBe("number");
    // 服务与测试共用同一个 now，所以时钟推进量可以直接由截止时间反推。
    advanceTime(deadline! - now() + 1);
    await service.runHousekeeping();

    const me = snapshotOf(guest).players.find((player) => player.id === guest.record.playerId)!;
    expect(me.marks).toBe(CCB_ATTEMPT_MARKS.timeout + CCB_END_MARK.dead);
    expect(snapshotOf(guest).phase).toBe("settled");
  });

  test("房主结束对局回到等待阶段并清空标记", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const guest = connection(service, "c-guest");
    await startGame(service, host, [guest]);
    await execute(service, guest, { id: "g1", type: "ccb.game.guess", payload: { characterId: 1 } });

    await execute(service, host, { id: "finish", type: "ccb.game.finish", payload: {} });
    const snapshot = snapshotOf(host);
    expect(snapshot.phase).toBe("waiting");
    expect(snapshot.answer).toBeUndefined();
    expect(snapshot.players.every((player) => player.marks === "" && player.guessCount === 0)).toBe(true);
  });
});

describe("CCB 对局：全局 BP", () => {
  test("角色全局 BP：别人猜过的角色自己不能再猜", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const first = connection(service, "c-first");
    const second = connection(service, "c-second");
    await startGame(service, host, [first, second], { globalPick: true });

    await execute(service, first, { id: "g1", type: "ccb.game.guess", payload: { characterId: 2 } });
    await expect(
      execute(service, second, { id: "g2", type: "ccb.game.guess", payload: { characterId: 2 } }),
    ).rejects.toMatchObject({ code: "CHARACTER_ALREADY_PICKED" });

    // 换一个没被猜过的角色就放行，猜中即结算。
    const result = (await execute(service, second, {
      id: "g3",
      type: "ccb.game.guess",
      payload: { characterId: 1 },
    })) as { correct: boolean };
    expect(result.correct).toBe(true);
  });

  test("标签全局 BP：揭示的共享标签对非揭示者显示 ???，揭示者自己可见", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const first = connection(service, "c-first");
    const second = connection(service, "c-second");
    await startGame(service, host, [first, second], { tagBan: true });

    // 甲猜 2 号：猜错但与答案共享「紫瞳」，该标签进入本局待提交 —— 结算前不生效。
    await execute(service, first, { id: "g1", type: "ccb.game.guess", payload: { characterId: 2 } });
    expect(snapshotOf(first).bannedTags).toEqual([]);
    expect(feedbackOf(first).metaTags).toEqual({ guess: ["紫瞳"], shared: ["紫瞳"] });

    // 乙首猜即中：普通模式立即结算，待提交在此刻才合并生效。
    await execute(service, second, { id: "g2", type: "ccb.game.guess", payload: { characterId: 1 } });
    expect(snapshotOf(first).bannedTags).toEqual(["紫瞳"]);

    // 「谁先揭示归谁」：甲是先揭示者，照常可见；乙只能说 ???（shared 直接被剔除）。
    expect(feedbackOf(first).metaTags).toEqual({ guess: ["紫瞳"], shared: ["紫瞳"] });
    expect(feedbackOf(second).metaTags).toEqual({ guess: [CCB_MASKED_TAG], shared: [] });
  });

  test("标签全局 BP 关闭时既不屏蔽也不遮掩", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const guest = connection(service, "c-guest");
    await startGame(service, host, [guest]);

    await execute(service, guest, { id: "g1", type: "ccb.game.guess", payload: { characterId: 1 } });
    expect(snapshotOf(guest).bannedTags).toEqual([]);
    expect(feedbackOf(guest).metaTags).toEqual({ guess: ["紫瞳"], shared: ["紫瞳"] });
  });
});

describe("CCB 对局：同步与血战", () => {
  test("同步模式：每人每轮只能猜一次，全员完成才推进轮次", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const first = connection(service, "c-first");
    const second = connection(service, "c-second");
    await startGame(service, host, [first, second], { mode: "sync" });

    await execute(service, first, { id: "g1", type: "ccb.game.guess", payload: { characterId: 2 } });
    // 甲本轮完成，但乙还没猜 → 轮次不推进
    expect(snapshotOf(first).syncProgress).toEqual({
      round: 1,
      completedPlayerIds: [first.record.playerId!],
    });
    expect(privateStateOf(first).syncCompleted).toBe(true);
    expect(privateStateOf(first).canGuess).toBe(false);

    // 同一轮不能猜第二次
    await expect(
      execute(service, first, { id: "g2", type: "ccb.game.guess", payload: { characterId: 1 } }),
    ).rejects.toMatchObject({ code: "SYNC_ROUND_COMPLETED" });

    // 乙也完成本轮 → 无胜者 → 推进到第 2 轮，两人重新可猜
    await execute(service, second, { id: "g3", type: "ccb.game.guess", payload: { characterId: 2 } });
    expect(snapshotOf(first).syncProgress).toEqual({ round: 2, completedPlayerIds: [] });
    expect(privateStateOf(first).syncCompleted).toBe(false);
    expect(privateStateOf(first).canGuess).toBe(true);
    expect(snapshotOf(first).phase).toBe("guessing");
  });

  test("同步模式：出现胜者要等本轮结束才结算", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const first = connection(service, "c-first");
    const second = connection(service, "c-second");
    await startGame(service, host, [first, second], { mode: "sync" });

    // 甲首猜即中，但乙本轮还没猜 → 不结算，答案也不公开
    await execute(service, first, { id: "g1", type: "ccb.game.guess", payload: { characterId: 1 } });
    expect(snapshotOf(first).phase).toBe("guessing");
    expect(snapshotOf(first).answer).toBeUndefined();

    // 乙完成本轮 → 全员完成且有胜者 → 立即结算
    await execute(service, second, { id: "g2", type: "ccb.game.guess", payload: { characterId: 2 } });
    expect(snapshotOf(first).phase).toBe("settled");
    expect(snapshotOf(first).answer).toMatchObject({ id: 1, revealed: true });
  });

  test("同步模式：投降也算本轮完成（否则残局会卡死）", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const first = connection(service, "c-first");
    const second = connection(service, "c-second");
    await startGame(service, host, [first, second], { mode: "sync" });

    await execute(service, first, { id: "s", type: "ccb.game.surrender", payload: {} });
    expect(snapshotOf(first).syncProgress).toEqual({
      round: 1,
      completedPlayerIds: [first.record.playerId!],
    });
  });

  test("同步模式：全员出局且无人猜中也要收尾", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const guest = connection(service, "c-guest");
    await startGame(service, host, [guest], { mode: "sync", maxAttempts: 1 });

    // 一次「猜错且沾边」按原版口径算 2 次，所以 maxAttempts=1 直接 💀。
    await execute(service, guest, { id: "g1", type: "ccb.game.guess", payload: { characterId: 2 } });
    expect(snapshotOf(guest).phase).toBe("settled");
  });

  test("同步模式：限时到点只算本轮完成，不结束本局", async () => {
    const { service, now, advanceTime } = createService();
    const host = connection(service, "c-host");
    const first = connection(service, "c-first");
    const second = connection(service, "c-second");
    await startGame(service, host, [first, second], { mode: "sync", timeLimitMs: 60_000 });

    const deadline = snapshotOf(first).guessDeadlineAt;
    expect(typeof deadline).toBe("number");
    advanceTime(deadline! - now() + 1);
    await service.runHousekeeping();

    // 本局继续：两人各记一次 ⏱️ 并进入第 2 轮，计时重置
    expect(snapshotOf(first).phase).toBe("guessing");
    expect(snapshotOf(first).syncProgress).toEqual({ round: 2, completedPlayerIds: [] });
    const me = snapshotOf(first).players.find((player) => player.id === first.record.playerId)!;
    expect(me.marks).toBe(CCB_ATTEMPT_MARKS.timeout);
    expect(me.finished).toBe(false);
    expect(snapshotOf(first).guessDeadlineAt).toBeGreaterThan(now());
  });

  test("同步模式：标签 BP 对本轮参战玩家全员透视", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const first = connection(service, "c-first");
    const second = connection(service, "c-second");
    await startGame(service, host, [first, second], { mode: "sync", tagBan: true });

    // 甲猜错但与答案共享「紫瞳」→ 进入本局待提交；乙首猜即中 → 本轮俩人完成 → 结算。
    await execute(service, first, { id: "g1", type: "ccb.game.guess", payload: { characterId: 2 } });
    await execute(service, second, { id: "g2", type: "ccb.game.guess", payload: { characterId: 1 } });
    expect(snapshotOf(first).bannedTags).toEqual(["紫瞳"]);

    // 对照普通模式：乙不是揭示者，但同步模式下同轮猜测视为同时发生，所以乙照样看得见。
    expect(feedbackOf(second).metaTags).toEqual({ guess: ["紫瞳"], shared: ["紫瞳"] });
  });

  test("血战：猜对不收尾，名次分依次递减，全员结束才结算", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const first = connection(service, "c-first");
    const second = connection(service, "c-second");
    const third = connection(service, "c-third");
    await startGame(service, host, [first, second, third], { mode: "bloodbath" });

    // 甲首猜即中：名次 1，底分 max(1, 3 − 0) = 3，加大赢家 12 → 15。有胜者但不收尾。
    await execute(service, first, { id: "g1", type: "ccb.game.guess", payload: { characterId: 1 } });
    expect(snapshotOf(first).phase).toBe("guessing");
    expect(snapshotOf(first).nonstopWinnerIds).toEqual([first.record.playerId!]);
    expect(scoreOf(first)).toBe(15);

    // 乙也首猜即中：名次 2，底分 max(1, 3 − 1) = 2 → 14。丙还在，仍不收尾。
    await execute(service, second, { id: "g2", type: "ccb.game.guess", payload: { characterId: 1 } });
    expect(snapshotOf(first).phase).toBe("guessing");
    expect(scoreOf(second)).toBe(14);

    // 丙猜错后投降 → 全员结束 → 结算；胜者分已在猜对时发过，不能重复计。
    await execute(service, third, { id: "g3", type: "ccb.game.guess", payload: { characterId: 2 } });
    await execute(service, third, { id: "s", type: "ccb.game.surrender", payload: {} });
    expect(snapshotOf(first).phase).toBe("settled");
    expect(scoreOf(first)).toBe(15);
    expect(scoreOf(second)).toBe(14);
    // 丙没猜中但有共同作品 → 结算时拿 1 分作品分
    expect(scoreOf(third)).toBe(1);
  });
});

describe("CCB 对局：手动出题", () => {
  test("指定出题人后进入 answering，只有出题人能提交答案", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const guest = connection(service, "c-guest");
    const other = connection(service, "c-other");
    await prepareRoom(service, host, [guest, other]);

    await execute(service, host, {
      id: "pick",
      type: "ccb.game.chooseSetter",
      payload: { playerId: guest.record.playerId! },
    });
    expect(snapshotOf(host).phase).toBe("answering");
    expect(snapshotOf(host).answerSetterPlayerId).toBe(guest.record.playerId);
    expect(privateStateOf(guest).canSetAnswer).toBe(true);
    // 房主与旁观者都不行 —— 能力位是服务端的权威判断。
    expect(privateStateOf(host).canSetAnswer).toBe(false);
    expect(privateStateOf(other).canSetAnswer).toBe(false);

    await expect(
      execute(service, other, { id: "a0", type: "ccb.game.setAnswer", payload: { characterId: 1 } }),
    ).rejects.toMatchObject({ code: "SETTER_FORBIDDEN" });

    // 出题人提交答案 → 直接开局
    await execute(service, guest, {
      id: "a1",
      type: "ccb.game.setAnswer",
      payload: { characterId: 2 },
    });
    expect(snapshotOf(host).phase).toBe("guessing");
    expect(privateStateOf(guest).canSetAnswer).toBe(false);
    // 出题人自己不能猜，但能看到自己选的答案；答案不进全房快照。
    expect(privateStateOf(guest).canGuess).toBe(false);
    expect(privateStateOf(guest).setterAnswer).toMatchObject({ id: 2, revealed: false });
    expect(privateStateOf(host).setterAnswer).toBeUndefined();
    expect(snapshotOf(host).answer).toBeUndefined();

    // 答案就是 2 号
    await execute(service, other, { id: "g1", type: "ccb.game.guess", payload: { characterId: 2 } });
    expect(snapshotOf(host).phase).toBe("settled");
  });

  test("手动出题结算出题人分：首猜即中 → 扣大赢家得分的一半", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const setter = connection(service, "c-setter");
    const guesser = connection(service, "c-guesser");
    await prepareRoom(service, host, [setter, guesser]);

    await execute(service, host, {
      id: "pick",
      type: "ccb.game.chooseSetter",
      payload: { playerId: setter.record.playerId! },
    });
    await execute(service, setter, {
      id: "a1",
      type: "ccb.game.setAnswer",
      payload: { characterId: 1 },
    });
    // 唯一参战者首猜即中 → 大赢家 2 + 12 = 14，出题人被扣 floor(14 / 2) = 7。
    await execute(service, guesser, {
      id: "g1",
      type: "ccb.game.guess",
      payload: { characterId: 1 },
    });

    expect(scoreOf(guesser)).toBe(14);
    expect(scoreOf(setter)).toBe(-7);
    // 房主既没出题也没猜，一分不动。
    expect(scoreOf(host)).toBe(0);
  });

  test("服务端出题不结算出题人分（房主不被凭空扣分）", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const guest = connection(service, "c-guest");
    await startGame(service, host, [guest]);

    // 首猜即中会触发「纯在送分」那档扣分，但本局是服务端抽的题，房主不该被扣。
    await execute(service, guest, { id: "g1", type: "ccb.game.guess", payload: { characterId: 1 } });
    expect(scoreOf(guest)).toBe(14);
    expect(scoreOf(host)).toBe(0);
  });

  test("出题人被踢出后房间退回等待，不会卡在出题阶段", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const setter = connection(service, "c-setter");
    const other = connection(service, "c-other");
    await prepareRoom(service, host, [setter, other]);

    await execute(service, host, {
      id: "pick",
      type: "ccb.game.chooseSetter",
      payload: { playerId: setter.record.playerId! },
    });
    await execute(service, host, {
      id: "kick",
      type: "ccb.room.kick",
      payload: { playerId: setter.record.playerId! },
    });

    expect(snapshotOf(host).phase).toBe("waiting");
    expect(snapshotOf(host).answerSetterPlayerId).toBeUndefined();
    // 退回等待后房主可以重新开局
    expect(privateStateOf(host).canStartRound).toBe(true);
  });

  test("同步模式：本轮所有胜者共享首个胜者的分数", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const first = connection(service, "c-first");
    const second = connection(service, "c-second");
    await startGame(service, host, [first, second], { mode: "sync", maxAttempts: 10 });

    // 甲三次尝试（❌💡 / ❌ / ✔）、乙两次（❌ / ❌ / ✔）—— 同一轮内两人都猜中。
    await execute(service, first, { id: "a1", type: "ccb.game.guess", payload: { characterId: 2 } });
    await execute(service, second, { id: "b1", type: "ccb.game.guess", payload: { characterId: 3 } });
    await execute(service, first, { id: "a2", type: "ccb.game.guess", payload: { characterId: 4 } });
    await execute(service, second, { id: "b2", type: "ccb.game.guess", payload: { characterId: 4 } });
    await execute(service, first, { id: "a3", type: "ccb.game.guess", payload: { characterId: 1 } });
    await execute(service, second, { id: "b3", type: "ccb.game.guess", payload: { characterId: 1 } });

    expect(snapshotOf(first).phase).toBe("settled");
    // 首个胜者是甲（4 次尝试 → 2 + 1 = 3）。若各算各的，乙（3 次）会拿到 4 分。
    expect(scoreOf(first)).toBe(3);
    expect(scoreOf(second)).toBe(3);
  });
});

describe("CCB 对局：队伍、提示与观战", () => {
  test("队伍共享标记与次数：任一成员耗尽即全队 💀", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const first = connection(service, "c-a");
    const second = connection(service, "c-b");
    await prepareRoom(service, host, [first, second], { maxAttempts: 1 });
    await setTeam(service, first, 1);
    await setTeam(service, second, 1);
    await execute(service, host, { id: "start", type: "ccb.game.start", payload: {} });

    // 一次「猜错且沾边」按原版口径算 2 次，maxAttempts=1 → 全队一起 💀。
    await execute(service, first, { id: "g1", type: "ccb.game.guess", payload: { characterId: 2 } });

    const expected = CCB_ATTEMPT_MARKS.wrong + CCB_ATTEMPT_MARKS.partial + CCB_END_MARK.dead;
    expect(viewOf(first).marks).toBe(expected);
    expect(viewOf(second).marks).toBe(expected);
    expect(viewOf(second).finished).toBe(true);
    expect(privateStateOf(second).canGuess).toBe(false);
    expect(privateStateOf(second).remainingGuesses).toBe(0);
  });

  test("队伍猜对：队友记 🏆（teamwin），普通模式只给真正猜中的人计分", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const first = connection(service, "c-a");
    const second = connection(service, "c-b");
    await prepareRoom(service, host, [first, second]);
    await setTeam(service, first, 1);
    await setTeam(service, second, 1);
    await execute(service, host, { id: "start", type: "ccb.game.start", payload: {} });

    await execute(service, first, { id: "g1", type: "ccb.game.guess", payload: { characterId: 1 } });

    expect(snapshotOf(first).phase).toBe("settled");
    // 首猜即中 👑 → 2 + 12
    expect(scoreOf(first)).toBe(14);
    // 队友 **不进胜者集合**（原版 actualWinners 只装真正猜中的人）：只留下 🏆 与 0 分。
    expect(scoreOf(second)).toBe(0);
    expect(viewOf(second).marks).toContain(CCB_END_MARK.teamWin);
    expect(viewOf(second).finished).toBe(true);
  });

  test("同步模式：队友一起进胜者集合并共享胜者分", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const first = connection(service, "c-a");
    const second = connection(service, "c-b");
    await prepareRoom(service, host, [first, second], { mode: "sync" });
    await setTeam(service, first, 1);
    await setTeam(service, second, 1);
    await execute(service, host, { id: "start", type: "ccb.game.start", payload: {} });

    await execute(service, first, { id: "g1", type: "ccb.game.guess", payload: { characterId: 1 } });

    // 队友也被结束 → 参战玩家归零 → 结算，两人共享同一份胜者分。
    expect(snapshotOf(first).phase).toBe("settled");
    expect(scoreOf(first)).toBe(14);
    expect(scoreOf(second)).toBe(14);
  });

  test("开局后不能改队伍", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const guest = connection(service, "c-guest");
    await prepareRoom(service, host, [guest]);
    await execute(service, host, { id: "start", type: "ccb.game.start", payload: {} });

    await expect(setTeam(service, guest, 2)).rejects.toMatchObject({ code: "INVALID_PHASE" });
  });

  test("手动出题给的提示按剩余次数逐条解锁", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const setter = connection(service, "c-setter");
    const guesser = connection(service, "c-guesser");
    await prepareRoom(service, host, [setter, guesser], {
      useHints: [2, 1],
      maxAttempts: 3,
    });
    await execute(service, host, {
      id: "pick",
      type: "ccb.game.chooseSetter",
      payload: { playerId: setter.record.playerId! },
    });
    await execute(service, setter, {
      id: "a1",
      type: "ccb.game.setAnswer",
      payload: { characterId: 1, hints: ["提示甲", "提示乙"] },
    });

    // 剩余 3 次，还没到任何阈值
    expect(privateStateOf(guesser).hints).toEqual([]);

    // 猜错但沾边 = 2 次 → 剩余 1 次 → 两条阈值同时命中
    await execute(service, guesser, {
      id: "g1",
      type: "ccb.game.guess",
      payload: { characterId: 2 },
    });
    expect(privateStateOf(guesser).hints).toEqual([
      { index: 1, text: "提示甲" },
      { index: 2, text: "提示乙" },
    ]);
    // 提示只发给参赛玩家：出题人不猜，拿到也没意义。
    expect(privateStateOf(setter).hints).toEqual([]);
  });

  test("观战者与出题人能看到全场猜测明细，参赛玩家只看得到自己的", async () => {
    const { service } = createService();
    const host = connection(service, "c-host");
    const guest = connection(service, "c-guest");
    const watcher = connection(service, "c-watcher");
    await prepareRoom(service, host, [guest, watcher]);
    await execute(service, watcher, {
      id: "spec",
      type: "ccb.player.setSpectator",
      payload: { spectator: true },
    });
    await execute(service, host, { id: "start", type: "ccb.game.start", payload: {} });
    await execute(service, guest, {
      id: "g1",
      type: "ccb.game.guess",
      payload: { characterId: 2 },
    });

    const rows = privateStateOf(watcher).spectatedGuesses;
    expect(rows?.map((row) => row.playerId)).toEqual([guest.record.playerId!]);
    expect(rows?.[0]?.guesses).toHaveLength(1);
    expect(rows?.[0]?.marks).toBe(CCB_ATTEMPT_MARKS.wrong + CCB_ATTEMPT_MARKS.partial);

    // 出题人同样不参赛，也拿得到；参赛玩家则永远看不到别人的反馈。
    expect(privateStateOf(host).spectatedGuesses).toBeDefined();
    expect(privateStateOf(guest).spectatedGuesses).toBeUndefined();
  });
});

describe("CCB 对局：角色使用率旁路上报", () => {
  const createServiceWithStats = (options: { failing?: boolean } = {}) => {
    const calls: Array<{ kind: string; id: number; name: string }> = [];
    let currentTime = Date.UTC(2026, 8, 17, 0, 0, 0);
    const service = new CCBService({
      now: () => currentTime,
      characters: characterSource,
      stats: {
        report: (kind, character) => {
          if (options.failing) return Promise.reject(new Error("原版服务器挂了"));
          calls.push({ kind, id: character.id, name: character.name });
          return Promise.resolve();
        },
      },
    });
    return { service, calls };
  };

  test("开局上报出题角色，每次被接受的猜测上报一次", async () => {
    const { service, calls } = createServiceWithStats();
    const host = connection(service, "c-host");
    const guest = connection(service, "c-guest");
    await startGame(service, host, [guest]);

    // 两级采样固定抽到 1 号角色（夹具的 pickRandomCharacter 返回 1）
    expect(calls).toEqual([{ kind: "answer", id: 1, name: "中文-1" }]);

    await execute(service, guest, { id: "g1", type: "ccb.game.guess", payload: { characterId: 2 } });
    expect(calls).toEqual([
      { kind: "answer", id: 1, name: "中文-1" },
      { kind: "guess", id: 2, name: "中文-2" },
    ]);
  });

  test("被拒的猜测不上报", async () => {
    const { service, calls } = createServiceWithStats();
    const host = connection(service, "c-host");
    const guest = connection(service, "c-guest");
    await startGame(service, host, [guest]);

    await execute(service, guest, { id: "g1", type: "ccb.game.guess", payload: { characterId: 2 } });
    // 同一个角色再猜一次会被拒 —— 拒绝发生在构造 record 之前，所以不该多出一条上报。
    await expect(
      execute(service, guest, { id: "g2", type: "ccb.game.guess", payload: { characterId: 2 } }),
    ).rejects.toMatchObject({ code: "CHARACTER_ALREADY_PICKED" });

    expect(calls.filter((call) => call.kind === "guess")).toHaveLength(1);
  });

  test("上报抛异常不影响对局推进", async () => {
    const { service } = createServiceWithStats({ failing: true });
    const host = connection(service, "c-host");
    const guest = connection(service, "c-guest");
    await startGame(service, host, [guest]);

    await execute(service, guest, { id: "g1", type: "ccb.game.guess", payload: { characterId: 1 } });
    expect(snapshotOf(guest).phase).toBe("settled");
    expect(scoreOf(guest)).toBe(14);
  });
});
