import { describe, expect, test } from "bun:test";

import type {
  CEERankedGameRecord,
  CEERankedGuessRecord,
  CEERankedRatingRecord,
  CEERankedSeriesPlayerRecord,
  CEERankedSeriesRecord,
  CEERankedSettlementRecord,
} from "../src/application/CEERankedStore";
import { InMemoryCEERankedStore } from "../src/application/CEERankedStore";

const T0 = Date.parse("2026-01-02T03:04:05.678Z");

const ratingOf = (
  userId: string,
  overrides: Partial<CEERankedRatingRecord> = {}
): CEERankedRatingRecord => ({
  userId,
  rating: 1200,
  rd: 250,
  seriesPlayed: 1,
  wins: 1,
  losses: 0,
  draws: 0,
  botRatedDay: null,
  botRatedCount: 0,
  lastPlayedAt: T0,
  ...overrides,
});

const playerOf = (
  seat: 0 | 1,
  overrides: Partial<CEERankedSeriesPlayerRecord> = {}
): CEERankedSeriesPlayerRecord => ({
  seat,
  userId: seat === 0 ? "u1" : "u2",
  name: seat === 0 ? "小明" : "小红",
  clientType: "web",
  clientVersion: "1.0.0",
  botPersona: null,
  botTargetRating: null,
  botStrengthRating: null,
  queueWaitMs: 1200,
  points: 3,
  score: 1,
  placement: false,
  ratingBefore: 1200,
  ratingAfter: 1215,
  rdBefore: 250,
  rdAfter: 240,
  ...overrides,
});

const seriesOf = (
  id: string,
  endedAt: number,
  overrides: Partial<CEERankedSeriesRecord> = {}
): CEERankedSeriesRecord => ({
  id,
  ruleset: "cee",
  tier: "gold",
  answerIds: [1, 2, 3],
  startedAt: endedAt - 60_000,
  endedAt,
  endReason: "completed",
  rated: true,
  unratedReason: null,
  bot: false,
  botEntry: null,
  ...overrides,
});

const gameOf = (
  number: number,
  overrides: Partial<CEERankedGameRecord> = {}
): CEERankedGameRecord => ({
  number,
  answerCharacterId: 100 + number,
  answerName: `角色${number}`,
  winnerSeat: 0,
  endReason: "solved",
  attempts: [2, 3],
  overtime: false,
  startedAt: T0 + number * 1000,
  endedAt: T0 + number * 1000 + 500,
  ...overrides,
});

const guessOf = (
  gameNumber: number,
  seat: 0 | 1,
  attempt: number,
  createdAt: number
): CEERankedGuessRecord => ({
  gameNumber,
  seat,
  attempt,
  characterId: gameNumber * 10 + seat,
  characterName: `角色${gameNumber}-${seat}`,
  correct: attempt === 1,
  createdAt,
  clientType: "web",
  searchedAt: createdAt - 100,
  searchMatched: true,
});

const settlementOf = (
  id: string,
  endedAt: number,
  overrides: Partial<CEERankedSettlementRecord> = {}
): CEERankedSettlementRecord => ({
  series: seriesOf(id, endedAt),
  players: [playerOf(0), playerOf(1, { score: 0, points: 1 })],
  games: [gameOf(1)],
  guesses: [],
  ratings: [ratingOf("u1")],
  ...overrides,
});

