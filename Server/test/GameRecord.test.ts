import { describe, expect, test } from "bun:test";

import { GameRecordService } from "../src/application/GameRecordService";
import {
  skipTestRooms,
  type GameRecorder,
  type GameRoomEnd,
  type GameRoundRecord,
} from "../src/domain/GameRecord";
import { SonGuessrService } from "../src/application/SonGuessrService";
import { createTestRoomPolicy } from "../src/domain/TestRooms";
import { ROOM_ID_TEST_MODE, type SonGuessrPrivateState } from "../src/shared/Index";
import { EventLogger } from "../src/infrastructure/EventLogger";
import type {
  GameDailyCount,
  GameRecordFilter,
  GameRecordListItem,
  GameRecordRepository,
  StoredGameRecord,
  StoredGameRecordDetail,
  StoredGameRecordRound,
} from "../src/infrastructure/db/GameRecordRepository";
import { ceeTestHarness } from "./CEENativeFixtures";
import { createConnection, createTestContext, execute } from "./Helpers";
import { TEST_ROOMS_ON } from "./TestRoomPolicy";
import {
  connection as songConnection,
  createRoom as createSongRoom,
  execute as songExecute,
  lastEvent as songLastEvent,
  provider as songProvider,
} from "./songuessr/Fixtures";

/** 仅测试使用的内存仓储：按房间聚合行 + 回合行还原真实读写。 */
class MemoryGameRecordRepository implements GameRecordRepository {
  readonly rows = new Map<string, StoredGameRecordDetail>();
  failNext = false;

  async save(record: StoredGameRecord, round?: StoredGameRecordRound): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("db down");
    }
    const existing = this.rows.get(record.id);
    const detail: StoredGameRecordDetail = {
      ...structuredClone(record),
      rounds: existing ? existing.rounds : [],
    };
    this.rows.set(record.id, detail);
    if (!round) return;
    const copy = structuredClone(round);
    const index = detail.rounds.findIndex((item) => item.number === round.number);
    if (index >= 0) detail.rounds[index] = copy;
    else detail.rounds.push(copy);
    detail.rounds.sort((left, right) => left.number - right.number);
  }

  async list(filter: GameRecordFilter): Promise<{ items: GameRecordListItem[]; total: number }> {
    const matched = [...this.rows.values()]
      .filter((row) => !filter.game || row.game === filter.game)
      .sort((left, right) => right.endedAt.getTime() - left.endedAt.getTime());
    return {
      items: matched.slice(filter.offset, filter.offset + filter.limit),
      total: matched.length,
    };
  }

  async get(id: string): Promise<StoredGameRecordDetail | null> {
    return this.rows.get(id) ?? null;
  }

  async dailyCounts(): Promise<GameDailyCount[]> {
    return [];
  }
}

const capture = () => {
  const records: GameRoundRecord[] = [];
  const finishes: GameRoomEnd[] = [];
  const recorder: GameRecorder = {
    record: (round) => records.push(structuredClone(round)),
    finishRoom: (room) => finishes.push(structuredClone(room)),
  };
  return { records, finishes, recorder };
};

const ROOM_CREATED_AT = 500;
const round = (overrides: Partial<GameRoundRecord> = {}): GameRoundRecord => ({
  game: "faker",
  roomId: "1234",
  roomCreatedAt: ROOM_CREATED_AT,
  roundNumber: 1,
  startedAt: 1_000,
  endedAt: 2_000,
  players: [{ playerId: "p1", userId: null, name: "玩家", score: 1 }],
  summary: { winner: "good" },
  timeline: [],
  ...overrides,
});

const only = (repository: MemoryGameRecordRepository) => [...repository.rows.values()][0]!;

