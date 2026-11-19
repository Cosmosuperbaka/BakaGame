// 排位战绩翻页与全服排行榜：服务层口径（分页游标、榜单范围、本人名次与缓存）。
import { describe, expect, test } from "bun:test";
import {
  InMemoryCEERankedStore,
  type CEERankedRatingRecord,
  type CEERankedSettlementRecord,
} from "../src/application/CEERankedStore";
import { CEE_RANKED_PLACEMENT_SERIES } from "../src/shared/CEERanked";
import { rankedHarness, RANKED_START_MS } from "./CEERankedFixtures";

const rating = (userId: string, value: number, seriesPlayed: number): CEERankedRatingRecord => ({
  userId,
  rating: value,
  rd: 80,
  seriesPlayed,
  wins: Math.ceil(seriesPlayed / 2),
  losses: Math.floor(seriesPlayed / 2),
  draws: 0,
  botRatedDay: null,
  botRatedCount: 0,
  lastPlayedAt: RANKED_START_MS - 1_000,
});

/** 一场人机结算：本人坐 0 号席，可顺带写评级。 */
const settlement = (
  id: string,
  userId: string,
  name: string,
  endedAt: number,
  ratings: CEERankedRatingRecord[] = []
): CEERankedSettlementRecord => ({
  series: {
    id,
    ruleset: "r2",
    tier: "d1",
    answerIds: [11, 12, 13],
    startedAt: endedAt - 60_000,
    endedAt,
    endReason: "completed",
    rated: true,
    unratedReason: null,
    bot: true,
    botEntry: "auto",
  },
  players: [
    {
      seat: 0,
      userId,
      name,
      clientType: "desktop",
      clientVersion: "9.9.9",
      botPersona: null,
      botTargetRating: null,
      botStrengthRating: null,
      queueWaitMs: 30_000,
      points: 2,
      score: 1,
      placement: false,
      ratingBefore: 1500,
      ratingAfter: 1510,
      rdBefore: 80,
      rdAfter: 78,
    },
    {
      seat: 1,
      userId: null,
      name: "小咔",
      clientType: null,
      clientVersion: null,
      botPersona: "awen",
      botTargetRating: 1500,
      botStrengthRating: 1500,
      queueWaitMs: null,
      points: 0,
      score: 0,
      placement: false,
      ratingBefore: null,
      ratingAfter: null,
      rdBefore: null,
      rdAfter: null,
    },
  ],
  games: [],
  guesses: [],
  ratings,
});

describe("排位战绩翻页", () => {
  test("资料带第一页并标出还有更早的；按上一页最后一条往前翻直到翻完", async () => {
    const store = new InMemoryCEERankedStore();
    for (let index = 0; index < 45; index += 1)
      await store.saveSettlement(
        settlement(`s${index}`, "u-甲", "甲", RANKED_START_MS - (45 - index) * 60_000)
      );
    const harness = rankedHarness({ store });
    const client = harness.connect("甲");
    await harness.send(client, "cee.ranked.status", {});

    const profile = await harness.send(client, "cee.ranked.profile", {});
    expect(profile.recent).toHaveLength(20);
    expect(profile.recentHasMore).toBe(true);
    expect(profile.recent[0]?.seriesId).toBe("s44");

    const second = await harness.send(client, "cee.ranked.history", {
      before: profile.recent.at(-1)!.endedAt,
    });
    expect(second.entries.map((entry) => entry.seriesId)).toEqual(
      Array.from({ length: 20 }, (_, index) => `s${24 - index}`)
    );
    expect(second.hasMore).toBe(true);

    const last = await harness.send(client, "cee.ranked.history", {
      before: second.entries.at(-1)!.endedAt,
    });
    expect(last.entries.map((entry) => entry.seriesId)).toEqual(["s4", "s3", "s2", "s1", "s0"]);
    expect(last.hasMore).toBe(false);
  });

  test("恰好一页时不误报还有更多", async () => {
    const store = new InMemoryCEERankedStore();
    for (let index = 0; index < 20; index += 1)
      await store.saveSettlement(settlement(`s${index}`, "u-甲", "甲", RANKED_START_MS - index));
    const harness = rankedHarness({ store });
    const client = harness.connect("甲");
    await harness.send(client, "cee.ranked.status", {});

    const profile = await harness.send(client, "cee.ranked.profile", {});
    expect(profile.recent).toHaveLength(20);
    expect(profile.recentHasMore).toBe(false);
  });

  test("没绑定排位连接时翻页被拒", async () => {
    const harness = rankedHarness();
    const client = harness.connect("甲");
    await expect(harness.send(client, "cee.ranked.history", { before: 1 })).rejects.toMatchObject({
      code: "RANKED_NOT_ATTACHED",
    });
  });
});

