import { describe, expect, test } from "bun:test";
import {
  CEE_RANKED_BOT_RD,
  CEE_RANKED_RD_MAX,
  CEE_RANKED_RD_MIN,
  CEE_RANKED_RATING_PERIOD_MS,
  CEE_RANKED_SERIES_SCALE,
  conservativeCEERating,
  createCEERating,
  displayCEERating,
  expectedCEESeriesScore,
  inflateCEERatingDeviation,
  rateCEEBotSeries,
  rateCEESeries,
  updateCEERatingPeriod,
  type CEERating,
} from "../src/domain/CEERankedRating";

const player = (overrides: Partial<CEERating> = {}): CEERating => ({
  rating: 1500,
  rd: 60,
  lastPlayedAt: null,
  ...overrides,
});
const near = (value: number, reference: number, tolerance: number): void => {
  expect(Math.abs(value - reference)).toBeLessThan(tolerance);
};

describe("CEE 排位评分", () => {
  test("单局口径与 Glicko-1 论文算例一致", () => {
    const result = updateCEERatingPeriod(
      { rating: 1500, rd: 200 },
      [
        { opponent: { rating: 1400, rd: 30 }, score: 1 },
        { opponent: { rating: 1550, rd: 100 }, score: 0 },
        { opponent: { rating: 1700, rd: 300 }, score: 0 },
      ],
      1
    );
    near(result.rating, 1464.11, 0.05);
    near(result.rd, 151.4, 0.05);
  });
  test("两个新人打一场系列赛，胜方涨到约 1675 且双方偏差同样收窄", () => {
    const [a, b] = rateCEESeries(createCEERating(), createCEERating(), 1, 0);
    near(a.rating, 1674.99, 0.05);
    near(a.rd, 246.13, 0.05);
    near(b.rating, 1325.01, 0.05);
    near(b.rd, 246.13, 0.05);
  });
  test("系列赛涨幅是单局口径的 1.4 到 1.5 倍", () => {
    const stable = player();
    const [a] = rateCEESeries(stable, stable, 1, 0);
    const single = updateCEERatingPeriod(
      { rating: 1500, rd: 60 },
      [{ opponent: { rating: 1500, rd: 60 }, score: 1 }],
      1
    );
    near(a.rating, 1514.34, 0.05);
    near(a.rd, 58.15, 0.05);
    near(single.rating, 1509.89, 0.05);
    const ratio = (a.rating - 1500) / (single.rating - 1500);
    expect(ratio).toBeGreaterThan(1.4);
    expect(ratio).toBeLessThan(1.5);
  });
  test("稳定玩家平局只收窄偏差，不动分数", () => {
    const stable = player();
    const [a, b] = rateCEESeries(stable, stable, 0.5, 0);
    near(a.rating, 1500, 1e-9);
    near(b.rating, 1500, 1e-9);
    near(a.rd, 58.15, 0.05);
    near(b.rd, 58.15, 0.05);
  });
  test("高分方赢下低 150 分的稳定对手仍有小涨", () => {
    const favourite = player({ rating: 1650 });
    const [a] = rateCEESeries(favourite, player(), 1, 0);
    expect(a.rating - 1650).toBeGreaterThan(0);
    near(a.rating - 1650, 6.4, 0.05);
    near(expectedCEESeriesScore({ rating: 1650, rd: 60 }, { rating: 1500, rd: 60 }), 0.7811, 0.001);
  });
  test("人机局按最大偏差打折，胜负两个方向都在同一区间", () => {
    const fresh = player({ rd: 80 });
    const human = player({ rd: 80 });
    const winHuman = rateCEESeries(fresh, human, 1, 0)[0];
    const winBot = rateCEEBotSeries(fresh, 1500, 1, 0);
    const loseHuman = rateCEESeries(fresh, human, 0, 0)[0];
    const loseBot = rateCEEBotSeries(fresh, 1500, 0, 0);
    expect(CEE_RANKED_BOT_RD).toBe(CEE_RANKED_RD_MAX);
    near((winBot.rating - 1500) / (winHuman.rating - 1500), 0.729, 0.01);
    near((loseBot.rating - 1500) / (loseHuman.rating - 1500), 0.729, 0.01);
    expect((winBot.rating - 1500) / (winHuman.rating - 1500)).toBeGreaterThan(0.65);
    expect((winBot.rating - 1500) / (winHuman.rating - 1500)).toBeLessThan(0.8);
    expect((loseBot.rating - 1500) / (loseHuman.rating - 1500)).toBeGreaterThan(0.65);
    expect((loseBot.rating - 1500) / (loseHuman.rating - 1500)).toBeLessThan(0.8);
  });
  test("时间膨胀按天回涨偏差并夹在上限", () => {
    expect(inflateCEERatingDeviation(createCEERating(), 10 * CEE_RANKED_RATING_PERIOD_MS)).toEqual(
      createCEERating()
    );
    expect(inflateCEERatingDeviation(player({ lastPlayedAt: 1000 }), 1000).rd).toBe(60);
    near(
      inflateCEERatingDeviation(player({ lastPlayedAt: 0 }), 30 * CEE_RANKED_RATING_PERIOD_MS).rd,
      92.28,
      0.05
    );
    near(
      inflateCEERatingDeviation(player({ lastPlayedAt: 0 }), 3650 * CEE_RANKED_RATING_PERIOD_MS).rd,
      CEE_RANKED_RD_MAX,
      1e-9
    );
  });
  test("结算前先膨胀：与手动膨胀加批量更新的口径一致", () => {
    const stale = player({ lastPlayedAt: 0 });
    const now = 30 * CEE_RANKED_RATING_PERIOD_MS;
    const inflated = inflateCEERatingDeviation(stale, now);
    const manual = updateCEERatingPeriod(inflated, [
      { opponent: { rating: 1500, rd: 60 }, score: 1 },
    ]);
    const [a] = rateCEESeries(stale, player(), 1, now);
    near(a.rating, manual.rating, 1e-9);
    near(a.rd, manual.rd, 1e-9);
    expect(a.rd).toBeGreaterThan(60);
  });
  test("同分对手连续结算时偏差不低于下限", () => {
    let current = player({ lastPlayedAt: 0 });
    for (let i = 0; i < 300; i++) {
      current = rateCEESeries(current, player({ lastPlayedAt: 0 }), 1, 0)[0];
      expect(current.rd).toBeGreaterThanOrEqual(CEE_RANKED_RD_MIN);
    }
    expect(current.rd).toBeLessThan(60);
    expect(current.rating).toBeGreaterThan(1500);
  });
  test("结算写入本场时刻", () => {
    const now = 1_700_000_000_000;
    const [a, b] = rateCEESeries(createCEERating(), createCEERating(), 1, now);
    expect(a.lastPlayedAt).toBe(now);
    expect(b.lastPlayedAt).toBe(now);
    expect(rateCEEBotSeries(createCEERating(), 1500, 1, now).lastPlayedAt).toBe(now);
  });
  test("定档用保守分、展示用四舍五入分", () => {
    expect(conservativeCEERating(createCEERating(), 0)).toBe(1150);
    expect(conservativeCEERating(player({ rating: 1500, rd: 60, lastPlayedAt: null }), 0)).toBe(
      1440
    );
    expect(displayCEERating({ rating: 1514.34 })).toBe(1514);
    expect(displayCEERating({ rating: 1514.6 })).toBe(1515);
  });
  test("极端分差不产生非有限数值", () => {
    for (const score of [1, 0] as const) {
      for (const [a, b] of [
        [player({ rating: 3000, rd: 350 }), player({ rating: 500, rd: 350 })],
        [player({ rating: 500, rd: 350 }), player({ rating: 3000, rd: 350 })],
      ]) {
        const [nextA, nextB] = rateCEESeries(a, b, score, 0);
        for (const value of [nextA.rating, nextA.rd, nextB.rating, nextB.rd]) {
          expect(Number.isFinite(value)).toBe(true);
        }
        expect(nextA.rd).toBeGreaterThanOrEqual(CEE_RANKED_RD_MIN);
        expect(nextA.rd).toBeLessThanOrEqual(CEE_RANKED_RD_MAX);
      }
    }
  });
  test("缺省放大系数与空结果不改评级", () => {
    expect(CEE_RANKED_SERIES_SCALE).toBe(1.5);
    expect(updateCEERatingPeriod({ rating: 1500, rd: 60 }, [])).toEqual({ rating: 1500, rd: 60 });
    expect(
      updateCEERatingPeriod({ rating: 1500, rd: 60 }, [
        { opponent: { rating: 1500, rd: 60 }, score: 1 },
      ])
    ).toEqual(
      updateCEERatingPeriod(
        { rating: 1500, rd: 60 },
        [{ opponent: { rating: 1500, rd: 60 }, score: 1 }],
        CEE_RANKED_SERIES_SCALE
      )
    );
  });
});
