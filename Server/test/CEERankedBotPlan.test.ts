// ==================== 排位人机的档位、实战分与开局定强度 ====================
// 档位只是强度表的索引，实战分才是与玩家同一尺度的分数；这里盯换算、人格偏移与碰顶时的取值。
import { describe, expect, it } from "bun:test";
import {
  CEE_RANKED_BOT_ANCHORS,
  CEE_RANKED_BOT_RATING_RANGE,
  CEE_RANKED_KNOWLEDGE_REFERENCE_POOL,
  CEE_RANKED_PERSONA_OFFSET_LEVELS,
  CEE_RANKED_PERSONAS,
  ceeRankedBotLevelOfRating,
  ceeRankedBotRatingOfLevel,
  ceeRankedKnownCount,
  ceeRankedPersonaOffset,
} from "../src/domain/CEERankedBotProfile";
import {
  CEE_RANKED_AIGA_EDGE,
  CEE_RANKED_BOT_NOMINAL_SPREAD,
  ceeRankedBotNominal,
  planCEERankedBot,
} from "../src/domain/CEERankedBotPlan";
import { CEE_RANKED_AIGA_RATING_RANGE } from "../src/domain/CEERankedBotTiming";
import { personaOf } from "./support/CEERankedBotFixtures";
import { scripted } from "./support/Random";

describe("排位人机档位与实战分", () => {
  it("锚点处档位与实战分互为反函数，锚点之间线性插值", () => {
    for (const anchor of CEE_RANKED_BOT_ANCHORS) {
      expect(ceeRankedBotRatingOfLevel(anchor.level)).toBeCloseTo(anchor.rating, 9);
      expect(ceeRankedBotLevelOfRating(anchor.rating)).toBeCloseTo(anchor.level, 9);
    }
    const [low, high] = [CEE_RANKED_BOT_ANCHORS[2], CEE_RANKED_BOT_ANCHORS[3]];
    const midLevel = (low.level + high.level) / 2;
    expect(ceeRankedBotRatingOfLevel(midLevel)).toBeCloseTo((low.rating + high.rating) / 2, 9);
    for (const rating of [1000, 1333, 1650, 1990, 2200])
      expect(ceeRankedBotRatingOfLevel(ceeRankedBotLevelOfRating(rating))).toBeCloseTo(rating, 9);
  });

  it("1400 档钉在 1400 分：这是新旧版本共用的标尺", () => {
    expect(ceeRankedBotRatingOfLevel(1400)).toBe(1400);
  });

  it("实战分随档位严格递增，超出范围夹到两端", () => {
    CEE_RANKED_BOT_ANCHORS.forEach((anchor, index) => {
      if (index > 0)
        expect(anchor.rating).toBeGreaterThan(CEE_RANKED_BOT_ANCHORS[index - 1].rating);
    });
    const first = CEE_RANKED_BOT_ANCHORS[0];
    const last = CEE_RANKED_BOT_ANCHORS[CEE_RANKED_BOT_ANCHORS.length - 1];
    expect(CEE_RANKED_BOT_RATING_RANGE).toEqual({ min: first.rating, max: last.rating });
    expect(ceeRankedBotLevelOfRating(first.rating - 300)).toBe(first.level);
    expect(ceeRankedBotLevelOfRating(last.rating + 300)).toBe(last.level);
    expect(ceeRankedBotRatingOfLevel(last.level + 500)).toBe(last.rating);
  });
});

describe("排位人机知识量随题库缩放", () => {
  it("参考题库下就是比例本身，题库变大认识的比例按平方根变低", () => {
    expect(ceeRankedKnownCount(0.2, CEE_RANKED_KNOWLEDGE_REFERENCE_POOL)).toBe(60);
    // 题库四倍大：人数只翻倍，比例减半。
    expect(ceeRankedKnownCount(0.2, CEE_RANKED_KNOWLEDGE_REFERENCE_POOL * 4)).toBe(120);
    expect(ceeRankedKnownCount(0.2, 75)).toBe(30);
  });

  it("至少认识 1 个，不超过题库，空题库为 0", () => {
    expect(ceeRankedKnownCount(0, 300)).toBe(1);
    expect(ceeRankedKnownCount(0.9, 50)).toBe(50);
    expect(ceeRankedKnownCount(0.5, 0)).toBe(0);
  });
});

