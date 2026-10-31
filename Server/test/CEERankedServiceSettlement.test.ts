// ==================== 排位结算与定级用例 ====================
// 这里只跑「一场人机系列赛打完之后发生了什么」：审计行数、评级写回、定级进度、
// 每日人机额度与写库退避重试。对局推进全部靠夹具的假时钟，不出现真实等待。
import { describe, expect, test } from "bun:test";
import {
  InMemoryCEERankedStore,
  type CEERankedHistoryRecord,
  type CEERankedRatingRecord,
  type CEERankedSeriesAudit,
  type CEERankedSeriesRecord,
  type CEERankedSettlementRecord,
  type CEERankedStore,
} from "../src/application/CEERankedStore";
import { AppError } from "../src/domain/Errors";
import { beijingDay } from "../src/domain/BeijingDay";
import { createCEERating, displayCEERating, rateCEEBotSeries } from "../src/domain/CEERankedRating";
import {
  CEE_RANKED_BOT_DAILY_RATED,
  CEE_RANKED_BOT_FALLBACK_MS,
  CEE_RANKED_COUNTDOWN_MS,
  CEE_RANKED_INTERMISSION_MS,
  CEE_RANKED_PLACEMENT_SERIES,
  CEE_RANKED_RULESET,
} from "../src/shared/Index";
import {
  RANKED_START_MS,
  appErrorOf,
  openPlay,
  rankedHarness,
  startBotSeries,
  type RankedClient,
  type RankedHarness,
} from "./CEERankedFixtures";

/** 按系列赛号回读审计：读不到直接失败，省得每个断言都写可选链。 */
const readAudit = async (
  harness: RankedHarness,
  seriesId: string
): Promise<CEERankedSeriesAudit> => {
  const audit = await harness.store.getSeriesAudit(seriesId);
  if (!audit) throw new Error(`结算后读不到系列赛 ${seriesId} 的审计`);
  return audit;
};

/** 按账号取回评级行：写回是否发生都在这里判定。 */
const readRating = async (
  harness: RankedHarness,
  userId: string
): Promise<CEERankedRatingRecord> => {
  const rating = await harness.store.getRating(userId);
  if (!rating) throw new Error(`读不到账号 ${userId} 的评级`);
  return rating;
};

/** 排一场人机局并立刻离场：只关心结算落库的用例不必真打满三局。 */
const settleOneBotSeries = async (
  harness: RankedHarness,
  client: RankedClient
): Promise<string> => {
  await harness.send(client, "cee.ranked.queue", {});
  await harness.advance(CEE_RANKED_BOT_FALLBACK_MS);
  const seriesId = harness.seriesView(client).seriesId;
  await harness.send(client, "cee.ranked.exit", {});
  return seriesId;
};

/**
 * 预置一行评级：「已定级」与「当日额度已用尽」这类前提靠连打六场攒不出来，
 * 只能直接播种；结算写回后走内存实现，后续读取按真实落库的行。
 */
class SeededStore extends InMemoryCEERankedStore {
  private readonly seeded: CEERankedRatingRecord;

  constructor(seeded: CEERankedRatingRecord) {
    super();
    this.seeded = seeded;
  }

  override async getRating(userId: string): Promise<CEERankedRatingRecord | null> {
    const saved = await super.getRating(userId);
    if (saved) return saved;
    return userId === this.seeded.userId ? { ...this.seeded } : null;
  }
}

/** 前 `failures` 次写库抛错，之后转给内存实现：用来验证退避重试与彻底失败。 */
class FlakyStore implements CEERankedStore {
  private readonly inner = new InMemoryCEERankedStore();
  private readonly failures: number;
  private saveAttempts = 0;

  constructor(failures: number) {
    this.failures = failures;
  }

  /** 已经尝试过几次写库（含首次）。 */
  get attempts(): number {
    return this.saveAttempts;
  }

  getRating(userId: string): Promise<CEERankedRatingRecord | null> {
    return this.inner.getRating(userId);
  }

  async saveSettlement(record: CEERankedSettlementRecord): Promise<void> {
    this.saveAttempts += 1;
    if (this.saveAttempts <= this.failures)
      throw new AppError("RANKED_STORE_UNAVAILABLE", "测试用写库失败");
    await this.inner.saveSettlement(record);
  }

  listHistory(userId: string, limit: number): Promise<CEERankedHistoryRecord[]> {
    return this.inner.listHistory(userId, limit);
  }

  listSeriesByUser(
    userId: string,
    limit: number,
    before?: number
  ): Promise<CEERankedSeriesRecord[]> {
    return this.inner.listSeriesByUser(userId, limit, before);
  }

  getSeriesAudit(seriesId: string): Promise<CEERankedSeriesAudit | null> {
    return this.inner.getSeriesAudit(seriesId);
  }
}

