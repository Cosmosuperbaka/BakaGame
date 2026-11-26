// ==================== 排位分数重放 ====================
// 重放只依赖审计记录：盯旧规则版本人机强度的换算、计分口径与重放顺序。读写库部分不在这里测。
import { describe, expect, test } from "bun:test";
import {
  R2_AIGA_EDGE,
  R2_LADDER,
  R2_PERSONA_OFFSET,
  replayBotStrength,
  replayCEERankedRatings,
  type CEERankedReplayPlayer,
  type CEERankedReplaySeries,
} from "../scripts/CEERankedReplay";
import { createCEERating, rateCEEBotSeries, rateCEESeries } from "../src/domain/CEERankedRating";
import { CEE_RANKED_RULESET } from "../src/shared/CEERanked";

const human = (
  userId: string,
  score: CEERankedReplayPlayer["score"],
  ratingBefore: number | null = 1500
): CEERankedReplayPlayer => ({
  userId,
  placement: false,
  score,
  botPersona: null,
  botStrengthRating: null,
  ratingBefore,
  rdBefore: ratingBefore === null ? null : 350,
});

const bot = (persona: string, strength: number | null): CEERankedReplayPlayer => ({
  userId: null,
  placement: false,
  score: 0,
  botPersona: persona,
  botStrengthRating: strength,
  ratingBefore: null,
  rdBefore: null,
});

let nextSeries = 0;
const botSeries = (
  endedAt: number,
  players: CEERankedReplayPlayer[],
  overrides: Partial<CEERankedReplaySeries> = {}
): CEERankedReplaySeries => ({
  id: `s${(nextSeries += 1).toString().padStart(4, "0")}`,
  ruleset: CEE_RANKED_RULESET,
  endedAt,
  rated: true,
  bot: true,
  players,
  ...overrides,
});

describe("重放时的人机实战分", () => {
  test("现行规则版本记的就是实战分，原样使用", () => {
    expect(replayBotStrength(CEE_RANKED_RULESET, bot("dango", 1612.5), human("u1", 1))).toBe(
      1612.5
    );
  });

  test("r2 普通人格：档位按 r2 阶梯换成实战分，再加该人格的 r2 偏移", () => {
    expect(replayBotStrength("r2", bot("awen", 1400), human("u1", 1))).toBe(
      1400 + R2_PERSONA_OFFSET.awen
    );
    // r2 的档位没有夹取，超出强度表的部分按顶档算。
    const top = R2_LADDER[R2_LADDER.length - 1].rating;
    expect(replayBotStrength("r2", bot("dango", 2800), human("u1", 1))).toBe(
      top + R2_PERSONA_OFFSET.dango
    );
    const [low, high] = [R2_LADDER[0], R2_LADDER[1]];
    expect(
      replayBotStrength("r2", bot("kaoju", (low.level + high.level) / 2), human("u1", 1))
    ).toBeCloseTo((low.rating + high.rating) / 2 + R2_PERSONA_OFFSET.kaoju, 9);
  });

  test("r2 爱噶按当时真人的赛前分定节奏：同分基线实战分加她在该分数的强出量", () => {
    const at1400 = R2_AIGA_EDGE.find((item) => item.level === 1400)?.rating ?? Number.NaN;
    expect(replayBotStrength("r2", bot("aiga", 9999), human("u1", 0, 1400))).toBe(1400 + at1400);
    expect(replayBotStrength("r2", bot("aiga", 9999), human("u1", 0, null))).toBeNull();
  });

  test("认不出的规则版本或缺字段时换算不了", () => {
    expect(replayBotStrength("r1", bot("dango", 1400), human("u1", 1))).toBeNull();
    expect(replayBotStrength("r2", bot("dango", null), human("u1", 1))).toBeNull();
    expect(replayBotStrength("r2", bot("unknown", 1400), human("u1", 1))).toBeNull();
  });
});