describe("GameRecordService", () => {
  test("同一房间的回合聚合成一局，玩家分数累计", async () => {
    const repository = new MemoryGameRecordRepository();
    const service = new GameRecordService({ repository, logger: new EventLogger(() => {}) });
    service.record(
      round({ players: [{ playerId: "p1", userId: null, name: "甲".repeat(80), score: 3 }] })
    );
    service.record(
      round({
        roundNumber: 2,
        endedAt: 3_000,
        players: [
          { playerId: "p1", userId: "u-1", name: "甲".repeat(80), score: 2 },
          { playerId: "p2", userId: null, name: "乙", score: 1 },
        ],
      })
    );
    service.finishRoom({
      game: "faker",
      roomId: "1234",
      roomCreatedAt: ROOM_CREATED_AT,
      endedAt: 5_000,
    });
    await service.close();

    expect(repository.rows.size).toBe(1);
    const stored = only(repository);
    expect(stored.roundCount).toBe(2);
    expect(stored.startedAt.getTime()).toBe(ROOM_CREATED_AT);
    expect(stored.endedAt.getTime()).toBe(5_000);
    expect(stored.rounds.map((item) => item.number)).toEqual([1, 2]);
    expect(stored.rounds[1]!.players.map((player) => player.score)).toEqual([2, 1]);
    const players = new Map(stored.players.map((player) => [player.playerId, player]));
    expect(players.get("p1")).toMatchObject({ name: "甲".repeat(64), score: 5, userId: "u-1" });
    expect(players.get("p2")).toMatchObject({ score: 1 });
  });

  test("写入失败只记日志不抛出，后续回合照常落库", async () => {
    const repository = new MemoryGameRecordRepository();
    const logs: string[] = [];
    const service = new GameRecordService({
      repository,
      logger: new EventLogger((message) => logs.push(message)),
    });
    repository.failNext = true;
    expect(() => service.record(round())).not.toThrow();
    service.record(
      round({
        roundNumber: 2,
        players: [{ playerId: "p1", userId: "u1", name: "名".repeat(80), score: 0 }],
      })
    );
    await service.close();

    expect(repository.rows.size).toBe(1);
    expect(only(repository).rounds.map((item) => item.number)).toEqual([2]);
    expect([...only(repository).players[0]!.name]).toHaveLength(64);
    expect(logs.some((message) => message.includes("对局记录写入失败"))).toBe(true);
  });

  test("单回合时间线超长时保留前段并追加截断标记", async () => {
    const repository = new MemoryGameRecordRepository();
    const service = new GameRecordService({ repository, logger: new EventLogger(() => {}) });
    const timeline = Array.from({ length: 2_000 }, (_, index) => ({
      at: index,
      type: "description",
      text: "字".repeat(30),
    }));
    service.record(round({ timeline }));
    await service.close();

    const stored = only(repository).rounds[0]!.timeline;
    expect(new TextEncoder().encode(JSON.stringify(stored)).byteLength).toBeLessThanOrEqual(
      64 * 1024
    );
    expect(stored.at(-1)).toMatchObject({
      type: "truncated",
      omitted: 2_000 - (stored.length - 1),
    });
    expect(stored[0]).toEqual(timeline[0]!);
  });

  test("房间销毁后迟到的回合不会再开一局，重复回合只记一次", async () => {
    const repository = new MemoryGameRecordRepository();
    const logs: string[] = [];
    const service = new GameRecordService({
      repository,
      logger: new EventLogger((message) => logs.push(message)),
    });
    service.record(round());
    service.record(round());
    service.finishRoom({
      game: "faker",
      roomId: "1234",
      roomCreatedAt: ROOM_CREATED_AT,
      endedAt: 3_000,
    });
    await service.close();
    service.record(round({ roundNumber: 2, endedAt: 4_000 }));
    await service.close();

    expect(repository.rows.size).toBe(1);
    expect(only(repository).rounds).toHaveLength(1);
    expect(only(repository).endedAt.getTime()).toBe(3_000);
    expect(logs.some((message) => message.includes("重复的回合记录"))).toBe(true);
    expect(logs.some((message) => message.includes("房间已结束"))).toBe(true);
  });

  test("一回合都没打的房间不落空记录", async () => {
    const repository = new MemoryGameRecordRepository();
    const service = new GameRecordService({ repository, logger: new EventLogger(() => {}) });
    service.finishRoom({ game: "song", roomId: "9999", roomCreatedAt: 100, endedAt: 200 });
    await service.close();
    expect(repository.rows.size).toBe(0);
  });
});

