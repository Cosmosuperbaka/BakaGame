import { describe, expect, test } from "bun:test";
import {
  CEERankedHandicap,
  estimateCEERankedBotBias,
  type CEERankedBotSample,
} from "../src/application/CEERankedHandicap";
import { CEE_RANKED_BOT_RD, expectedCEESeriesScore } from "../src/domain/CEERankedRating";

const sample = (
  group: CEERankedBotSample["group"],
  score: CEERankedBotSample["score"],
  playerRating = 1500,
  strengthRating = playerRating,
  playerRd = 100
): CEERankedBotSample => ({ group, playerRating, playerRd, strengthRating, score });

/** n 条同组样本，按 wins 的比例给真人判胜（其余判负）。 */
const mix = (
  group: CEERankedBotSample["group"],
  total: number,
  wins: number
): CEERankedBotSample[] =>
  Array.from({ length: total }, (_unused, index) => sample(group, index < wins ? 1 : 0));

describe("排位人机偏差估计", () => {
  test("没有样本就不偏", () => {
    expect(estimateCEERankedBotBias([])).toBe(0);
  });

  test("同标称分下真人一场没赢，说明人机远强于标称", () => {
    const bias = estimateCEERankedBotBias(mix("regular", 40, 0));
    expect(bias).toBeGreaterThan(400);
    // 搜索区间夹取：全负时顶到上界，不会再往外 extrapolate。
    expect(bias).toBe(600);
  });

  test("同标称分下真人对半胜负，说明强度标定准确", () => {
    expect(estimateCEERankedBotBias(mix("regular", 40, 20))).toBeCloseTo(0, 6);
  });

  test("真人赢得越少，估出的偏差越大", () => {
    const wins = estimateCEERankedBotBias(mix("regular", 40, 30));
    const even = estimateCEERankedBotBias(mix("regular", 40, 20));
    const loses = estimateCEERankedBotBias(mix("regular", 40, 10));
    expect(wins).toBeLessThan(even);
    expect(even).toBeLessThan(loses);
  });

  test("估计值让期望得分与真实得分对得上", () => {
    const samples = mix("aiga", 30, 12);
    const bias = estimateCEERankedBotBias(samples);
    let expected = 0;
    for (const item of samples) {
      expected += expectedCEESeriesScore(
        { rating: item.playerRating, rd: item.playerRd },
        { rating: item.strengthRating + bias, rd: CEE_RANKED_BOT_RD }
      );
    }
    expect(expected).toBeCloseTo(12, 4);
  });

  test("人机弱于标称时偏差为负", () => {
    expect(estimateCEERankedBotBias(mix("regular", 40, 40))).toBe(-600);
  });
});

describe("排位人机校准窗口", () => {
  test("样本没到下限就不施加偏差", () => {
    const handicap = new CEERankedHandicap({ minSamples: 30 });
    for (const item of mix("regular", 29, 0)) handicap.add(item);
    expect(handicap.bias("regular")).toBe(0);
    handicap.add(sample("regular", 0));
    expect(handicap.bias("regular")).toBeGreaterThan(0);
  });

  test("偏差按样本量收缩，越多样本越接近估计值", () => {
    const handicap = new CEERankedHandicap({ minSamples: 1, limit: 1_000 });
    const samples = mix("regular", 30, 0);
    const estimate = estimateCEERankedBotBias(samples);
    for (const item of samples) handicap.add(item);
    expect(handicap.bias("regular")).toBeCloseTo((estimate * 30) / 80, 6);
    handicap.add(sample("regular", 0));
    const grown = estimateCEERankedBotBias([...samples, sample("regular", 0)]);
    expect(handicap.bias("regular")).toBeCloseTo((grown * 31) / 81, 6);
    expect(Math.abs(handicap.bias("regular"))).toBeGreaterThan(Math.abs((estimate * 30) / 80));
  });

  test("偏差夹到 ±limit", () => {
    const upper = new CEERankedHandicap({ minSamples: 2, limit: 10 });
    for (const item of mix("regular", 2, 0)) upper.add(item);
    expect(upper.bias("regular")).toBe(10);
    const lower = new CEERankedHandicap({ minSamples: 2, limit: 10 });
    for (const item of mix("regular", 2, 2)) lower.add(item);
    expect(lower.bias("regular")).toBe(-10);
  });

  test("窗口滚动：只按最近 window 条样本计", () => {
    const handicap = new CEERankedHandicap({ window: 4, minSamples: 1, limit: 1_000 });
    for (const item of mix("regular", 4, 4)) handicap.add(item);
    // 最近四条里只剩一场胜，早期的全胜记录被挤出去。
    for (const item of mix("regular", 3, 0)) handicap.add(item);
    const recent = [...mix("regular", 4, 4), ...mix("regular", 3, 0)].slice(-4);
    expect(handicap.count("regular")).toBe(4);
    expect(handicap.bias("regular")).toBeCloseTo((estimateCEERankedBotBias(recent) * 4) / 54, 6);
    expect(handicap.bias("regular")).toBeGreaterThan(0);
  });

  test("seed 收到倒序历史时留下的是最近的样本", () => {
    const old = mix("regular", 3, 4).map((item) => ({ ...item, strengthRating: 2_000 }));
    const fresh = mix("regular", 3, 0);
    const handicap = new CEERankedHandicap({ window: 3, minSamples: 1, limit: 1_000 });
    // 存储端口按结束时间倒序返回：最新的排在最前。
    handicap.seed([...fresh, ...old]);
    expect(handicap.count("regular")).toBe(3);
    expect(handicap.bias("regular")).toBeCloseTo((estimateCEERankedBotBias(fresh) * 3) / 53, 6);
  });

  test("两组人机的样本互不干扰", () => {
    const handicap = new CEERankedHandicap({ minSamples: 2, limit: 400 });
    handicap.add(sample("aiga", 0));
    for (const item of mix("regular", 2, 0)) handicap.add(item);
    expect(handicap.bias("aiga")).toBe(0);
    expect(handicap.bias("regular")).toBeGreaterThan(0);
    for (const item of mix("aiga", 40, 40)) handicap.add(item);
    expect(handicap.bias("aiga")).toBeLessThan(0);
    expect(handicap.bias("regular")).toBeGreaterThan(0);
  });
});
