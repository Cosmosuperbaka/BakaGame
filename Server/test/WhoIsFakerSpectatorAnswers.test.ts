import { expect, test } from "bun:test";

import type {
  WhoIsFakerPrivateState,
  WhoIsFakerRoomSnapshot,
  WhoIsFakerRole,
} from "../src/shared/Index";

import {
  createConnection,
  createTestContext,
  execute,
  getLastEventPayload,
  type TestConnection,
} from "./Helpers";

// F10：旁观者的上帝视角与「允许旁观」正交，由 spectatorsSeeAnswers 单独决定。
// 局中关闭时旁观者拿不到双侧答案与全员身份；结算后答案照常公开。

const CIVILIAN_WORD = "苹果";
const UNDERCOVER_WORD = "香蕉";

interface Seat {
  connection: TestConnection;
  playerId: string;
}

type Service = ReturnType<typeof createTestContext>["service"];

const joinSeat = async (service: Service, roomId: string, index: number): Promise<Seat> => {
  const connection = createConnection(service, `${roomId}-seat-${index}`);
  const result = (await execute(service, connection, {
    id: `${roomId}-join-${index}`,
    type: "room.join",
    roomId,
    payload: { userName: `玩家${index}` },
  })) as { playerId: string };
  return { connection, playerId: result.playerId };
};

/**
 * 真实走到第 1 天描述阶段：房主 + 4 名玩家，玩家 3 是出题人，玩家 0 固定是卧底，
 * 最后一条连接在局中加入，因此只能是旁观者。
 */
const startRound = async (spectatorsSeeAnswers?: boolean) => {
  const { service } = createTestContext();
  const roomId = "7310";
  const hostConnection = createConnection(service, `${roomId}-host`);
  const created = (await execute(service, hostConnection, {
    id: "create",
    type: "room.create",
    payload: {
      roomId,
      name: "旁观答案开关",
      visibility: "public",
      allowSpectators: true,
      userName: "房主",
    },
  })) as { playerId: string };
  const host: Seat = { connection: hostConnection, playerId: created.playerId };
  const seats: Seat[] = [];
  for (let index = 0; index < 4; index += 1) {
    seats.push(await joinSeat(service, roomId, index));
  }
  const questioner = seats[3];
  const undercover = seats[0];

  await execute(service, host.connection, {
    id: "settings",
    type: "room.updateSettings",
    payload: {
      roleConfig: { undercoverCount: 1, hasAngel: false, hasBlank: false },
      ...(spectatorsSeeAnswers === undefined ? {} : { spectatorsSeeAnswers }),
    },
  });

  for (const seat of [host, ...seats]) {
    await execute(service, seat.connection, {
      id: `ready-${seat.playerId}`,
      type: "player.setReady",
      payload: { ready: true },
    });
  }
  await execute(service, host.connection, {
    id: "start",
    type: "game.advancePhase",
    payload: {},
  });
  await execute(service, host.connection, {
    id: "assign",
    type: "game.assignQuestioner",
    payload: { playerId: questioner.playerId },
  });

  const manualRoles: Record<string, WhoIsFakerRole> = {
    [host.playerId]: "civilian",
    [undercover.playerId]: "undercover",
    [seats[1].playerId]: "civilian",
    [seats[2].playerId]: "civilian",
  };
  await execute(service, questioner.connection, {
    id: "words",
    type: "game.submitWords",
    payload: { words: [CIVILIAN_WORD, UNDERCOVER_WORD], manualRoles },
  });

  // 局中加入：拿到的是旁观者席位，而不是正式席位。
  const spectator = await joinSeat(service, roomId, 9);
  const snapshotOf = (seat: Seat) =>
    getLastEventPayload<WhoIsFakerRoomSnapshot>(seat.connection, "room.snapshot")!;
  const privateStateOf = (seat: Seat) =>
    getLastEventPayload<WhoIsFakerPrivateState>(seat.connection, "game.privateState")!;
  const advance = (() => {
    let seq = 0;
    return () =>
      execute(service, questioner.connection, {
        id: `advance-${++seq}`,
        type: "game.advancePhase",
        payload: {},
      });
  })();

  /** 描述 -> 投票全票出局卧底 -> 反馈 -> 结算。 */
  const playToGameOver = async () => {
    for (const seat of [host, seats[0], seats[1], seats[2]]) {
      await execute(service, seat.connection, {
        id: `desc-${seat.playerId}`,
        type: "game.submitDescription",
        payload: { text: `${seat.playerId} 的描述` },
      });
    }
    await advance();
    for (const voter of [host, seats[1], seats[2]]) {
      await execute(service, voter.connection, {
        id: `vote-${voter.playerId}`,
        type: "game.submitVote",
        payload: { targetId: undercover.playerId },
      });
    }
    await execute(service, undercover.connection, {
      id: "vote-undercover",
      type: "game.submitVote",
      payload: { targetId: host.playerId },
    });
    await advance();
    expect(snapshotOf(host).status.phase).toBe("feedback");
    await advance();
    expect(snapshotOf(host).status.phase).toBe("gameOver");
  };

  expect(
    snapshotOf(spectator).players.find((player) => player.id === spectator.playerId)?.membership
  ).toBe("spectator");
  expect(snapshotOf(host).status.phase).toBe("description");

  return {
    service,
    host,
    seats,
    questioner,
    undercover,
    spectator,
    snapshotOf,
    privateStateOf,
    playToGameOver,
  };
};

