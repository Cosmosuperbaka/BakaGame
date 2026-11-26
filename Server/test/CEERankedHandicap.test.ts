import { describe, expect, test } from "bun:test";
import {
  CEE_RANKED_BOT_BIAS_PRIOR,
  CEE_RANKED_HANDICAP_ACCOUNT_SHARE,
  CEE_RANKED_HANDICAP_MAX_PLAYER_RD,
  CEERankedHandicap,
  ceeRankedHandicapWeights,
  estimateCEERankedBotBias,
  type CEERankedBotSample,
} from "../src/application/CEERankedHandicap";
import { CEE_RANKED_BOT_RD, expectedCEESeriesScore } from "../src/domain/CEERankedRating";

let nextUser = 0;
/** 缺省每条样本来自不同账号：单账号权重上限另有用例专门盯。 */
const sample = (
  group: CEERankedBotSample["group"],
  score: CEERankedBotSample["score"],
  overrides: Partial<CEERankedBotSample> = {}
): CEERankedBotSample => ({
  group,
  userId: `u-${(nextUser += 1)}`,
  placement: false,
  playerRating: 1500,
  playerRd: 100,
  strengthRating: 1500,
  score,
  ...overrides,
});

/** n 条同组样本，按 wins 的比例给真人判胜（其余判负）。 */
const mix = (
  group: CEERankedBotSample["group"],
  total: number,
  wins: number,
  overrides: Partial<CEERankedBotSample> = {}
): CEERankedBotSample[] =>
  Array.from({ length: total }, (_unused, index) => sample(group, index < wins ? 1 : 0, overrides));

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

  test("权重让被打折的样本少算：同一批样本，输的一半权重减半，估计值向赢的一边偏", () => {
    const samples = [...mix("regular", 20, 20), ...mix("regular", 20, 0)];
    const even = estimateCEERankedBotBias(samples);
    const weights = samples.map((item) => (item.score === 0 ? 0.5 : 1));
    expect(even).toBeCloseTo(0, 6);
    expect(estimateCEERankedBotBias(samples, weights)).toBeLessThan(-50);
  });
});

describe("排位人机校准样本的筛选与权重", () => {
  test("定级中或真人偏差超过上限的样本不进窗口，也不计入累计数", () => {
    const handicap = new CEERankedHandicap({ minSamples: 1 });
    expect(handicap.add(sample("regular", 0, { placement: true }))).toBe(false);
    expect(
      handicap.add(sample("regular", 0, { playerRd: CEE_RANKED_HANDICAP_MAX_PLAYER_RD + 1 }))
    ).toBe(false);
    expect(handicap.count("regular")).toBe(0);
    expect(handicap.total("regular")).toBe(0);
    expect(handicap.bias("regular")).toBe(CEE_RANKED_BOT_BIAS_PRIOR.regular);
    expect(
      handicap.add(sample("regular", 0, { playerRd: CEE_RANKED_HANDICAP_MAX_PLAYER_RD }))
    ).toBe(true);
    expect(handicap.count("regular")).toBe(1);
    // 启动种子同样过筛。
    handicap.seed([sample("regular", 0, { placement: true })]);
    expect(handicap.count("regular")).toBe(1);
  });

  test("单个账号的权重合计封顶在窗口的一定比例", () => {
    const heavy = mix("regular", 8, 0, { userId: "u-heavy" });
    const others = mix("regular", 2, 1);
    const weights = ceeRankedHandicapWeights([...heavy, ...others]);
    const cap = CEE_RANKED_HANDICAP_ACCOUNT_SHARE * 10;
    expect(weights.slice(0, 8).reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(cap, 9);
    expect(weights.slice(8)).toEqual([1, 1]);
  });

  test("一个账号刷满窗口也左右不了偏差：其余账号对半胜负时估计值仍贴近 0", () => {
    const handicap = new CEERankedHandicap({ minSamples: 1, limit: 1_000 });
    const heavy = mix("regular", 60, 0, { userId: "u-heavy" });
    const others = mix("regular", 40, 20);
    for (const item of [...heavy, ...others]) handicap.add(item);
    const unweighted = estimateCEERankedBotBias([...heavy, ...others]);
    expect(unweighted).toBeGreaterThan(150);
    expect(handicap.bias("regular")).toBeLessThan(unweighted / 2);
  });

  test("累计数不随窗口滚动封顶：日志按它判断节奏", () => {
    const handicap = new CEERankedHandicap({ window: 3 });
    for (const item of mix("regular", 5, 0)) handicap.add(item);
    expect(handicap.count("regular")).toBe(3);
    expect(handicap.total("regular")).toBe(5);
    // 启动种子只是回填窗口，不算本进程新收的样本。
    handicap.seed(mix("aiga", 2, 0));
    expect(handicap.total("aiga")).toBe(0);
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
    const old = mix("regular", 3, 3, { strengthRating: 2_000 });
    const fresh = mix("regular", 3, 0);
    const handicap = new CEERankedHandicap({ window: 3, minSamples: 1, limit: 1_000 });
    // 存储端口按结束时间倒序返回：最新的排在最前。
    handicap.seed([...fresh, ...old]);
    expect(handicap.count("regular")).toBe(3);
    expect(handicap.bias("regular")).toBeCloseTo((estimateCEERankedBotBias(fresh) * 3) / 53, 6);
  });

  test("两组先验都是 0：强度分已按实战分标定，爱噶强出的部分是真快出来的，不另加计分溢价", () => {
    expect(CEE_RANKED_BOT_BIAS_PRIOR).toEqual({ regular: 0, aiga: 0 });
    const handicap = new CEERankedHandicap({ minSamples: 30, limit: 1_000 });
    expect(handicap.bias("aiga")).toBe(0);
    // 真人输多赢少：30 条样本把估计值按 30/80 收缩。
    const losing = mix("aiga", 30, 10);
    for (const item of losing) handicap.add(item);
    const estimate = estimateCEERankedBotBias(losing);
    expect(estimate).toBeGreaterThan(0);
    expect(handicap.bias("aiga")).toBeCloseTo((estimate * 30) / 80, 6);
  });

  test("两组人机的样本互不干扰", () => {
    const handicap = new CEERankedHandicap({ minSamples: 2, limit: 400 });
    handicap.add(sample("aiga", 0));
    for (const item of mix("regular", 2, 0)) handicap.add(item);
    expect(handicap.bias("aiga")).toBe(CEE_RANKED_BOT_BIAS_PRIOR.aiga);
    expect(handicap.bias("regular")).toBeGreaterThan(0);
    for (const item of mix("aiga", 40, 40)) handicap.add(item);
    expect(handicap.bias("aiga")).toBeLessThan(0);
    expect(handicap.bias("regular")).toBeGreaterThan(0);
  });
});