describe("各游戏结算写入对局记录", () => {
  test("谁是卧底：结算一次记一个回合，带胜负、词对与本回合得分；关房时收尾同一局", async () => {
    const { records, finishes, recorder } = capture();
    const { service, advanceTime } = createTestContext({ gameRecorder: recorder });
    const roomId = "8920";
    const host = createConnection(service, "record-host");
    await execute(service, host, {
      id: "create",
      type: "room.create",
      payload: {
        roomId,
        name: "记录房",
        visibility: "public",
        allowSpectators: true,
        userName: "房主",
      },
    });
    // 普通房走真实开局：房主出题，其余四人参赛，出题人中止离场时当场结算。
    const players = [];
    for (let index = 0; index < 4; index += 1) {
      const player = createConnection(service, `record-player-${index}`);
      await execute(service, player, {
        id: `join-${index}`,
        type: "room.join",
        roomId,
        payload: { userName: `玩家${index}` },
      });
      players.push(player);
    }
    for (const [index, player] of [host, ...players].entries()) {
      await execute(service, player, {
        id: `ready-${index}`,
        type: "player.setReady",
        payload: { ready: true },
      });
    }
    await execute(service, host, { id: "advance", type: "game.advancePhase", payload: {} });
    await execute(service, host, {
      id: "questioner",
      type: "game.assignQuestioner",
      payload: { playerId: host.record.playerId! },
    });
    await execute(service, host, {
      id: "words",
      type: "game.submitWords",
      payload: { words: ["苹果", "香蕉"] },
    });
    advanceTime(5_000);
    await execute(service, host, { id: "leave", type: "room.leave", payload: {} });

    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record).toMatchObject({
      game: "faker",
      roomId,
      roundNumber: 1,
      roomCreatedAt: Date.UTC(2026, 3, 10),
    });
    expect(record!.players.length).toBeGreaterThanOrEqual(4);
    expect(record!.players.every((player) => player.userId === null)).toBe(true);
    expect(record!.endedAt).toBeGreaterThanOrEqual(record!.startedAt);
    const roles = record!.summary.roles as Array<{ name: string; role: string }>;
    expect(roles.length).toBe(record!.players.length);

    await service.adminCloseRoom(roomId);
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({
      game: "faker",
      roomId,
      roomCreatedAt: Date.UTC(2026, 3, 10),
    });
    expect(finishes[0]!.endedAt).toBeGreaterThanOrEqual(record!.endedAt);
  });

  test("猜猜呗增强房：结算后多次发布只记一个回合，记录登录玩家账号", async () => {
    const { records, recorder } = capture();
    const h = ceeTestHarness({}, undefined, { gameRecorder: recorder });
    const host = await h.create();
    const guest = h.connect("玩家");
    guest.record.account = { userId: "user-guest", image: null };
    await h.send(guest, "cee.room.join", { userName: "玩家" });
    await h.ready(guest);
    await h.send(host, "cee.game.start", {});
    await h.guess(guest, 2);
    await h.guess(host, 1);
    expect(h.snapshot(host).phase).toBe("settled");
    await h.send(host, "cee.chat.send", { text: "结算后聊天" });
    h.advance(1_000);

    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record).toMatchObject({
      game: "cee",
      roomId: "1234",
      roundNumber: 1,
      summary: { answer: { id: 1 } },
    });
    expect(record!.roomCreatedAt).toBeLessThanOrEqual(record!.startedAt);
    expect(record!.players.find((player) => player.name === "玩家")?.userId).toBe("user-guest");
    expect(record!.timeline.map((event) => event.type)).toEqual(["guess", "guess"]);
    expect(record!.timeline.at(-1)).toMatchObject({ name: "房主", correct: true });
  });
});