describe("人机系列赛结算", () => {
  test("两局打完：审计写全系列赛、两名玩家、每一局与每一次猜测", async () => {
    const harness = rankedHarness();
    const client = harness.connect("甲");
    await startBotSeries(harness, client);
    const seriesId = harness.seriesView(client).seriesId;
    const startedAt = harness.clock();
    await openPlay(harness);
    await harness.send(client, "cee.ranked.guess", { characterId: 11 });
    expect(harness.seriesView(client).phase).toBe("intermission");
    await harness.advance(CEE_RANKED_INTERMISSION_MS + CEE_RANKED_COUNTDOWN_MS);
    const endedAt = harness.clock();
    await harness.send(client, "cee.ranked.guess", { characterId: 12 });

    expect(harness.seriesView(client).result).toEqual({
      outcome: "won",
      reason: "completed",
      settlement: "rated",
      // 第一场仍在定级中：赛前赛后都不给展示分，只报进度。
      ratingBefore: null,
      ratingAfter: null,
      placementPlayed: 1,
    });

    const audit = await readAudit(harness, seriesId);
    expect(audit.series.ruleset).toBe(CEE_RANKED_RULESET);
    expect(audit.series.answerIds).toEqual([11, 12, 13]);
    expect(audit.series.startedAt).toBe(startedAt);
    expect(audit.series.endedAt).toBe(endedAt);
    expect(audit.series.endReason).toBe("completed");
    expect(audit.series.rated).toBe(true);
    expect(audit.series.unratedReason).toBeNull();
    expect(audit.series.bot).toBe(true);
    expect(audit.series.botEntry).toBe("auto");

    expect(audit.players.length).toBe(2);
    expect(audit.players[0]).toMatchObject({
      seat: 0,
      userId: "u-甲",
      points: 2,
      score: 1,
      placement: true,
      queueWaitMs: CEE_RANKED_BOT_FALLBACK_MS,
      clientType: "desktop",
      clientVersion: "9.9.9",
      botPersona: null,
      botTargetRating: null,
    });
    expect(audit.players[1]).toMatchObject({
      seat: 1,
      userId: null,
      name: "爱噶",
      points: 0,
      score: 0,
      botPersona: "aiga",
      // 爱噶的目标分就是玩家自己的分数，其余人格才在 ±120 内浮动。
      botTargetRating: 1500,
      clientType: null,
      queueWaitMs: null,
      ratingBefore: null,
      ratingAfter: null,
    });

    expect(
      audit.games.map((game) => [
        game.number,
        game.answerCharacterId,
        game.winnerSeat,
        game.endReason,
        game.attempts,
        game.overtime,
      ])
    ).toEqual([
      [1, 11, 0, "solved", [1, 0], false],
      [2, 12, 0, "solved", [1, 0], false],
    ]);

    expect(
      audit.guesses.map((guess) => [
        guess.gameNumber,
        guess.seat,
        guess.attempt,
        guess.characterId,
        guess.correct,
        guess.clientType,
        guess.searchedAt,
        guess.searchMatched,
      ])
    ).toEqual([
      [1, 0, 1, 11, true, "desktop", null, false],
      [2, 0, 1, 12, true, "desktop", null, false],
    ]);

    // 评级写回按领域函数的结果逐项对齐：只断言「涨了」抓不出用错对手分或得分的 bug。
    const expected = rateCEEBotSeries(createCEERating(), 1500, 1, endedAt);
    const rating = await readRating(harness, client.userId);
    expect(rating.rating).toBeCloseTo(expected.rating, 6);
    expect(rating.rd).toBeCloseTo(expected.rd, 6);
    expect({
      userId: rating.userId,
      seriesPlayed: rating.seriesPlayed,
      wins: rating.wins,
      losses: rating.losses,
      draws: rating.draws,
      botRatedDay: rating.botRatedDay,
      botRatedCount: rating.botRatedCount,
      lastPlayedAt: rating.lastPlayedAt,
    }).toEqual({
      userId: "u-甲",
      seriesPlayed: 1,
      wins: 1,
      losses: 0,
      draws: 0,
      botRatedDay: null,
      botRatedCount: 0,
      lastPlayedAt: endedAt,
    });
  });

  test("profile 把刚结算的这场列进 recent，并按展示分给出 ratingDelta", async () => {
    const harness = rankedHarness();
    const client = harness.connect("甲");
    await startBotSeries(harness, client);
    await openPlay(harness);
    await harness.send(client, "cee.ranked.guess", { characterId: 11 });
    await harness.advance(CEE_RANKED_INTERMISSION_MS + CEE_RANKED_COUNTDOWN_MS);
    await harness.send(client, "cee.ranked.guess", { characterId: 12 });

    const rating = await readRating(harness, client.userId);
    const profile = await harness.send(client, "cee.ranked.profile", {});
    expect({
      rating: profile.rating,
      placementPlayed: profile.placementPlayed,
      placementTotal: profile.placementTotal,
      seriesPlayed: profile.seriesPlayed,
      wins: profile.wins,
      losses: profile.losses,
      botRatedToday: profile.botRatedToday,
      botRatedLimit: profile.botRatedLimit,
    }).toEqual({
      // 定级中：档案里的展示分仍是 null，进度封顶在 5。
      rating: null,
      placementPlayed: 1,
      placementTotal: CEE_RANKED_PLACEMENT_SERIES,
      seriesPlayed: 1,
      wins: 1,
      losses: 0,
      botRatedToday: 0,
      botRatedLimit: CEE_RANKED_BOT_DAILY_RATED,
    });
    expect(profile.recent.length).toBe(1);
    expect(profile.recent[0]).toMatchObject({
      outcome: "won",
      opponentName: "爱噶",
      opponentIsBot: true,
      selfPoints: 2,
      opponentPoints: 0,
      placement: true,
    });
    // ratingDelta 按展示分取整后相减，起点是初值 1500。
    expect(profile.recent[0]?.ratingDelta).toBe(Math.round(rating.rating) - 1500);
  });
});