describe("排位审计内存实现", () => {
  test("结算后能读回评级，同账号二次结算整体覆盖", async () => {
    const store = new InMemoryCEERankedStore();

    await store.saveSettlement(
      settlementOf("s1", T0, { ratings: [ratingOf("u1", { rating: 1215 })] })
    );
    expect(await store.getRating("u1")).toEqual(ratingOf("u1", { rating: 1215 }));

    await store.saveSettlement(
      settlementOf("s2", T0 + 1000, {
        ratings: [ratingOf("u1", { rating: 1240, seriesPlayed: 2, wins: 2, rd: 235 })],
      })
    );
    expect(await store.getRating("u1")).toEqual(
      ratingOf("u1", { rating: 1240, seriesPlayed: 2, wins: 2, rd: 235 })
    );
  });

  test("历史按结束时间倒序，对手一行的昵称、比分与人机判定都取对方席位", async () => {
    const store = new InMemoryCEERankedStore();
    await store.saveSettlement(
      settlementOf("s-human", T0, {
        players: [playerOf(0, { points: 3, score: 1 }), playerOf(1, { points: 1, score: 0 })],
      })
    );
    await store.saveSettlement(
      settlementOf("s-bot", T0 + 2000, {
        series: seriesOf("s-bot", T0 + 2000, { bot: true, botEntry: "auto" }),
        players: [
          playerOf(0, { points: 2, score: 0.5, ratingAfter: null, rdAfter: null }),
          playerOf(1, { userId: null, name: "快枪手", botPersona: "rush", points: 2, score: 0.5 }),
        ],
        ratings: [ratingOf("u1", { botRatedDay: "2026-01-02", botRatedCount: 1 })],
      })
    );

    const rows = await store.listHistory("u1", 10);
    expect(rows.map((row) => row.seriesId)).toEqual(["s-bot", "s-human"]);
    expect(rows[0]).toEqual({
      seriesId: "s-bot",
      endedAt: T0 + 2000,
      tier: "gold",
      rated: true,
      opponentName: "快枪手",
      opponentIsBot: true,
      selfPoints: 2,
      opponentPoints: 2,
      score: 0.5,
      placement: false,
      ratingBefore: 1200,
      ratingAfter: null,
    });
    expect(rows[1]).toMatchObject({
      opponentName: "小红",
      opponentIsBot: false,
      selfPoints: 3,
      opponentPoints: 1,
      score: 1,
      ratingAfter: 1215,
    });

    expect(await store.listHistory("u9", 10)).toEqual([]);
    expect(await store.listHistory("u1", 0)).toHaveLength(1);
    expect(await store.listHistory("u1", 999)).toHaveLength(2);
  });

  test("审计列表按结束时间倒序，before 只取更早的", async () => {
    const store = new InMemoryCEERankedStore();
    await store.saveSettlement(settlementOf("s1", T0));
    await store.saveSettlement(settlementOf("s2", T0 + 1000));
    await store.saveSettlement(
      settlementOf("s3", T0 + 2000, {
        players: [playerOf(0, { userId: "u8", name: "小刚" }), playerOf(1)],
        ratings: [ratingOf("u8")],
      })
    );

    expect((await store.listSeriesByUser("u1", 10)).map((row) => row.id)).toEqual(["s2", "s1"]);
    expect((await store.listSeriesByUser("u1", 10, T0 + 1000)).map((row) => row.id)).toEqual([
      "s1",
    ]);
    expect((await store.listSeriesByUser("u1", 0)).map((row) => row.id)).toEqual(["s2"]);
  });

  test("审计明细按局号与出手顺序排，读回的是结算时的快照", async () => {
    const store = new InMemoryCEERankedStore();
    const record = settlementOf("s1", T0, {
      games: [gameOf(2), gameOf(1)],
      guesses: [
        guessOf(2, 1, 1, T0 + 5000),
        guessOf(1, 0, 2, T0 + 2000),
        guessOf(1, 0, 1, T0 + 1000),
        guessOf(1, 1, 1, T0 + 1000),
      ],
    });
    await store.saveSettlement(record);
    record.series.tier = "被改写";
    record.games.length = 0;

    const audit = await store.getSeriesAudit("s1");
    expect(audit?.series.tier).toBe("gold");
    expect(audit?.games.map((game) => game.number)).toEqual([1, 2]);
    expect(
      audit?.guesses.map((guess) => [guess.gameNumber, guess.createdAt, guess.seat, guess.attempt])
    ).toEqual([
      [1, T0 + 1000, 0, 1],
      [1, T0 + 1000, 1, 1],
      [1, T0 + 2000, 0, 2],
      [2, T0 + 5000, 1, 1],
    ]);
  });

  test("校准样本只取计分的人机局：真人局、不计分、缺强度列的都跳过", async () => {
    const store = new InMemoryCEERankedStore();
    const botOf = (overrides: Partial<CEERankedSeriesPlayerRecord> = {}) =>
      playerOf(1, {
        userId: null,
        name: "团子",
        clientType: null,
        clientVersion: null,
        botPersona: "dango",
        botTargetRating: 1180,
        botStrengthRating: 1150,
        points: 0,
        score: 0,
        ratingBefore: null,
        ratingAfter: null,
        rdBefore: null,
        rdAfter: null,
        ...overrides,
      });

    // 真人局：没有「强度 vs 战绩」这回事。
    await store.saveSettlement(settlementOf("s-human", T0));
    // 人机但不计分：这一场的人机没有按真实水平出手，不代表任何强度。
    await store.saveSettlement(
      settlementOf("s-unrated", T0 + 1000, {
        series: seriesOf("s-unrated", T0 + 1000, {
          bot: true,
          rated: false,
          unratedReason: "bot_daily_limit",
          botEntry: "auto",
        }),
        players: [playerOf(0), botOf()],
      })
    );
    // 计分人机（爱噶）：真人赛前 μ/φ 与强度分都在。
    await store.saveSettlement(
      settlementOf("s-aiga", T0 + 2000, {
        series: seriesOf("s-aiga", T0 + 2000, { bot: true, botEntry: "placement" }),
        players: [playerOf(0), botOf({ botPersona: "aiga" })],
      })
    );
    // 旧数据没有强度列：凑不出样本。
    await store.saveSettlement(
      settlementOf("s-legacy", T0 + 3000, {
        series: seriesOf("s-legacy", T0 + 3000, { bot: true, botEntry: "auto" }),
        players: [playerOf(0), botOf({ botStrengthRating: null })],
      })
    );
    // 最新一场计分人机（普通人格）：倒序后应当排第一。
    await store.saveSettlement(
      settlementOf("s-regular", T0 + 4000, {
        series: seriesOf("s-regular", T0 + 4000, { bot: true, botEntry: "manual" }),
        players: [playerOf(0, { points: 0, score: 0 }), botOf({ points: 3, score: 1 })],
      })
    );

    expect(await store.listRecentBotSamples(10)).toEqual([
      { group: "regular", playerRating: 1200, playerRd: 250, strengthRating: 1150, score: 0 },
      { group: "aiga", playerRating: 1200, playerRd: 250, strengthRating: 1150, score: 1 },
    ]);
    expect(await store.listRecentBotSamples(1)).toHaveLength(1);
    // 下界夹到 1：0 条不会把整个校准窗口清空。
    expect(await store.listRecentBotSamples(0)).toHaveLength(1);
  });

  test("读不到就返回 null，不编造评级与明细", async () => {
    const store = new InMemoryCEERankedStore();
    expect(await store.getRating("u1")).toBeNull();
    expect(await store.getSeriesAudit("missing")).toBeNull();
  });
});