describe("测试房不写对局记录", () => {
  test("包装器：测试房的回合与关房收尾被丢弃，普通房原样透传，开关关闭后同号房照常记录", () => {
    const { records, finishes, recorder } = capture();
    let enabled = true;
    const wrapped = skipTestRooms(
      recorder,
      createTestRoomPolicy(() => enabled)
    );
    wrapped.record(round({ roomId: ROOM_ID_TEST_MODE }));
    wrapped.record(round({ roomId: ROOM_ID_TEST_MODE.toLowerCase() }));
    wrapped.finishRoom({ game: "song", roomId: ROOM_ID_TEST_MODE, roomCreatedAt: 1, endedAt: 2 });
    expect(records).toHaveLength(0);
    expect(finishes).toHaveLength(0);

    wrapped.record(round({ roomId: "1234" }));
    wrapped.finishRoom({ game: "song", roomId: "1234", roomCreatedAt: 1, endedAt: 2 });
    expect(records).toHaveLength(1);
    expect(finishes).toHaveLength(1);

    // 策略关闭时没有测试房，同号房按普通房记录。
    enabled = false;
    wrapped.record(round({ roomId: ROOM_ID_TEST_MODE }));
    expect(records).toHaveLength(2);
  });

  test("谁是卧底：测试房结算与关房后记录器没有被调用", async () => {
    const { records, finishes, recorder } = capture();
    const { service, advanceTime } = createTestContext({
      gameRecorder: skipTestRooms(recorder, TEST_ROOMS_ON),
    });
    const host = createConnection(service, "record-host");
    await execute(service, host, {
      id: "create",
      type: "room.create",
      payload: {
        roomId: ROOM_ID_TEST_MODE,
        name: "记录房",
        visibility: "public",
        allowSpectators: true,
        userName: "房主",
      },
    });
    await execute(service, host, { id: "bots", type: "test.addBot", payload: { count: 4 } });
    advanceTime(5_000);
    await execute(service, host, {
      id: "over",
      type: "test.jumpToPhase",
      payload: { phase: "gameOver" },
    });
    await service.adminCloseRoom(ROOM_ID_TEST_MODE);
    expect(records).toHaveLength(0);
    expect(finishes).toHaveLength(0);
  });

  test("猜歌：测试房结算与关房后记录器没有被调用，同一流程的普通房照常记录", async () => {
    const play = async (roomId: string) => {
      const { records, finishes, recorder } = capture();
      const service = new SonGuessrService({
        musicProvider: songProvider,
        random: { nextInt: () => 0 },
        gameRecorder: skipTestRooms(recorder, TEST_ROOMS_ON),
        testRooms: TEST_ROOMS_ON,
      });
      const host = songConnection(service, "host");
      await createSongRoom(service, host, { roomId });
      const hostId = songLastEvent<SonGuessrPrivateState>(host, "song.game.privateState").playerId;
      // 测试房的出题人自己猜，普通房由另一名玩家猜；都走到本回合结算。
      let guesser = host;
      if (roomId === ROOM_ID_TEST_MODE) {
        await songExecute(service, host, {
          id: "bot",
          type: "song.test.addBot",
          roomId,
          payload: { count: 1 },
        });
      } else {
        guesser = songConnection(service, "guest");
        await songExecute(service, guesser, {
          id: "join",
          type: "song.room.join",
          roomId,
          payload: { userName: "玩家" },
        });
        await songExecute(service, guesser, {
          id: "ready",
          type: "song.player.setReady",
          roomId,
          payload: { ready: true },
        });
      }
      await songExecute(service, host, {
        id: "start",
        type: "song.game.start",
        roomId,
        payload: {},
      });
      await songExecute(service, host, {
        id: "choose",
        type: "song.game.chooseSubmitter",
        roomId,
        payload: { playerId: hostId },
      });
      await songExecute(service, host, {
        id: "submit",
        type: "song.game.submitSong",
        roomId,
        payload: { songId: "answer" },
      });
      await songExecute(service, guesser, {
        id: "audio",
        type: "song.game.audioReady",
        roomId,
        payload: { roundNumber: 1 },
      });
      await songExecute(service, guesser, {
        id: "guess",
        type: "song.game.guess",
        roomId,
        payload: { songId: "answer" },
      });
      await service.adminCloseRoom(roomId);
      return { records, finishes };
    };

    const plain = await play("1234");
    expect(plain.records).toHaveLength(1);
    expect(plain.records[0]).toMatchObject({ game: "song", roomId: "1234" });
    expect(plain.finishes).toHaveLength(1);

    const test = await play(ROOM_ID_TEST_MODE);
    expect(test.records).toHaveLength(0);
    expect(test.finishes).toHaveLength(0);
  });

  test("猜猜呗增强房：测试房结算与关房后记录器没有被调用", async () => {
    const { records, finishes, recorder } = capture();
    const h = ceeTestHarness({}, undefined, {
      roomId: ROOM_ID_TEST_MODE,
      gameRecorder: skipTestRooms(recorder, TEST_ROOMS_ON),
    });
    try {
      const host = await h.create();
      await h.configure(host, {});
      await h.send(host, "cee.game.start", {});
      await h.guess(host, 1);
      expect(h.snapshot(host).phase).toBe("settled");
      h.advance(1_000);
      h.service.adminCloseRoom(ROOM_ID_TEST_MODE);
      expect(records).toHaveLength(0);
      expect(finishes).toHaveLength(0);
    } finally {
      h.service.close();
    }
  });
});