describe("排位分数重放", () => {
  test("人机局按实战分计分：没有校准样本时偏差为 0", () => {
    const result = replayCEERankedRatings([botSeries(1_000, [human("u1", 1), bot("dango", 1450)])]);
    const expected = rateCEEBotSeries(createCEERating(), 1450, 1, 1_000);
    expect(result.ratings.get("u1")).toEqual(expected);
    expect(result.skipped).toEqual([]);
    expect(result.bias).toEqual({ regular: 0, aiga: 0 });
  });

  test("真人局两边一起结算，不计分的场次不改分数", () => {
    const result = replayCEERankedRatings([
      botSeries(1_000, [human("u1", 1), human("u2", 0)], { bot: false }),
      botSeries(2_000, [human("u1", 0), human("u2", 1)], { bot: false, rated: false }),
    ]);
    const [a, b] = rateCEESeries(createCEERating(), createCEERating(), 1, 1_000);
    expect(result.ratings.get("u1")).toEqual(a);
    expect(result.ratings.get("u2")).toEqual(b);
  });

  test("真人局一方已注销：拿它审计里的赛前分与偏差当对手，照样结算还在的一方", () => {
    const ghost: CEERankedReplayPlayer = {
      ...human("u-gone", 0, 1620),
      userId: null,
      rdBefore: 90,
    };
    const result = replayCEERankedRatings([
      botSeries(1_000, [ghost, human("u2", 1)], { bot: false }),
    ]);
    const [expected] = rateCEESeries(
      createCEERating(),
      { rating: 1620, rd: 90, lastPlayedAt: 1_000 },
      1,
      1_000
    );
    expect(result.ratings.get("u2")).toEqual(expected);
    expect(result.skipped).toEqual([]);
    // 连赛前记录都没有的注销席位：结算不了，记入跳过。
    const bare = replayCEERankedRatings([
      botSeries(2_000, [{ ...ghost, ratingBefore: null, rdBefore: null }, human("u2", 1)], {
        bot: false,
      }),
    ]);
    expect(bare.ratings.has("u2")).toBe(false);
    expect(bare.skipped.length).toBe(1);
  });

  test("按结束时刻重放，与输入顺序无关", () => {
    const early = botSeries(1_000, [human("u1", 1), bot("dango", 1400)]);
    const late = botSeries(5_000, [human("u1", 0), bot("awen", 1700)]);
    const forward = replayCEERankedRatings([early, late]);
    const backward = replayCEERankedRatings([late, early]);
    expect(backward.ratings.get("u1")).toEqual(forward.ratings.get("u1"));
    const first = rateCEEBotSeries(createCEERating(), 1400, 1, 1_000);
    expect(forward.ratings.get("u1")).toEqual(rateCEEBotSeries(first, 1700, 0, 5_000));
  });

  test("换算不了强度的人机局记入跳过，不动分数", () => {
    const result = replayCEERankedRatings([
      botSeries(1_000, [human("u1", 1), bot("dango", 1400)], { ruleset: "r1" }),
    ]);
    expect(result.skipped.length).toBe(1);
    expect(result.ratings.has("u1")).toBe(false);
  });

  test("重放中在线攒校准样本：一组全输样本攒够后偏差转正，之后的场次按强度分加偏差计分", () => {
    // 30 个不同的已定级账号各输一场：样本数到下限，普通人格组的偏差从 0 变正。
    const series: CEERankedReplaySeries[] = [];
    for (let index = 0; index < 30; index += 1) {
      const userId = `u-${index}`;
      // 先给每个账号一场真人局把偏差压下来：偏差太大的真人不收进样本。
      for (let round = 0; round < 12; round += 1)
        series.push(
          botSeries(index * 1_000 + round, [human(userId, 0.5), human(`p-${index}`, 0.5)], {
            bot: false,
          })
        );
      series.push(botSeries(index * 1_000 + 500, [human(userId, 0), bot("dango", 1500)]));
    }
    const result = replayCEERankedRatings(series);
    expect(result.bias.regular).toBeGreaterThan(0);
    expect(result.bias.aiga).toBe(0);
  });
});
