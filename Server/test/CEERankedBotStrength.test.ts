import { describe, expect, it } from "bun:test";
import {
  CEE_RANKED_AIGA_OPENING_ID,
  CEE_RANKED_BOT_ANCHORS,
  CEE_RANKED_PERSONAS,
  ceeRankedBotStrength,
  pickCEERankedPersona,
  type CEERankedBotStrength,
  type CEERankedPersonaId,
} from "../src/domain/CEERankedBotProfile";
import { createCEERankedBot } from "../src/domain/CEERankedBot";
import { CEE_RANKED_ALL_DIMENSIONS } from "../src/domain/CEERankedSolver";
import { anchorStrength, personaOf, pool, poolIds } from "./support/CEERankedBotFixtures";
import { scripted, seeded } from "./support/Random";

describe("CEE 排位人机强度", () => {
  it("锚点处的数值与锚点表完全一致", () => {
    for (const anchor of CEE_RANKED_BOT_ANCHORS)
      expect(ceeRankedBotStrength(anchor.rating, scripted([0.5]))).toEqual(anchor.strength);
  });

  it("1250 分（1100 与 1400 正中间）的数值在相邻锚点间线性插值", () => {
    const strength = ceeRankedBotStrength(1250, scripted([0.5]));
    expect(strength.knowledge).toBeCloseTo(0.15, 12);
    expect(strength.thinkMedianMs).toBe(33500);
    expect(strength.thinkSigma).toBe(0.8);
    expect(strength.noise).toBeCloseTo(0.65, 12);
    expect(strength.mistakeRate).toBeCloseTo(0.185, 12);
    expect(strength.recallRate).toBeCloseTo(0.1, 12);
    expect(strength.sampleSize).toBe(12);
    expect(strength.openingTopK).toBe(10);
    // 不完美推理的四个字段同样线性插值：memory 取整（2.5 → 3），两个可靠度与首猜中位数照抄插值结果。
    expect(strength.memory).toBe(3);
    expect(strength.numericReliability).toBeCloseTo(0.425, 12);
    expect(strength.evidenceReliability).toBeCloseTo(0.15, 12);
    expect(strength.firstGuessMedianMs).toBe(11500);
  });

  it("分数超出锚点范围时夹到两端", () => {
    expect(ceeRankedBotStrength(0, scripted([0.5]))).toEqual(CEE_RANKED_BOT_ANCHORS[0].strength);
    expect(ceeRankedBotStrength(99999, scripted([0.5]))).toEqual(
      CEE_RANKED_BOT_ANCHORS[CEE_RANKED_BOT_ANCHORS.length - 1].strength
    );
  });

  it("离散字段整体取自最近锚点或其相邻锚点", () => {
    for (let rating = 800; rating <= 2300; rating += 17) {
      const distances = CEE_RANKED_BOT_ANCHORS.map((anchor) => Math.abs(anchor.rating - rating));
      const nearest = distances.indexOf(Math.min(...distances));
      const allowed = [nearest - 1, nearest, nearest + 1]
        .filter((index) => index >= 0 && index < CEE_RANKED_BOT_ANCHORS.length)
        .map((index) => CEE_RANKED_BOT_ANCHORS[index].strength);
      const strength = ceeRankedBotStrength(rating, seeded(rating));
      // 三个离散字段同属一档，不能各取一档拼出中间值。
      expect(
        allowed.some(
          (anchor) =>
            anchor.strategy === strength.strategy &&
            anchor.lockThreshold === strength.lockThreshold &&
            anchor.dims.join("|") === strength.dims.join("|")
        )
      ).toBe(true);
    }
  });
});