describe("排位全服排行榜", () => {
  /** 已定级若干人、定级中一人；名字取各自最近一场的席位名。 */
  const seededStore = async (): Promise<InMemoryCEERankedStore> => {
    const store = new InMemoryCEERankedStore();
    const placed = CEE_RANKED_PLACEMENT_SERIES;
    const players: Array<[string, string, number, number]> = [
      ["u-甲", "甲", 1610.4, placed + 3],
      ["u-乙", "乙", 1702.6, placed],
      ["u-丙", "丙", 1480, placed + 10],
      ["u-丁", "丁", 1999, placed - 1],
    ];
    for (const [index, [userId, name, value, played]] of players.entries())
      await store.saveSettlement(
        settlement(`seed-${index}`, userId, name, RANKED_START_MS - 10_000 + index, [
          rating(userId, value, played),
        ])
      );
    return store;
  };

  test("只收打满定级的账号，按分数倒序给名次，本人有标记", async () => {
    const harness = rankedHarness({ store: await seededStore() });
    const client = harness.connect("甲");
    await harness.send(client, "cee.ranked.status", {});

    const board = await harness.send(client, "cee.ranked.leaderboard", {});
    expect(
      board.entries.map((entry) => [entry.rank, entry.name, entry.rating, entry.self])
    ).toEqual([
      [1, "乙", 1703, false],
      [2, "甲", 1610, true],
      [3, "丙", 1480, false],
    ]);
    expect(board.self).toEqual({ rank: 2, rating: 1610 });
    expect(board.total).toBe(3);
  });

  test("定级中的本人不上榜也没有名次", async () => {
    const harness = rankedHarness({ store: await seededStore() });
    const client = harness.connect("丁");
    await harness.send(client, "cee.ranked.status", {});

    const board = await harness.send(client, "cee.ranked.leaderboard", {});
    expect(board.entries.some((entry) => entry.self)).toBe(false);
    expect(board.self).toBeNull();
  });

  test("榜外的本人也算出名次", async () => {
    const store = await seededStore();
    for (let index = 0; index < 60; index += 1)
      await store.saveSettlement(
        settlement(`top-${index}`, `u-高手${index}`, `高手${index}`, RANKED_START_MS - index, [
          rating(`u-高手${index}`, 1800 + index, CEE_RANKED_PLACEMENT_SERIES),
        ])
      );
    const harness = rankedHarness({ store });
    const client = harness.connect("丙");
    await harness.send(client, "cee.ranked.status", {});

    const board = await harness.send(client, "cee.ranked.leaderboard", {});
    expect(board.entries).toHaveLength(50);
    expect(board.entries[0]?.name).toBe("高手59");
    expect(board.entries.some((entry) => entry.self)).toBe(false);
    // 60 名高手加上乙、甲都在丙之上。
    expect(board.self).toEqual({ rank: 63, rating: 1480 });
    expect(board.total).toBe(63);
  });

  test("榜单头部缓存一段时间，过期后现查", async () => {
    const store = await seededStore();
    const harness = rankedHarness({ store });
    const client = harness.connect("甲");
    await harness.send(client, "cee.ranked.status", {});
    await harness.send(client, "cee.ranked.leaderboard", {});

    await store.saveSettlement(
      settlement("late", "u-戊", "戊", RANKED_START_MS, [
        rating("u-戊", 2100, CEE_RANKED_PLACEMENT_SERIES),
      ])
    );
    const cached = await harness.send(client, "cee.ranked.leaderboard", {});
    expect(cached.entries[0]?.name).toBe("乙");

    await harness.advance(30_000);
    const fresh = await harness.send(client, "cee.ranked.leaderboard", {});
    expect(fresh.entries[0]?.name).toBe("戊");
    expect(fresh.self).toEqual({ rank: 3, rating: 1610 });
  });
});