const ANSWER_FIELDS = ["globalWords", "questionerView", "privilegedActionPreview"] as const;

test("默认关闭时旁观者局中收不到答案与全员身份，出题人视角不受影响", async () => {
  const f = await startRound();

  // 建房默认值就是关闭，且开关取值随公开快照下发给所有人。
  expect(f.snapshotOf(f.host).settings.spectatorsSeeAnswers).toBe(false);
  expect(f.privateStateOf(f.spectator).playerId).toBe(f.spectator.playerId);

  for (const field of ANSWER_FIELDS) {
    expect(f.privateStateOf(f.spectator)[field]).toBeUndefined();
  }
  const wire = JSON.stringify(f.privateStateOf(f.spectator));
  expect(wire).not.toContain(CIVILIAN_WORD);
  expect(wire).not.toContain(UNDERCOVER_WORD);

  // 出题人的上帝视角与 membership 无关，开关关闭也不收回。
  const questionerState = f.privateStateOf(f.questioner);
  expect(questionerState.globalWords).toMatchObject({
    civilianWord: CIVILIAN_WORD,
    undercoverWord: UNDERCOVER_WORD,
  });
  expect(questionerState.questionerView).toHaveLength(4);
  expect(questionerState.privilegedActionPreview).toBeDefined();

  // 普通参与者本就只看得到自己的词。
  const undercoverState = f.privateStateOf(f.undercover);
  expect(undercoverState.word).toBe(UNDERCOVER_WORD);
  expect(undercoverState.globalWords).toBeUndefined();

  await f.playToGameOver();

  // 结算后答案随公开快照全房可见，旁观者的上帝视角照常恢复。
  const settled = f.privateStateOf(f.spectator);
  expect(settled.globalWords).toMatchObject({
    civilianWord: CIVILIAN_WORD,
    undercoverWord: UNDERCOVER_WORD,
  });
  expect(settled.questionerView).toHaveLength(4);
  expect(f.snapshotOf(f.spectator).summary?.words).toMatchObject({
    civilianWord: CIVILIAN_WORD,
    undercoverWord: UNDERCOVER_WORD,
  });
  expect(
    f
      .snapshotOf(f.spectator)
      .players.filter((player) => player.roundStatus !== "spectator" && player.revealedRole)
  ).toHaveLength(4);
});

test("开关打开时旁观者局中实时收到全部答案与身份", async () => {
  const f = await startRound(true);

  expect(f.snapshotOf(f.spectator).settings.spectatorsSeeAnswers).toBe(true);
  const state = f.privateStateOf(f.spectator);
  expect(state.globalWords).toMatchObject({
    civilianWord: CIVILIAN_WORD,
    undercoverWord: UNDERCOVER_WORD,
  });
  expect(state.questionerView?.map((item) => item.role)).toContain("undercover");
  expect(state.privilegedActionPreview).toBeDefined();
});

test("开关打开也不经公共快照或参与者私有视图泄漏答案", async () => {
  const f = await startRound(true);

  // 平民座位只带自己的词：另一侧的词一旦出现在它的私有视图里就是泄漏。
  for (const seat of [f.host, f.seats[1], f.seats[2]]) {
    expect(f.privateStateOf(seat).globalWords).toBeUndefined();
    expect(f.privateStateOf(seat).questionerView).toBeUndefined();
    expect(JSON.stringify(f.privateStateOf(seat))).not.toContain(UNDERCOVER_WORD);
  }
  // 公开快照对所有连接同构，答案只在字段缺席时才算真的没下发。
  expect(JSON.stringify(f.snapshotOf(f.spectator))).not.toContain(UNDERCOVER_WORD);
});