describe("定级五场", () => {
  test("前五场逐场递增定级进度且展示分为 null，第五场结算才给出分数", async () => {
    const harness = rankedHarness();
    const client = harness.connect("甲");
    for (let round = 1; round <= CEE_RANKED_PLACEMENT_SERIES; round += 1) {
      const seriesId = await settleOneBotSeries(harness, client);
      const view = harness.seriesView(client);
      const profile = await harness.send(client, "cee.ranked.profile", {});
      expect({ round, placement: view.result?.placementPlayed }).toEqual({
        round,
        placement: round,
      });
      expect(view.self.rating).toBeNull();
      expect(view.result?.ratingBefore).toBeNull();
      if (round < CEE_RANKED_PLACEMENT_SERIES) {
        // 定级没打完：结果页与档案都不给展示分。
        expect(view.result?.ratingAfter).toBeNull();
        expect(profile.rating).toBeNull();
      } else {
        expect(typeof view.result?.ratingAfter).toBe("number");
      }
      // 定级中的人机局不占当日额度：额度只从第 6 场开始计。
      expect(profile.botRatedToday).toBe(0);
      const audit = await readAudit(harness, seriesId);
      expect(audit.series.rated).toBe(true);
      expect(audit.players[0]?.placement).toBe(true);
    }

    const rating = await readRating(harness, client.userId);
    const profile = await harness.send(client, "cee.ranked.profile", {});
    expect(profile.rating).toBe(displayCEERating(rating));
    expect(profile.placementPlayed).toBe(CEE_RANKED_PLACEMENT_SERIES);
    expect({
      seriesPlayed: rating.seriesPlayed,
      botRatedDay: rating.botRatedDay,
      botRatedCount: rating.botRatedCount,
    }).toEqual({ seriesPlayed: CEE_RANKED_PLACEMENT_SERIES, botRatedDay: null, botRatedCount: 0 });
  });
});