describe("排位人格偏移", () => {
  it("在偏移档位之间线性插值，两端之外取端点值", () => {
    const awen = personaOf("awen");
    const levels = CEE_RANKED_PERSONA_OFFSET_LEVELS;
    const offsets = awen.ratingOffsets;
    expect(offsets.length).toBe(levels.length);
    levels.forEach((level, index) => {
      expect(ceeRankedPersonaOffset(awen, level)).toBe(offsets[index]);
    });
    expect(ceeRankedPersonaOffset(awen, (levels[0] + levels[1]) / 2)).toBeCloseTo(
      (offsets[0] + offsets[1]) / 2,
      9
    );
    expect(ceeRankedPersonaOffset(awen, levels[0] - 600)).toBe(offsets[0]);
    expect(ceeRankedPersonaOffset(awen, levels[levels.length - 1] + 600)).toBe(
      offsets[offsets.length - 1]
    );
  });

  it("每个人格的强度分随档位严格递增：开局才能按想要的分数反查唯一的档位", () => {
    const first = CEE_RANKED_BOT_ANCHORS[0].level;
    const last = CEE_RANKED_BOT_ANCHORS[CEE_RANKED_BOT_ANCHORS.length - 1].level;
    for (const persona of CEE_RANKED_PERSONAS) {
      let previous = Number.NEGATIVE_INFINITY;
      for (let level = first; level <= last; level += 25) {
        const strength = ceeRankedBotRatingOfLevel(level) + ceeRankedPersonaOffset(persona, level);
        expect(strength).toBeGreaterThan(previous);
        previous = strength;
      }
    }
  });

  it("爱噶不走强度表，偏移恒为 0", () => {
    for (const level of [800, 1400, 2900])
      expect(ceeRankedPersonaOffset(personaOf("aiga"), level)).toBe(0);
  });
});

describe("排位人机开局定强度", () => {
  it("标称分：普通人格在玩家分数上下浮动，爱噶固定高出一截且不消耗随机数", () => {
    const dango = personaOf("dango");
    expect(ceeRankedBotNominal(dango, 1500, scripted([0]))).toBe(
      1500 - CEE_RANKED_BOT_NOMINAL_SPREAD
    );
    expect(ceeRankedBotNominal(dango, 1500, scripted([0.5]))).toBe(1500);
    let draws = 0;
    const counting = (): number => {
      draws += 1;
      return 0.5;
    };
    expect(ceeRankedBotNominal(personaOf("aiga"), 1500, counting)).toBe(
      1500 + CEE_RANKED_AIGA_EDGE
    );
    expect(draws).toBe(0);
  });

  it("普通人格在范围内时：强度分 = 档位实战分 + 人格偏移，计分分 = 标称分", () => {
    for (const id of ["dango", "awen", "kaoju", "mangmang", "yemao"] as const) {
      const persona = personaOf(id);
      for (const nominal of [1300, 1600, 1900, 2600, 3500, 4300]) {
        const plan = planCEERankedBot({ persona, nominal, bias: 0 });
        expect(plan.strengthRating).toBeCloseTo(
          ceeRankedBotRatingOfLevel(plan.level) + ceeRankedPersonaOffset(persona, plan.level),
          9
        );
        expect(plan.targetRating).toBeCloseTo(nominal, 0);
      }
    }
  });

  it("偏差为正时先扣掉再找档位，计分分加回来仍是标称分", () => {
    const persona = personaOf("kaoju");
    const plain = planCEERankedBot({ persona, nominal: 1700, bias: 0 });
    const biased = planCEERankedBot({ persona, nominal: 1700, bias: 80 });
    expect(biased.level).toBeLessThan(plain.level);
    expect(biased.strengthRating).toBeCloseTo(1620, 0);
    expect(biased.targetRating).toBeCloseTo(1700, 0);
  });

  it("想要的分数超出范围时强度分与计分分停在顶（底），不再跟着标称分走", () => {
    const persona = personaOf("dango");
    const top = planCEERankedBot({ persona, nominal: 8000, bias: 0 });
    const higher = planCEERankedBot({ persona, nominal: 9000, bias: 0 });
    expect(top).toEqual(higher);
    expect(top.level).toBe(CEE_RANKED_BOT_ANCHORS[CEE_RANKED_BOT_ANCHORS.length - 1].level);
    expect(top.targetRating).toBeLessThan(CEE_RANKED_BOT_RATING_RANGE.max + 100);
    const bottom = planCEERankedBot({ persona, nominal: 300, bias: 0 });
    expect(bottom.level).toBe(CEE_RANKED_BOT_ANCHORS[0].level);
    expect(bottom.targetRating).toBeGreaterThan(CEE_RANKED_BOT_RATING_RANGE.min - 100);
  });

  it("爱噶：强度分就是节奏分，夹到她的曲线范围内", () => {
    const aiga = personaOf("aiga");
    const plan = planCEERankedBot({ persona: aiga, nominal: 1690, bias: -40 });
    expect(plan.strengthRating).toBe(1730);
    expect(plan.targetRating).toBe(1690);
    const capped = planCEERankedBot({ persona: aiga, nominal: 9000, bias: 0 });
    expect(capped.strengthRating).toBe(CEE_RANKED_AIGA_RATING_RANGE.max);
    expect(capped.targetRating).toBe(CEE_RANKED_AIGA_RATING_RANGE.max);
    const floor = planCEERankedBot({ persona: aiga, nominal: 600, bias: 0 });
    expect(floor.strengthRating).toBe(CEE_RANKED_AIGA_RATING_RANGE.min);
  });
});
