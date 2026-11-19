import { describe, expect, it } from "bun:test";
import { ceeRankedAigaThinkMs, ceeRankedBotThinkMs } from "../src/domain/CEERankedBotTiming";
import {
  type CEERankedBotStrength,
  type CEERankedPersona,
} from "../src/domain/CEERankedBotProfile";
import {
  createCEERankedBot,
  recordCEERankedBotFeedback,
  type CEERankedBotBrain,
} from "../src/domain/CEERankedBot";
import { buildCEEFeedback } from "../src/domain/CEERules";
import { anchorStrength, personaOf, pool, settings, viewOf } from "./support/CEERankedBotFixtures";
import { FLAT_Z, scripted, seeded } from "./support/Random";

describe("CEE 排位人机思考时长", () => {
  const brainWith = (
    strength: CEERankedBotStrength,
    persona: CEERankedPersona
  ): CEERankedBotBrain =>
    createCEERankedBot({ persona, strength, opponentRating: 1500, pool, random: seeded(21) });

  it("结果夹在 2500 到 90000 毫秒之间", () => {
    const awen = personaOf("awen");
    const stepped = (brain: CEERankedBotBrain): CEERankedBotBrain => {
      recordCEERankedBotFeedback(
        brain,
        viewOf(101),
        buildCEEFeedback(viewOf(101), viewOf(102), settings)
      );
      return brain;
    };
    const huge = stepped(
      brainWith({ ...anchorStrength(2300), thinkMedianMs: 500000, thinkSigma: 0 }, awen)
    );
    expect(ceeRankedBotThinkMs(huge, 10, scripted(FLAT_Z))).toBe(90000);
    const tiny = stepped(
      brainWith({ ...anchorStrength(2300), thinkMedianMs: 10, thinkSigma: 0 }, awen)
    );
    expect(ceeRankedBotThinkMs(tiny, 10, scripted(FLAT_Z))).toBe(2500);
  });

  it("第一手用 firstGuessMedianMs，第二手起换回 thinkMedianMs", () => {
    const awen = brainWith(anchorStrength(800), personaOf("awen"));
    // FLAT_Z 给出 z = 0，取值就是中位数；0.999 落在 idleRate 之外。
    expect(ceeRankedBotThinkMs(awen, 10, scripted(FLAT_Z))).toBe(19500);
    recordCEERankedBotFeedback(
      awen,
      viewOf(101),
      buildCEEFeedback(viewOf(101), viewOf(102), settings)
    );
    expect(ceeRankedBotThinkMs(awen, 10, scripted(FLAT_Z))).toBe(58500);
    // 只剩三个候选时按 0.6 倍收尾。
    expect(ceeRankedBotThinkMs(awen, 3, scripted(FLAT_Z))).toBe(35100);
  });

  it("发呆按 idleRate 追加 10000 到 20000 毫秒", () => {
    const idle = brainWith(
      { ...anchorStrength(2300), thinkMedianMs: 10000, thinkSigma: 0 },
      personaOf("yemao")
    );
    recordCEERankedBotFeedback(
      idle,
      viewOf(101),
      buildCEEFeedback(viewOf(101), viewOf(102), settings)
    );
    const plain = ceeRankedBotThinkMs(idle, 10, scripted([0.5, 0.25, 0.999]));
    const spaced = ceeRankedBotThinkMs(idle, 10, scripted([0.5, 0.25, 0.05, 0.5]));
    // 第二手：thinkMedianMs 10000 × 慢热派 step 1 的 1.5 倍。
    expect(plain).toBe(15000);
    expect(spaced - plain).toBe(15000);
  });

  it("慢热派的手速按 warmup 系数走：第一手 1.8、第二手 1.5、之后 0.8", () => {
    const yemao = brainWith(anchorStrength(1700), personaOf("yemao"));
    const first = ceeRankedBotThinkMs(yemao, 10, scripted(FLAT_Z));
    recordCEERankedBotFeedback(
      yemao,
      viewOf(101),
      buildCEEFeedback(viewOf(101), viewOf(102), settings)
    );
    const second = ceeRankedBotThinkMs(yemao, 10, scripted(FLAT_Z));
    recordCEERankedBotFeedback(
      yemao,
      viewOf(103),
      buildCEEFeedback(viewOf(103), viewOf(102), settings)
    );
    const third = ceeRankedBotThinkMs(yemao, 10, scripted(FLAT_Z));
    // 首猜只看 firstGuessMedianMs 8000，之后只看 thinkMedianMs 20000。
    expect(first).toBe(14400);
    expect(second).toBe(30000);
    expect(third).toBe(16000);
  });

  it("乱节奏派的抽样跨度大于稳节奏派", () => {
    const spreadOf = (persona: CEERankedPersona): number => {
      const brain = brainWith(anchorStrength(1700), persona);
      const high = ceeRankedBotThinkMs(brain, 10, scripted([0.5, 0, 0.999]));
      const low = ceeRankedBotThinkMs(brain, 10, scripted([0.5, 0.5, 0.999]));
      return high / low;
    };
    expect(spreadOf(personaOf("mangmang"))).toBeGreaterThan(spreadOf(personaOf("awen")));
  });
});

describe("CEE 排位人机爱噶", () => {
  it("思考时长只看对手分数：按锚点插值，且随分数单调递减", () => {
    // 锚点 800/1100/1400/1700/2000/2300 → 113/96/53/32/15/10 秒；1500 落在 1400 与 1700 的三分之一处。
    expect(ceeRankedAigaThinkMs(1400, scripted(FLAT_Z))).toBe(53000);
    expect(ceeRankedAigaThinkMs(1500, scripted(FLAT_Z))).toBe(46000);
    expect(ceeRankedAigaThinkMs(500, scripted(FLAT_Z))).toBe(
      ceeRankedAigaThinkMs(800, scripted(FLAT_Z))
    );
    expect(ceeRankedAigaThinkMs(2400, scripted(FLAT_Z))).toBe(
      ceeRankedAigaThinkMs(2300, scripted(FLAT_Z))
    );
    const samples = [800, 1000, 1500, 1900, 2300].map((rating) =>
      ceeRankedAigaThinkMs(rating, scripted(FLAT_Z))
    );
    expect(samples[0]).toBe(113000);
    expect(samples[2]).toBe(46000);
    expect(samples[4]).toBe(10000);
    samples.forEach((value, index) => {
      if (index > 0) expect(value).toBeLessThan(samples[index - 1]);
    });
  });

  it("爱噶的上限放宽到 120 秒：低分段的长尾不再被 60 秒夹平", () => {
    // z ≈ 7.43 的极端抽样：按旧上限会落在 60000，新上限下 2000 分能给出超过 60 秒的间隔。
    expect(ceeRankedAigaThinkMs(2000, scripted([1e-12, 0, 0.999]))).toBeGreaterThan(60000);
    expect(ceeRankedAigaThinkMs(2000, scripted([1e-12, 0, 0.999]))).toBeLessThan(120000);
    expect(ceeRankedAigaThinkMs(800, scripted([1e-12, 0, 0.999]))).toBe(120000);
  });
});
