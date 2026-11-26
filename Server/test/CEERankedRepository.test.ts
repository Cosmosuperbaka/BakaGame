import { describe, expect, test } from "bun:test";

import { CEE_RANKED_HANDICAP_MAX_PLAYER_RD } from "../src/application/CEERankedHandicap";
import type {
  CEERankedGuessRecord,
  CEERankedSettlementRecord,
} from "../src/application/CEERankedStore";
import { CEERankedRepository } from "../src/infrastructure/db/CEERankedRepository";
import { CEE_RANKED_RULESET } from "../src/shared/CEERanked";
import { createDrizzleStub, rowOf, schema, stamp, tupleOf } from "./DrizzleStub";

const T0 = Date.parse("2026-01-02T03:04:05.678Z");
const T1 = T0 + 60_000;

/** 评级读取按显式列序给行：不读停用的人机额度两列，也不读 `updated_at`。 */
const ratingRow = () => tupleOf("u1", 1215.5, 240, 3, 2, 1, 0, stamp(T0));

const guessOf = (gameNumber: number, seat: 0 | 1, attempt: number): CEERankedGuessRecord => ({
  gameNumber,
  seat,
  attempt,
  characterId: gameNumber * 100 + attempt,
  characterName: `角色${gameNumber}-${attempt}`,
  correct: false,
  createdAt: T0 + attempt * 1000,
  clientType: "web",
  searchedAt: null,
  searchMatched: null,
});

/** 一场人机系列赛：席位 0 是真人，席位 1 是机器人，两局、每局两次出手。 */
const botSettlement = (): CEERankedSettlementRecord => ({
  series: {
    id: "s1",
    ruleset: "cee",
    tier: "gold",
    answerIds: [7, 8, 9],
    startedAt: T0,
    endedAt: T1,
    endReason: "completed",
    rated: true,
    unratedReason: null,
    bot: true,
    botEntry: "auto",
  },
  players: [
    {
      seat: 0,
      userId: "u1",
      name: "小明",
      clientType: "web",
      clientVersion: "1.0.0",
      botPersona: null,
      botTargetRating: null,
      botStrengthRating: null,
      queueWaitMs: 1200,
      points: 2,
      score: 0.5,
      placement: false,
      ratingBefore: 1200,
      ratingAfter: 1200,
      rdBefore: 250,
      rdAfter: 250,
    },
    {
      seat: 1,
      userId: null,
      name: "快枪手",
      clientType: null,
      clientVersion: null,
      botPersona: "rush",
      botTargetRating: 1180,
      botStrengthRating: 1150,
      queueWaitMs: null,
      points: 2,
      score: 0.5,
      placement: false,
      ratingBefore: null,
      ratingAfter: null,
      rdBefore: null,
      rdAfter: null,
    },
  ],
  games: [
    {
      number: 1,
      answerCharacterId: 7,
      answerName: "角色一",
      winnerSeat: 0,
      endReason: "solved",
      attempts: [2, 2],
      overtime: false,
      startedAt: T0,
      endedAt: T0 + 5000,
    },
    {
      number: 2,
      answerCharacterId: 8,
      answerName: "角色二",
      winnerSeat: null,
      endReason: "draw",
      attempts: [2, 2],
      overtime: true,
      startedAt: T0 + 6000,
      endedAt: T1,
    },
  ],
  guesses: [guessOf(1, 0, 1), guessOf(1, 1, 1), guessOf(1, 0, 2), guessOf(1, 1, 2)],
  ratings: [
    {
      userId: "u1",
      rating: 1200,
      rd: 250,
      seriesPlayed: 4,
      wins: 2,
      losses: 1,
      draws: 1,
      lastPlayedAt: T1,
    },
  ],
});

