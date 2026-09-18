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
