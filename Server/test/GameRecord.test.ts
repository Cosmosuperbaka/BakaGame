import { describe, expect, test } from "bun:test";

import { GAME_RECORD_RETENTION_MS, GameRecordService } from "../src/application/GameRecordService";
import type { GameRecorder, GameRoundRecord } from "../src/domain/GameRecord";
import { ROOM_ID_TEST_MODE } from "../src/domain/Model";
import { EventLogger } from "../src/infrastructure/EventLogger";
import type {
  GameDailyCount,
  GameRecordFilter,
  GameRecordListItem,
  GameRecordRepository,
  StoredGameRecord,
} from "../src/infrastructure/db/GameRecordRepository";
import { ceeTestHarness } from "./CEENativeFixtures";
import { createConnection, createTestContext, execute } from "./Helpers";

/** 仅测试使用的内存仓储。 */
class MemoryGameRecordRepository implements GameRecordRepository {
  readonly rows: StoredGameRecord[] = [];
  failNext = false;

  async insert(record: StoredGameRecord): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("db down");
    }
    this.rows.push(structuredClone(record));
  }

  async purge(before: Date, batch: number): Promise<number> {
    const expired = this.rows.filter((row) => row.endedAt < before).slice(0, batch);
    for (const row of expired) this.rows.splice(this.rows.indexOf(row), 1);
    return expired.length;
  }

  async list(filter: GameRecordFilter): Promise<{ items: GameRecordListItem[]; total: number }> {
    const matched = this.rows.filter((row) => !filter.game || row.game === filter.game);
    return { items: matched.slice(filter.offset, filter.offset + filter.limit), total: matched.length };
  }

  async get(id: string): Promise<StoredGameRecord | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async dailyCounts(): Promise<GameDailyCount[]> {
    return [];
  }
}

const capture = () => {
  const records: GameRoundRecord[] = [];
  const recorder: GameRecorder = { record: (round) => records.push(structuredClone(round)) };
  return { records, recorder };
};

const round = (overrides: Partial<GameRoundRecord> = {}): GameRoundRecord => ({
  game: "faker", roomId: "1234", roundNumber: 1, startedAt: 1_000, endedAt: 2_000,
  players: [{ playerId: "p1", userId: null, name: "玩家", score: 1 }], summary: { winner: "good" }, timeline: [],
  ...overrides,
});

describe("GameRecordService", () => {
  test("异步落库，写入失败只记日志不抛出", async () => {
    const repository = new MemoryGameRecordRepository();
    const logs: string[] = [];
    const service = new GameRecordService({ repository, logger: new EventLogger((message) => logs.push(message)) });
    repository.failNext = true;
    expect(() => service.record(round())).not.toThrow();
    service.record(round({ roundNumber: 2, players: [{ playerId: "p1", userId: "u1", name: "名".repeat(80), score: 0 }] }));
    await service.close();
    expect(repository.rows.map((row) => row.roundNumber)).toEqual([2]);
    expect([...repository.rows[0]!.players[0]!.name]).toHaveLength(64);
    expect(logs.some((message) => message.includes("对局记录写入失败"))).toBe(true);
  });

  test("超长时间线保留前段并追加截断标记", async () => {
    const repository = new MemoryGameRecordRepository();
    const service = new GameRecordService({ repository, logger: new EventLogger(() => {}) });
    const timeline = Array.from({ length: 2000 }, (_, index) => ({ at: index, type: "description", text: "字".repeat(30) }));
    service.record(round({ timeline }));
    await service.close();
    const stored = repository.rows[0]!.timeline;
    expect(new TextEncoder().encode(JSON.stringify(stored)).byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(stored.at(-1)).toMatchObject({ type: "truncated", omitted: 2000 - (stored.length - 1) });
    expect(stored[0]).toEqual(timeline[0]!);
  });

  test("清理只删除超过 7 天的记录并分批删完", async () => {
    const now = Date.parse("2026-10-20T00:00:00Z");
    const repository = new MemoryGameRecordRepository();
    const service = new GameRecordService({ repository, logger: new EventLogger(() => {}), now: () => now });
    for (let index = 0; index < 1203; index += 1) {
      repository.rows.push({ id: `old-${index}`, game: "song", roomId: "1", roundNumber: index, startedAt: new Date(0),
        endedAt: new Date(now - GAME_RECORD_RETENTION_MS - 1), players: [], summary: {}, timeline: [] });
    }
    repository.rows.push({ id: "fresh", game: "song", roomId: "1", roundNumber: 0, startedAt: new Date(0),
      endedAt: new Date(now - GAME_RECORD_RETENTION_MS + 60_000), players: [], summary: {}, timeline: [] });
    expect(await service.purge()).toBe(1203);
    expect(repository.rows.map((row) => row.id)).toEqual(["fresh"]);
  });
});

describe("各游戏结算写入对局记录", () => {
  test("谁是卧底：结算一次记一条，带胜负、词对与本轮得分", async () => {
    const { records, recorder } = capture();
    const { service, advanceTime } = createTestContext({ gameRecorder: recorder });
    const host = createConnection(service, "record-host");
    await execute(service, host, { id: "create", type: "room.create", payload: {
      roomId: ROOM_ID_TEST_MODE, name: "记录房", visibility: "public", allowSpectators: true, userName: "房主",
    } });
    await execute(service, host, { id: "bots", type: "test.addBot", payload: { count: 4 } });
    advanceTime(5_000);
    await execute(service, host, { id: "over", type: "test.jumpToPhase", payload: { phase: "gameOver" } });

    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record).toMatchObject({ game: "faker", roomId: ROOM_ID_TEST_MODE, roundNumber: 1, summary: { winner: "good", reason: "手动结束本局" } });
    expect(record!.players.length).toBeGreaterThanOrEqual(4);
    expect(record!.players.every((player) => player.userId === null)).toBe(true);
    expect(record!.endedAt).toBeGreaterThanOrEqual(record!.startedAt);
    const roles = record!.summary.roles as Array<{ name: string; role: string }>;
    expect(roles.length).toBe(record!.players.length);
  });

  test("猜猜呗增强房：结算后多次发布只记一条，记录登录玩家账号", async () => {
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
    expect(record).toMatchObject({ game: "cee", roomId: "1234", roundNumber: 1, summary: { answer: { id: 1 } } });
    expect(record!.players.find((player) => player.name === "玩家")?.userId).toBe("user-guest");
    expect(record!.timeline.map((event) => event.type)).toEqual(["guess", "guess"]);
    expect(record!.timeline.at(-1)).toMatchObject({ name: "房主", correct: true });
  });
});