describe("排位审计仓储（连接桩）", () => {
  test("读评级：按主键取一行，时间列解码回毫秒", async () => {
    const stub = createDrizzleStub();
    const repository = new CEERankedRepository(stub.database);
    stub.reply([ratingRow()]);

    expect(await repository.getRating("u1")).toEqual({
      userId: "u1",
      rating: 1215.5,
      rd: 240,
      seriesPlayed: 3,
      wins: 2,
      losses: 1,
      draws: 0,
      lastPlayedAt: T0,
    });
    const query = stub.queryAt(0);
    expect(query.statement).toContain("from `cee_ranked_rating`");
    // 停用的人机额度两列不再读取：日后删列时旧代码也不会因 SELECT 不存在的列而报错。
    expect(query.statement).not.toContain("bot_rated");
    expect(query.statement).toContain("where `cee_ranked_rating`.`user_id` = ?");
    expect(query.params).toEqual(["u1", 1]);

    stub.reset();
    stub.reply([]);
    expect(await repository.getRating("u9")).toBeNull();
  });

  test("结算一场人机系列赛：事务内按表顺序落全部行，评级 upsert 覆盖业务列", async () => {
    const stub = createDrizzleStub();
    const repository = new CEERankedRepository(stub.database);

    await repository.saveSettlement(botSettlement());

    const statements = stub.queries.map((query) => query.statement);
    expect(statements[0]).toBe("begin");
    expect(statements[1]).toContain("insert into `cee_ranked_series`");
    expect(statements[2]).toContain("insert into `cee_ranked_series_player`");
    expect(statements[3]).toContain("insert into `cee_ranked_game`");
    expect(statements[4]).toContain("insert into `cee_ranked_guess`");
    expect(statements[5]).toContain("insert into `cee_ranked_rating`");
    expect(statements.at(-1)).toBe("commit");

    const series = stub.queryAt(1);
    expect(series.params).toEqual([
      "s1",
      "cee",
      "gold",
      JSON.stringify([7, 8, 9]),
      stamp(T0),
      stamp(T1),
      "completed",
      true,
      null,
      true,
      "auto",
    ]);

    const players = stub.queryAt(2);
    // 两席一行：人机一侧没有账号 ID，评级四列也为空；强度列记的是真正生成强度用的分。
    expect(players.params).toEqual([
      "s1",
      0,
      "u1",
      "小明",
      "web",
      "1.0.0",
      null,
      null,
      null,
      1200,
      2,
      0.5,
      false,
      1200,
      1200,
      250,
      250,
      "s1",
      1,
      null,
      "快枪手",
      null,
      null,
      "rush",
      1180,
      1150,
      null,
      2,
      0.5,
      false,
      null,
      null,
      null,
      null,
    ]);

    const guesses = stub.queryAt(4);
    expect(guesses.params).toHaveLength(4 * 11);
    expect(guesses.statement).toContain(
      "insert into `cee_ranked_guess` (`series_id`, `game_number`, `seat`, `attempt`,"
    );
    // 四条出手拼在同一条 INSERT 里，主键四列在最前面。
    expect(guesses.statement.split("(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").length - 1).toBe(4);

    const upsert = stub.queryAt(5);
    expect(upsert.statement.split("on duplicate key update")[1]).toBe(
      " `rating` = ?, `rd` = ?, `series_played` = ?, `wins` = ?, `losses` = ?, `draws` = ?, " +
        "`last_played_at` = ?, `updated_at` = ?"
    );
    // 主键 userId 只在插入侧出现一次，业务列在覆盖侧原样再来一遍；
    // 两处 `updated_at` 由列定义的 `$onUpdateFn` 补上，端口不必传，取写入时刻。
    expect(upsert.params).toEqual([
      "u1",
      1200,
      250,
      4,
      2,
      1,
      1,
      stamp(T1),
      expect.any(String),
      1200,
      250,
      4,
      2,
      1,
      1,
      stamp(T1),
      expect.any(String),
    ]);
  });

  test("猜测超过 500 行分批插入", async () => {
    const stub = createDrizzleStub();
    const repository = new CEERankedRepository(stub.database);
    const guesses: CEERankedGuessRecord[] = [];
    for (let index = 0; index < 601; index++)
      guesses.push(guessOf(1, index % 2 === 0 ? 0 : 1, index));

    await repository.saveSettlement({ ...botSettlement(), guesses });

    const inserts = stub.queries.filter((query) =>
      query.statement.includes("insert into `cee_ranked_guess`")
    );
    expect(inserts).toHaveLength(2);
    expect(inserts[0].params).toHaveLength(500 * 11);
    expect(inserts[1].params).toHaveLength(101 * 11);
  });

  test("事务中途失败即抛出，不再发出后续插入", async () => {
    const stub = createDrizzleStub();
    const repository = new CEERankedRepository(stub.database);
    // 第 4 条是猜测插入（前三条为 begin、系列赛、席位）。
    stub.reject(4, new Error("guess row rejected"));

    await expect(repository.saveSettlement(botSettlement())).rejects.toThrow(
      /insert into `cee_ranked_guess`/
    );
    const statements = stub.queries.map((query) => query.statement);
    expect(statements.at(-1)).toBe("rollback");
    // 猜测之后的评级 upsert 没发出去，事务整体回滚。
    expect(statements.filter((statement) => statement.includes("cee_ranked_rating"))).toHaveLength(
      0
    );
    expect(statements.filter((statement) => statement.startsWith("insert into"))).toHaveLength(4);
  });

  test("历史列表连接对手那一行，倒序并把 limit 夹到 50", async () => {
    const stub = createDrizzleStub();
    const repository = new CEERankedRepository(stub.database);
    stub.reply([
      tupleOf("s2", stamp(T1), "gold", true, "快枪手", null, "rush", 2, 3, 1, false, 1200, 1215),
    ]);

    const rows = await repository.listHistory("u1", 999);
    expect(rows).toEqual([
      {
        seriesId: "s2",
        endedAt: T1,
        tier: "gold",
        rated: true,
        opponentName: "快枪手",
        opponentIsBot: true,
        selfPoints: 3,
        opponentPoints: 2,
        score: 1,
        placement: false,
        ratingBefore: 1200,
        ratingAfter: 1215,
      },
    ]);

    const query = stub.queryAt(0);
    expect(query.statement).toContain("inner join `cee_ranked_series`");
    expect(query.statement).toContain("inner join `cee_ranked_series_player` `opponent`");
    expect(query.statement).toContain("`opponent`.`seat` <> `cee_ranked_series_player`.`seat`");
    expect(query.statement).toContain("order by `cee_ranked_series`.`ended_at` desc");
    expect(query.params).toEqual(["u1", 50]);
  });

  test("校准样本只取现行规则版本的计分人机局、在库里先筛掉定级与偏差过大的真人再限量，按结束时间倒序，limit 夹到 1000 并跳过缺列的旧行", async () => {
    const stub = createDrizzleStub();
    const repository = new CEERankedRepository(stub.database);
    stub.reply([
      tupleOf("aiga", 1480, "u1", false, 1500, 120, 1),
      // 旧数据没有强度列：这一行不可能是有效样本，必须被丢掉而不是算成 0 分。
      tupleOf("rush", null, "u1", false, 1500, 120, 0),
      // 账号已注销：没法限制单个账号的权重，不收。
      tupleOf("rush", 1150, null, false, 1500, 120, 0),
      tupleOf("rush", 1150, "u2", false, 1200, 140, 0.5),
    ]);

    const samples = await repository.listRecentBotSamples(9999);
    expect(samples).toEqual([
      {
        group: "aiga",
        userId: "u1",
        placement: false,
        playerRating: 1500,
        playerRd: 120,
        strengthRating: 1480,
        score: 1,
      },
      {
        group: "regular",
        userId: "u2",
        placement: false,
        playerRating: 1200,
        playerRd: 140,
        strengthRating: 1150,
        score: 0.5,
      },
    ]);

    const query = stub.queryAt(0);
    expect(query.statement).toContain("inner join `cee_ranked_series_player` `opponent`");
    expect(query.statement).toContain("`cee_ranked_series`.`bot` = ?");
    expect(query.statement).toContain("`cee_ranked_series`.`rated` = ?");
    expect(query.statement).toContain("`cee_ranked_series`.`ruleset` = ?");
    expect(query.statement).toContain("`cee_ranked_series_player`.`placement` = ?");
    expect(query.statement).toContain("`cee_ranked_series_player`.`rd_before` <= ?");
    expect(query.statement).toContain("`cee_ranked_series`.`ended_at` desc");
    const filters = [true, true, CEE_RANKED_RULESET, false, CEE_RANKED_HANDICAP_MAX_PLAYER_RD];
    expect(query.params).toEqual([...filters, 1000]);

    stub.reset();
    await repository.listRecentBotSamples(0);
    expect(stub.queryAt(0).params).toEqual([...filters, 1]);
  });

  test("审计明细分四张表读回；系列赛不存在时只查一次", async () => {
    const stub = createDrizzleStub();
    const repository = new CEERankedRepository(stub.database);
    stub.reply(
      [
        rowOf(schema.ceeRankedSeries, {
          id: "s1",
          answerIds: "[7]",
          startedAt: stamp(T0),
          endedAt: stamp(T1),
        }),
      ],
      [
        rowOf(schema.ceeRankedSeriesPlayer, {
          seriesId: "s1",
          seat: 0,
          userId: "u1",
          name: "小明",
          points: 2,
          score: 1,
          placement: false,
        }),
        rowOf(schema.ceeRankedSeriesPlayer, {
          seriesId: "s1",
          seat: 1,
          userId: null,
          name: "快枪手",
          botPersona: "rush",
          botStrengthRating: 1150,
          points: 0,
          score: 0,
          placement: false,
        }),
      ],
      [
        rowOf(schema.ceeRankedGame, {
          seriesId: "s1",
          number: 1,
          answerCharacterId: 7,
          answerName: "角色一",
          winnerSeat: 0,
          endReason: "solved",
          attempts0: 2,
          attempts1: 1,
          overtime: false,
          startedAt: stamp(T0),
          endedAt: stamp(T1),
        }),
      ],
      [
        rowOf(schema.ceeRankedGuess, {
          seriesId: "s1",
          gameNumber: 1,
          seat: 0,
          attempt: 1,
          characterId: 7,
          characterName: "角色一",
          correct: true,
          createdAt: stamp(T0),
        }),
      ]
    );

    const audit = await repository.getSeriesAudit("s1");
    expect(audit?.series.id).toBe("s1");
    expect(audit?.series.startedAt).toBe(T0);
    expect(audit?.players.map((player) => player.seat)).toEqual([0, 1]);
    expect(audit?.players[1]).toMatchObject({
      userId: null,
      botPersona: "rush",
      botStrengthRating: 1150,
      score: 0,
    });
    expect(audit?.games[0]).toMatchObject({ number: 1, attempts: [2, 1], winnerSeat: 0 });
    expect(audit?.guesses[0]).toMatchObject({ attempt: 1, correct: true, createdAt: T0 });

    expect(stub.queries).toHaveLength(4);
    expect(stub.queryAt(0).statement).toContain("from `cee_ranked_series`");
    expect(stub.queryAt(1).statement).toContain("`cee_ranked_series_player`.`series_id` = ?");
    expect(stub.queryAt(2).statement).toContain("order by `cee_ranked_game`.`number`");
    expect(stub.queryAt(3).statement).toContain(
      "order by `cee_ranked_guess`.`game_number`, `cee_ranked_guess`.`created_at`, " +
        "`cee_ranked_guess`.`seat`, `cee_ranked_guess`.`attempt`"
    );

    stub.reset();
    stub.reply([]);
    expect(await repository.getSeriesAudit("missing")).toBeNull();
    expect(stub.queries).toHaveLength(1);
  });

  test("数据库未就绪时各方法都拒绝且不发任何语句", async () => {
    const ready = Promise.reject(new Error("db down"));
    const stub = createDrizzleStub({ ready });
    const repository = new CEERankedRepository(stub.database);
    // 先让拒绝被本条用例消费，避免未处理的 rejection 影响其它用例。
    ready.catch(() => {});

    await expect(repository.getRating("u1")).rejects.toThrow("db down");
    await expect(repository.saveSettlement(botSettlement())).rejects.toThrow("db down");
    await expect(repository.listHistory("u1", 10)).rejects.toThrow("db down");
    await expect(repository.listSeriesByUser("u1", 10)).rejects.toThrow("db down");
    await expect(repository.listRecentBotSamples(10)).rejects.toThrow("db down");
    await expect(repository.getSeriesAudit("s1")).rejects.toThrow("db down");
    expect(stub.queries).toHaveLength(0);
  });
});
