import { describe, expect, test } from "bun:test";

import {
  DatabaseGameRecordRepository,
  type StoredGameRecord,
  type StoredGameRecordRound,
} from "../src/infrastructure/db/GameRecordRepository";
import { createDrizzleStub, rowOf, schema, stamp, tupleOf } from "./DrizzleStub";

const T0 = Date.parse("2026-01-02T03:04:05.678Z");
const T1 = T0 + 600_000;

const players = [
  { playerId: "p1", userId: "u1", name: "小明", score: 30 },
  { playerId: "p2", userId: null, name: "游客", score: 55 },
];

const record = (overrides: Partial<StoredGameRecord> = {}): StoredGameRecord => ({
  id: "rec-1",
  game: "song",
  roomId: "1234",
  roundCount: 2,
  startedAt: new Date(T0),
  endedAt: new Date(T1),
  players,
  ...overrides,
});

const round = (overrides: Partial<StoredGameRecordRound> = {}): StoredGameRecordRound => ({
  number: 2,
  startedAt: new Date(T0 + 300_000),
  endedAt: new Date(T1),
  players: [{ playerId: "p1", userId: "u1", name: "小明", score: 30 }],
  summary: { winnerPlayerId: "p1" },
  timeline: [{ at: T0 + 300_000, type: "roundStart" }],
  ...overrides,
});

const recordRow = (overrides: Record<string, unknown> = {}) =>
  rowOf(schema.gameRecord, {
    id: "rec-1",
    game: "song",
    roomId: "1234",
    roundCount: 2,
    startedAt: stamp(T0),
    endedAt: stamp(T1),
    playerCount: 2,
    ...overrides,
  });