describe("人机每日计分额度", () => {
  /** 已定级且当天五场计分人机都打满：第 6 场起人机局不计分。 */
  const seededAtLimit = (): CEERankedRatingRecord => ({
    userId: "u-甲",
    rating: 1500,
    rd: 200,
    seriesPlayed: CEE_RANKED_PLACEMENT_SERIES,
    wins: 3,
    losses: 2,
    draws: 0,
    botRatedDay: beijingDay(RANKED_START_MS),
    botRatedCount: CEE_RANKED_BOT_DAILY_RATED,
    lastPlayedAt: RANKED_START_MS - 3_600_000,
  });

  test("额度用尽后的人机局不计分：评级原样、场数照进", async () => {
    const seeded = seededAtLimit();
    const harness = rankedHarness({ store: new SeededStore(seeded) });
    const client = harness.connect("甲", { account: { userId: "u-甲", image: null } });
    const seriesId = await settleOneBotSeries(harness, client);

    const view = harness.seriesView(client);
    expect(view.rated).toBe(false);
    expect(view.result).toEqual({
      outcome: "lost",
      reason: "exit",
      settlement: "unrated",
      // 不计分时前后都不出展示分，定级早已完成也就没有进度。
      ratingBefore: null,
      ratingAfter: null,
      placementPlayed: null,
    });

    const audit = await readAudit(harness, seriesId);
    expect(audit.series.rated).toBe(false);
    expect(audit.series.unratedReason).toBe("bot_daily_limit");
    expect(audit.players[0]?.ratingBefore).toBe(1500);
    expect(audit.players[0]?.ratingAfter).toBe(1500);
    expect(audit.players[0]?.rdAfter).toBe(200);

    const rating = await readRating(harness, client.userId);
    expect(rating).toEqual({
      ...seeded,
      seriesPlayed: CEE_RANKED_PLACEMENT_SERIES + 1,
      losses: 3,
    });
    const profile = await harness.send(client, "cee.ranked.profile", {});
    expect(profile.rating).toBe(1500);
    expect(profile.botRatedToday).toBe(CEE_RANKED_BOT_DAILY_RATED);
  });

  test("换到北京日的下一天后人机局恢复计分", async () => {
    const seeded = seededAtLimit();
    const harness = rankedHarness({ store: new SeededStore(seeded) });
    const client = harness.connect("甲", { account: { userId: "u-甲", image: null } });
    await settleOneBotSeries(harness, client);

    await harness.advance(86_400_000);
    const seriesId = await settleOneBotSeries(harness, client);
    const audit = await readAudit(harness, seriesId);
    expect(audit.series.rated).toBe(true);
    expect(audit.series.unratedReason).toBeNull();
    expect(harness.seriesView(client).result?.settlement).toBe("rated");

    const rating = await readRating(harness, client.userId);
    expect({
      seriesPlayed: rating.seriesPlayed,
      botRatedDay: rating.botRatedDay,
      botRatedCount: rating.botRatedCount,
    }).toEqual({
      seriesPlayed: CEE_RANKED_PLACEMENT_SERIES + 2,
      botRatedDay: beijingDay(RANKED_START_MS + 86_400_000),
      botRatedCount: 1,
    });
    // 恢复计分后这一场按人机目标分结算：输了就把分往下带。
    expect(rating.rating).toBeLessThan(1500);
    expect(rating.lastPlayedAt).toBeGreaterThan(RANKED_START_MS + 86_400_000);
  });
});

describe("结算写库的退避重试", () => {
  test("前两次失败第三次成功：结算状态是 rated，审计读得到", async () => {
    const store = new FlakyStore(2);
    const harness = rankedHarness({ store });
    const client = harness.connect("甲");
    await startBotSeries(harness, client);
    const seriesId = harness.seriesView(client).seriesId;

    const pendingExit = harness.send(client, "cee.ranked.exit", {});
    // 首次写库失败后才排上 1 秒退避，随后是 3 秒：两次推进覆盖前两次重试。
    await harness.advance(2_000);
    await harness.advance(14_000);
    await pendingExit;

    expect(store.attempts).toBe(3);
    expect(harness.seriesView(client).result?.settlement).toBe("rated");
    const audit = await readAudit(harness, seriesId);
    expect(audit.players.length).toBe(2);
    expect(harness.logs.error.filter((item) => item.message === "排位结算写库失败")).toEqual([]);
  });

  test("全部尝试都失败：settlement 为 failed 并记错误日志，审计不落库", async () => {
    // 首次 + 1 / 3 / 9 秒三次重试都用掉，下一场才重新尝试写库。
    const store = new FlakyStore(4);
    const harness = rankedHarness({ store });
    const client = harness.connect("甲");
    await startBotSeries(harness, client);
    const seriesId = harness.seriesView(client).seriesId;

    const pendingExit = harness.send(client, "cee.ranked.exit", {});
    await harness.advance(2_000);
    // 结算中再排队只会读到「上一场还在结算」：账号在 settling 里停留到写库彻底落定。
    const settling = await appErrorOf(() => harness.send(client, "cee.ranked.queue", {}));
    expect({ code: settling.code, message: settling.message }).toEqual({
      code: "RANKED_SETTLING",
      message: "上一场还在结算",
    });
    await harness.advance(16_000);
    await pendingExit;

    // 首次 + 1 / 3 / 9 秒三次重试。
    expect(store.attempts).toBe(4);
    expect(harness.seriesView(client).result).toEqual({
      outcome: "lost",
      reason: "exit",
      settlement: "failed",
      ratingBefore: null,
      ratingAfter: null,
      placementPlayed: null,
    });
    expect(harness.logs.error.map((item) => item.message)).toContain("排位结算写库失败");
    expect(await harness.store.getSeriesAudit(seriesId)).toBeNull();

    // 写库失败不锁死账号：结算标记落定后既能重新排队，下一场照常落库。
    await harness.send(client, "cee.ranked.queue", {});
    expect(harness.latest(client).status).toBe("queued");
    await harness.advance(CEE_RANKED_BOT_FALLBACK_MS);
    const nextSeriesId = harness.seriesView(client).seriesId;
    await harness.send(client, "cee.ranked.exit", {});
    expect(store.attempts).toBe(5);
    expect((await readAudit(harness, nextSeriesId)).players.length).toBe(2);
  });
});