describe("CEE 排位人机人格", () => {
  it("六个人格齐全，爱噶有固定首猜编号", () => {
    expect(CEE_RANKED_PERSONAS.map((persona) => persona.id)).toEqual([
      "aiga",
      "dango",
      "awen",
      "kaoju",
      "mangmang",
      "yemao",
    ]);
    expect(personaOf("aiga").name).toBe("爱噶");
    expect(CEE_RANKED_AIGA_OPENING_ID).toBe(132476);
  });

  it("avoid 指定后 1000 次也抽不到被避开的人格，不指定时六个都能抽到", () => {
    const avoided = seeded(20261031);
    for (let index = 0; index < 1000; index += 1)
      expect(pickCEERankedPersona(avoided, "kaoju").id).not.toBe("kaoju");
    const open = seeded(20261031);
    const drawn = new Set(
      Array.from({ length: 1000 }, () => pickCEERankedPersona(open).id) as CEERankedPersonaId[]
    );
    expect(drawn.size).toBe(CEE_RANKED_PERSONAS.length);
  });

  it("考据君把证据类维度并进强度，爱噶固定用全维度并认识整个题库", () => {
    const numeric = anchorStrength(800);
    const kaoju = createCEERankedBot({
      persona: personaOf("kaoju"),
      strength: numeric,
      opponentRating: 1000,
      pool,
      random: seeded(1),
    });
    expect([...kaoju.strength.dims].sort()).toEqual([...CEE_RANKED_ALL_DIMENSIONS].sort());
    expect(kaoju.known.size).toBe(Math.round(numeric.knowledge * poolIds.length));
    expect(kaoju.strength.knowledge).toBe(numeric.knowledge);
    const aiga = createCEERankedBot({
      persona: personaOf("aiga"),
      strength: numeric,
      opponentRating: 1000,
      pool,
      random: seeded(1),
    });
    expect(aiga.strength.dims).toEqual(CEE_RANKED_ALL_DIMENSIONS);
    expect(aiga.known.size).toBe(poolIds.length);
  });
});

describe("CEE 排位人机锚点表单调", () => {
  const strengthOf = (index: number): CEERankedBotStrength =>
    CEE_RANKED_BOT_ANCHORS[index].strength;

  it("分数越高知道得越多、回忆更勤、记得更多、两条可靠度更高", () => {
    for (let index = 1; index < CEE_RANKED_BOT_ANCHORS.length; index += 1) {
      const previous = strengthOf(index - 1);
      const next = strengthOf(index);
      expect(next.knowledge).toBeGreaterThanOrEqual(previous.knowledge);
      expect(next.recallRate).toBeGreaterThanOrEqual(previous.recallRate);
      expect(next.memory).toBeGreaterThanOrEqual(previous.memory);
      expect(next.numericReliability).toBeGreaterThan(previous.numericReliability);
      expect(next.evidenceReliability).toBeGreaterThan(previous.evidenceReliability);
    }
  });

  it("分数越高思考越快，首猜与后续间隔都单调递减", () => {
    for (let index = 1; index < CEE_RANKED_BOT_ANCHORS.length; index += 1) {
      const previous = strengthOf(index - 1);
      const next = strengthOf(index);
      expect(next.thinkMedianMs).toBeLessThan(previous.thinkMedianMs);
      expect(next.firstGuessMedianMs).toBeLessThan(previous.firstGuessMedianMs);
      // 首猜比后续每一手都快：看题与回忆名单的时间算在首猜里，弱档也不能慢于真人 p90。
      expect(next.firstGuessMedianMs).toBeLessThanOrEqual(next.thinkMedianMs);
    }
  });

  it("插值后的四个新字段同样单调（1200 分介于两档之间）", () => {
    const low = ceeRankedBotStrength(1100, scripted([0.5]));
    const mid = ceeRankedBotStrength(1200, scripted([0.5]));
    const high = ceeRankedBotStrength(1400, scripted([0.5]));
    expect(mid.memory).toBeGreaterThanOrEqual(low.memory);
    expect(mid.memory).toBeLessThanOrEqual(high.memory);
    expect(mid.numericReliability).toBeGreaterThan(low.numericReliability);
    expect(mid.numericReliability).toBeLessThan(high.numericReliability);
    expect(mid.evidenceReliability).toBeGreaterThan(low.evidenceReliability);
    expect(mid.evidenceReliability).toBeLessThan(high.evidenceReliability);
    expect(mid.firstGuessMedianMs).toBeLessThan(low.firstGuessMedianMs);
    expect(mid.firstGuessMedianMs).toBeGreaterThan(high.firstGuessMedianMs);
  });
});