describe("对局记录仓储（连接桩）", () => {
  test("save 在单个事务里落聚合行、玩家与回合，写入按回合号幂等覆盖", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseGameRecordRepository(stub.database);

    await repository.save(record(), round());

    const statements = stub.queries.map((query) => query.statement);
    expect(statements[0]).toBe("begin");
    expect(statements.at(-1)).toBe("commit");
    expect(statements[1]).toContain("insert into `game_record`");
    expect(statements[1]).toContain("on duplicate key update");
    // 会话身份不随回合变化：只更新聚合态三列。
    expect(statements[1].split("on duplicate key update")[1]).toBe(
      " `round_count` = ?, `ended_at` = ?, `player_count` = ?"
    );
    expect(statements[2]).toContain("delete from `game_record_player`");
    expect(statements[3]).toContain("insert into `game_record_player`");
    expect(statements[4]).toContain("insert into `game_record_round`");

    expect(stub.queryAt(1).params.slice(0, 7)).toEqual([
      "rec-1",
      "song",
      "1234",
      2,
      stamp(T0),
      stamp(T1),
      2,
    ]);
    // 冲突时重复的三条聚合值随 on duplicate key update 再进一次占位符。
    expect(stub.queryAt(1).params.slice(7)).toEqual([2, stamp(T1), 2]);
    // 玩家行整批重写，按 (recordId, playerId) 落库。
    expect(stub.queryAt(3).params).toEqual([
      "rec-1",
      "p1",
      "u1",
      "小明",
      30,
      "rec-1",
      "p2",
      null,
      "游客",
      55,
    ]);
    const insertedRound = round();
    expect(stub.queryAt(4).params).toEqual([
      "rec-1",
      2,
      stamp(T0 + 300_000),
      stamp(T1),
      1,
      JSON.stringify(insertedRound.players),
      JSON.stringify(insertedRound.summary),
      JSON.stringify(insertedRound.timeline),
      // 冲突时整行覆盖：回合的得分增量、摘要与时间线都跟着重来一遍。
      stamp(T0 + 300_000),
      stamp(T1),
      1,
      JSON.stringify(insertedRound.players),
      JSON.stringify(insertedRound.summary),
      JSON.stringify(insertedRound.timeline),
    ]);
    expect(stub.queryAt(4).statement).toContain("on duplicate key update");
  });

  test("无回合的 save 不碰回合表，空玩家列表不发多余插入", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseGameRecordRepository(stub.database);

    await repository.save(record({ players: [] }));

    const statements = stub.queries.map((query) => query.statement);
    expect(statements).toHaveLength(4);
    expect(statements.some((sql) => sql.includes("game_record_round"))).toBe(false);
    expect(statements[2]).toContain("delete from `game_record_player`");
    expect(statements[3]).toBe("commit");
  });

  test("事务内任一步失败即回滚，不留半局数据", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseGameRecordRepository(stub.database);
    stub.reject(3, new Error("player row rejected"));

    await expect(repository.save(record(), round())).rejects.toThrow(/game_record_player/);
    expect(stub.queries.at(-1)?.statement).toBe("rollback");
  });

  test("列表按游戏/房间/时间筛选，玩家按分数倒序回填，分页与总数同条件", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseGameRecordRepository(stub.database);
    stub.reply(
      [tupleOf("rec-1", "song", "1234", 2, stamp(T0), stamp(T1))],
      [tupleOf(9)],
      [
        rowOf(schema.gameRecordPlayer, {
          recordId: "rec-1",
          playerId: "p2",
          userId: null,
          name: "游客",
          score: 55,
        }),
        rowOf(schema.gameRecordPlayer, {
          recordId: "rec-1",
          playerId: "p1",
          userId: "u1",
          name: "小明",
          score: 30,
        }),
      ]
    );

    const { items, total } = await repository.list({
      game: "song",
      roomId: "1234",
      since: new Date(T0),
      limit: 10,
      offset: 20,
    });

    expect(total).toBe(9);
    expect(items[0]).toMatchObject({ id: "rec-1", game: "song", roundCount: 2 });
    expect(items[0]?.players.map((player) => player.playerId)).toEqual(["p2", "p1"]);
    // 回填玩家时去掉外键列，玩家实体不携带 recordId。
    expect(items[0]?.players[0]).not.toHaveProperty("recordId");

    const select = stub.queryAt(0);
    expect(select.statement).toContain("order by `game_record`.`ended_at` desc");
    expect(select.params).toEqual(["song", "1234", stamp(T0), 10, 20]);
    expect(stub.queryAt(1).params).toEqual(["song", "1234", stamp(T0)]);
    expect(stub.queryAt(2).params).toEqual(["rec-1"]);
  });

  test("按账号筛选走子查询，只列该玩家参与过的局", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseGameRecordRepository(stub.database);
    stub.reply([], [tupleOf(0)], []);

    const { items, total } = await repository.list({ userId: "u1", limit: 5, offset: 20 });
    expect(items).toEqual([]);
    expect(total).toBe(0);

    const select = stub.queryAt(0);
    expect(select.statement).toContain("in (select `record_id` from `game_record_player`");
    expect(select.params).toEqual(["u1", 5, 20]);
  });

  test("详情按回合序号读回整局，缺失时返回 null 而不是空壳", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseGameRecordRepository(stub.database);
    stub.reply(
      [recordRow()],
      [
        rowOf(schema.gameRecordRound, {
          recordId: "rec-1",
          number: 1,
          startedAt: stamp(T0),
          endedAt: stamp(T0 + 300_000),
          playerCount: 1,
          players: [{ playerId: "p1", userId: "u1", name: "小明", score: 10 }],
          summary: { winnerPlayerId: "p1" },
          timeline: [{ at: T0, type: "roundStart" }],
        }),
      ],
      []
    );

    const detail = await repository.get("rec-1");
    expect(detail).toMatchObject({ id: "rec-1", roundCount: 2, players: [] });
    expect(detail?.rounds).toHaveLength(1);
    expect(detail?.rounds[0]).toMatchObject({ number: 1, summary: { winnerPlayerId: "p1" } });
    expect(detail?.rounds[0]?.startedAt.getTime()).toBe(T0);
    expect(stub.queryAt(1).statement).toContain("order by `game_record_round`.`round_number`");

    stub.reset();
    stub.reply([]);
    expect(await repository.get("missing")).toBeNull();
    // 主行缺失时不再去读回合表。
    expect(stub.queries).toHaveLength(1);
  });

  test("日活按北京时间切日分组，计数从驱动字符串转成数字", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseGameRecordRepository(stub.database);
    stub.reply([tupleOf("2026-01-02", "cee", "4", "11", "7")]);

    const counts = await repository.dailyCounts(new Date(T0));
    expect(counts).toEqual([
      { day: "2026-01-02", game: "cee", games: 4, players: 11, accounts: 7 },
    ]);

    const query = stub.queryAt(0);
    // 单表分组按别名，避免严格 only_full_group_by 把两种写法当成不同表达式。
    expect(query.statement).toContain(
      "date_format(date_add(`game_record`.`ended_at`, interval 8 hour), '%Y-%m-%d')"
    );
    expect(query.statement).toContain("group by");
    expect(query.params).toEqual([stamp(T0)]);
  });
});
