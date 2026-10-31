import { describe, expect, it } from "bun:test";
import {
  CEE_RANKED_AIGA_OPENING_ID,
  CEE_RANKED_BOT_ANCHORS,
  CEE_RANKED_PERSONAS,
  ceeRankedAigaThinkMs,
  ceeRankedBotEligible,
  ceeRankedBotStrength,
  ceeRankedBotThinkMs,
  createCEERankedBot,
  nextCEERankedBotGuess,
  pickCEERankedPersona,
  recordCEERankedBotFeedback,
  type CEERankedBotBrain,
  type CEERankedBotStrength,
  type CEERankedPersona,
  type CEERankedPersonaId,
} from "../src/domain/CEERankedBot";
import {
  CEE_RANKED_ALL_DIMENSIONS,
  type CEERankedCandidate,
  evaluateCEEGuess,
  filterCEECandidates,
  rankCEEOpenings,
} from "../src/domain/CEERankedSolver";
import { buildCEEFeedback } from "../src/domain/CEERules";
import {
  createDefaultCEESettings,
  type CEEAppearance,
  type CEECharacterView,
  type CEEExtraTagSection,
} from "../src/shared/CEE";

// ==================== 确定性随机 ====================
/** mulberry32：同种子给出同序列，测试才可复现。 */
const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** 按顺序吐出给定值，用完继续循环，便于固定 Box–Muller 的两个抽样。 */
const scripted = (values: readonly number[]): (() => number) => {
  let index = 0;
  return () => {
    const value = values[index % values.length];
    index += 1;
    return value;
  };
};

// cos(2π·0.25) = 0 ⇒ z ≈ 0 ⇒ 对数正态取值即中位数；末位 0.999 保证不发呆。
const FLAT_Z = [0.5, 0.25, 0.999];

// ==================== 合成题库 ====================
const appearance = (id: number, year: number, rating: number): CEEAppearance => ({
  id,
  name: `作品${id}`,
  nameCn: `作品${id}`,
  year,
  rating,
  ratingCount: 100,
});

const view = (overrides: Partial<CEECharacterView> & { id: number }): CEECharacterView => ({
  name: `角色${overrides.id}`,
  nameCn: `角色${overrides.id}`,
  gender: "female",
  popularity: 100,
  summary: "",
  appearances: [appearance(1, 2020, 8)],
  highestRating: 8,
  earliestAppearance: 2020,
  latestAppearance: 2020,
  subjectTags: ["校园"],
  characterTags: ["黑发"],
  voiceActors: ["声优甲"],
  metaTags: [],
  comparisonAppearances: [{ id: 1, name: "作品1", nameCn: "作品1" }],
  extraTags: [{ section: "属性", tags: ["火"] }],
  ...overrides,
});

interface Spec {
  id: number;
  weight: number;
  gender: "male" | "female";
  popularity: number;
  works: number[][];
  subject: string[];
  character: string[];
  voice: string[];
  extra: CEEExtraTagSection[];
}

const SPECS: Spec[] = [
  {
    id: 101,
    weight: 2,
    gender: "female",
    popularity: 300,
    works: [
      [1, 2021, 9],
      [2, 2022, 7],
    ],
    subject: ["校园", "奇幻"],
    character: ["黑发"],
    voice: ["声优甲"],
    extra: [{ section: "属性", tags: ["火"] }],
  },
  {
    id: 102,
    weight: 1,
    gender: "male",
    popularity: 120,
    works: [[3, 2019, 8]],
    subject: ["运动"],
    character: ["短发"],
    voice: ["声优乙"],
    extra: [{ section: "武器", tags: ["剑"] }],
  },
  {
    id: 103,
    weight: 1.5,
    gender: "female",
    popularity: 400,
    works: [
      [1, 2021, 9],
      [4, 2023, 6],
    ],
    subject: ["校园"],
    character: ["长发"],
    voice: ["声优丙"],
    extra: [{ section: "属性", tags: ["水"] }],
  },
  {
    id: 104,
    weight: 1,
    gender: "male",
    popularity: 60,
    works: [[5, 2016, 7]],
    subject: ["科幻"],
    character: ["眼镜"],
    voice: ["声优甲"],
    extra: [{ section: "武器", tags: ["枪"] }],
  },
  {
    id: 105,
    weight: 1,
    gender: "female",
    popularity: 220,
    works: [
      [2, 2022, 7],
      [6, 2020, 8],
    ],
    subject: ["奇幻"],
    character: ["双马尾"],
    voice: ["声优丁"],
    extra: [{ section: "属性", tags: ["风"] }],
  },
  {
    id: 106,
    weight: 3,
    gender: "male",
    popularity: 350,
    works: [[4, 2023, 6]],
    subject: ["悬疑"],
    character: ["面具"],
    voice: ["声优戊"],
    extra: [{ section: "武器", tags: ["刀"] }],
  },
  {
    id: 107,
    weight: 1,
    gender: "female",
    popularity: 90,
    works: [
      [5, 2016, 7],
      [3, 2019, 8],
    ],
    subject: ["科幻", "日常"],
    character: ["呆毛"],
    voice: ["声优乙"],
    extra: [{ section: "属性", tags: ["光"] }],
  },
  {
    id: 108,
    weight: 1,
    gender: "male",
    popularity: 480,
    works: [
      [6, 2020, 8],
      [1, 2021, 9],
    ],
    subject: ["日常"],
    character: ["老成"],
    voice: ["声优丙"],
    extra: [{ section: "武器", tags: ["拳套"] }],
  },
  {
    id: 109,
    weight: 1,
    gender: "female",
    popularity: 150,
    works: [[7, 2015, 6]],
    subject: ["音乐"],
    character: ["耳机"],
    voice: ["声优己"],
    extra: [{ section: "属性", tags: ["暗"] }],
  },
  {
    id: 110,
    weight: 1,
    gender: "male",
    popularity: 260,
    works: [
      [7, 2015, 6],
      [2, 2022, 7],
    ],
    subject: ["音乐", "奇幻"],
    character: ["金发"],
    voice: ["声优丁"],
    extra: [{ section: "武器", tags: ["吉他"] }],
  },
];

const settings = createDefaultCEESettings();
const pool: CEERankedCandidate[] = SPECS.map((spec) => {
  const appearances = spec.works.map(([id, year, rating]) => appearance(id, year, rating));
  return {
    weight: spec.weight,
    character: view({
      id: spec.id,
      gender: spec.gender,
      popularity: spec.popularity,
      appearances,
      highestRating: Math.max(...appearances.map((item) => item.rating)),
      earliestAppearance: Math.min(...appearances.map((item) => item.year)),
      latestAppearance: Math.max(...appearances.map((item) => item.year)),
      subjectTags: spec.subject,
      characterTags: spec.character,
      voiceActors: spec.voice,
      comparisonAppearances: appearances.map((item) => ({
        id: item.id,
        name: item.name,
        nameCn: item.nameCn,
      })),
      extraTags: spec.extra,
    }),
  };
});
const openings = rankCEEOpenings(pool, settings);
const poolIds = pool.map((item) => item.character.id);
const idsOf = (candidates: readonly CEERankedCandidate[]): number[] =>
  candidates.map((item) => item.character.id);
const viewOf = (id: number): CEECharacterView => {
  const found = pool.find((item) => item.character.id === id);
  if (!found) throw new Error(`夹具缺少角色 ${id}`);
  return found.character;
};
const personaOf = (id: CEERankedPersonaId): CEERankedPersona => {
  const found = CEE_RANKED_PERSONAS.find((persona) => persona.id === id);
  if (!found) throw new Error(`缺少人格 ${id}`);
  return found;
};
const anchorStrength = (rating: number): CEERankedBotStrength =>
  ceeRankedBotStrength(rating, scripted([0.5]));
const unguessed = (brain: CEERankedBotBrain): CEERankedCandidate[] =>
  pool.filter((item) => !brain.guessed.has(item.character.id));

/** 让大脑打一局并返回猜测序列；题库外的首猜（爱噶）只计次数。 */
const playGuesses = (
  brain: CEERankedBotBrain,
  answerId: number,
  random: () => number,
  extras: ReadonlyMap<number, CEECharacterView> = new Map()
): number[] => {
  const answer = viewOf(answerId);
  const guesses: number[] = [];
  while (guesses.length <= poolIds.length + 2 && ceeRankedBotEligible(brain, pool).length > 0) {
    const id = nextCEERankedBotGuess(brain, pool, openings, settings, random);
    guesses.push(id);
    const character = extras.get(id) ?? (poolIds.includes(id) ? viewOf(id) : undefined);
    if (character)
      recordCEERankedBotFeedback(brain, character, buildCEEFeedback(character, answer, settings));
    else {
      brain.guessed.add(id);
      brain.step += 1;
    }
    if (id === answerId) break;
  }
  return guesses;
};

// ==================== 强度 ====================
describe("CEE 排位人机强度", () => {
  it("锚点处的数值与锚点表完全一致", () => {
    for (const anchor of CEE_RANKED_BOT_ANCHORS)
      expect(ceeRankedBotStrength(anchor.rating, scripted([0.5]))).toEqual(anchor.strength);
  });

  it("1250 分的 knowledge 恰为 0.675，其余数值在相邻锚点间线性插值", () => {
    const strength = ceeRankedBotStrength(1250, scripted([0.5]));
    expect(strength.knowledge).toBe(0.675);
    expect(strength.thinkMedianMs).toBe(19000);
    expect(strength.thinkSigma).toBeCloseTo(0.425, 12);
    expect(strength.noise).toBeCloseTo(0.65, 12);
    expect(strength.mistakeRate).toBeCloseTo(0.14, 12);
    expect(strength.recallRate).toBeCloseTo(0.175, 12);
    expect(strength.sampleSize).toBe(12);
    expect(strength.openingTopK).toBe(10);
  });

  it("分数超出锚点范围时夹到两端", () => {
    expect(ceeRankedBotStrength(0, scripted([0.5]))).toEqual(CEE_RANKED_BOT_ANCHORS[0].strength);
    expect(ceeRankedBotStrength(99999, scripted([0.5]))).toEqual(
      CEE_RANKED_BOT_ANCHORS[CEE_RANKED_BOT_ANCHORS.length - 1].strength
    );
  });

  it("离散字段只会是最近锚点或其相邻锚点", () => {
    for (let rating = 800; rating <= 2300; rating += 17) {
      const distances = CEE_RANKED_BOT_ANCHORS.map((anchor) => Math.abs(anchor.rating - rating));
      const nearest = distances.indexOf(Math.min(...distances));
      const allowed = [nearest - 1, nearest, nearest + 1]
        .filter((index) => index >= 0 && index < CEE_RANKED_BOT_ANCHORS.length)
        .map((index) => CEE_RANKED_BOT_ANCHORS[index].strength);
      const strength = ceeRankedBotStrength(rating, seeded(rating));
      expect(allowed.some((anchor) => anchor.strategy === strength.strategy)).toBe(true);
      expect(allowed.some((anchor) => anchor.lockThreshold === strength.lockThreshold)).toBe(true);
      expect(allowed.some((anchor) => anchor.dims.join("|") === strength.dims.join("|"))).toBe(
        true
      );
    }
  });
});

// ==================== 人格 ====================
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

// ==================== 爱噶 ====================
describe("CEE 排位人机爱噶", () => {
  const createAiga = (random: () => number): CEERankedBotBrain =>
    createCEERankedBot({
      persona: personaOf("aiga"),
      strength: anchorStrength(2300),
      opponentRating: 1500,
      pool,
      random,
    });

  it("第一手恒为丰川祥子，即使题库里没有她", () => {
    const brain = createAiga(seeded(5));
    expect(poolIds).not.toContain(CEE_RANKED_AIGA_OPENING_ID);
    const random = seeded(6);
    expect(nextCEERankedBotGuess(brain, pool, openings, settings, random)).toBe(
      CEE_RANKED_AIGA_OPENING_ID
    );
    expect(nextCEERankedBotGuess(brain, pool, openings, settings, random)).toBe(
      CEE_RANKED_AIGA_OPENING_ID
    );
  });

  it("之后每一手都在一致候选内且最坏组最小，并最终猜中答案", () => {
    const brain = createAiga(seeded(7));
    const answer = viewOf(107);
    const outOfPool = view({ id: CEE_RANKED_AIGA_OPENING_ID, popularity: 500 });
    recordCEERankedBotFeedback(brain, outOfPool, buildCEEFeedback(outOfPool, answer, settings));
    for (let step = 0; step < poolIds.length && !brain.guessed.has(answer.id); step += 1) {
      const consistent = filterCEECandidates(
        unguessed(brain),
        brain.observations,
        CEE_RANKED_ALL_DIMENSIONS,
        settings
      );
      const bestWorst = Math.min(
        ...consistent.map(
          (item) =>
            evaluateCEEGuess(item.character, consistent, CEE_RANKED_ALL_DIMENSIONS, settings)
              .worstClass
        )
      );
      const id = nextCEERankedBotGuess(brain, pool, openings, settings, seeded(100 + step));
      expect(poolIds).toContain(id);
      expect(idsOf(consistent)).toContain(id);
      const picked = viewOf(id);
      expect(
        evaluateCEEGuess(picked, consistent, CEE_RANKED_ALL_DIMENSIONS, settings).worstClass
      ).toBe(bestWorst);
      recordCEERankedBotFeedback(brain, picked, buildCEEFeedback(picked, answer, settings));
    }
    expect(brain.guessed.has(answer.id)).toBe(true);
  });

  it("猜测序列完全不依赖 random", () => {
    const first = playGuesses(createAiga(seeded(1)), 108, seeded(2));
    const second = playGuesses(createAiga(seeded(9)), 108, scripted([0.01, 0.99, 0.5]));
    expect(first.length).toBeGreaterThan(2);
    expect(first).toEqual(second);
    expect(first[0]).toBe(CEE_RANKED_AIGA_OPENING_ID);
    expect(first[first.length - 1]).toBe(108);
  });

  it("思考时长只看对手分数：1500 分的中位数是 18000，且随分数单调递减", () => {
    expect(ceeRankedAigaThinkMs(1500, scripted(FLAT_Z))).toBe(18000);
    expect(ceeRankedAigaThinkMs(500, scripted(FLAT_Z))).toBe(
      ceeRankedAigaThinkMs(800, scripted(FLAT_Z))
    );
    expect(ceeRankedAigaThinkMs(2400, scripted(FLAT_Z))).toBe(
      ceeRankedAigaThinkMs(2300, scripted(FLAT_Z))
    );
    const samples = [800, 1000, 1500, 1900, 2300].map((rating) =>
      ceeRankedAigaThinkMs(rating, scripted(FLAT_Z))
    );
    expect(samples[0]).toBe(35000);
    expect(samples[2]).toBe(18000);
    expect(samples[4]).toBe(7000);
    samples.forEach((value, index) => {
      if (index > 0) expect(value).toBeLessThan(samples[index - 1]);
    });
  });
});

// ==================== 普通人格 ====================
describe("CEE 排位人机出手规则", () => {
  const dango = personaOf("dango");

  it("整局不重复猜、不猜题库外的角色，最终猜中答案", () => {
    const brain = createCEERankedBot({
      persona: dango,
      strength: anchorStrength(2300),
      opponentRating: 2300,
      pool,
      random: seeded(11),
    });
    expect(brain.known.size).toBe(poolIds.length);
    const guesses = playGuesses(brain, 106, seeded(12));
    expect(new Set(guesses).size).toBe(guesses.length);
    expect(guesses.every((id) => poolIds.includes(id))).toBe(true);
    expect(guesses[guesses.length - 1]).toBe(106);
  });

  it("一致候选不超过 lockThreshold 时直接押权重最高的", () => {
    const locking = createCEERankedBot({
      persona: dango,
      strength: { ...anchorStrength(2300), lockThreshold: 99, mistakeRate: 0 },
      opponentRating: 2300,
      pool,
      random: seeded(13),
    });
    expect(locking.strength.strategy).toBe("optimal");
    const answer = viewOf(103);
    recordCEERankedBotFeedback(
      locking,
      viewOf(101),
      buildCEEFeedback(viewOf(101), answer, settings)
    );
    const consistent = filterCEECandidates(
      unguessed(locking),
      locking.observations,
      CEE_RANKED_ALL_DIMENSIONS,
      settings
    );
    const best = Math.max(...consistent.map((item) => item.weight));
    const heaviest = idsOf(consistent.filter((item) => item.weight === best));
    expect(heaviest.length).toBeGreaterThan(0);
    expect(heaviest).toContain(
      nextCEERankedBotGuess(locking, pool, openings, settings, seeded(14))
    );
  });

  it("random 策略不看反馈，可能猜出与反馈矛盾的角色", () => {
    const brain = createCEERankedBot({
      persona: dango,
      strength: {
        ...anchorStrength(800),
        dims: ["gender"],
        knowledge: 1,
        strategy: "random",
        lockThreshold: 0,
        mistakeRate: 0,
        noise: 0,
      },
      opponentRating: 2300,
      pool,
      random: seeded(15),
    });
    recordCEERankedBotFeedback(
      brain,
      viewOf(101),
      buildCEEFeedback(viewOf(101), viewOf(106), settings)
    );
    const consistent = idsOf(
      filterCEECandidates(
        unguessed(brain).filter((item) => brain.known.has(item.character.id)),
        brain.observations,
        brain.strength.dims,
        settings
      )
    );
    expect(consistent.length).toBeGreaterThan(1);
    const picks = Array.from({ length: 30 }, (_unused, index) =>
      nextCEERankedBotGuess(brain, pool, openings, settings, seeded(index))
    );
    expect(picks.some((id) => !consistent.includes(id))).toBe(true);
    expect(picks.every((id) => poolIds.includes(id) && id !== 101)).toBe(true);
  });

  it("一致候选为空时先按 recallRate 回忆，回忆不到就挑矛盾最少的已知角色", () => {
    const weak = { knowledge: 0, strategy: "consistent", mistakeRate: 0 } as const;
    const build = (recallRate: number): CEERankedBotBrain => {
      const brain = createCEERankedBot({
        persona: dango,
        strength: { ...anchorStrength(800), ...weak, recallRate },
        opponentRating: 800,
        pool,
        random: seeded(16),
      });
      brain.known = new Set([101, 102]);
      recordCEERankedBotFeedback(
        brain,
        viewOf(101),
        buildCEEFeedback(viewOf(101), viewOf(106), settings)
      );
      expect(
        filterCEECandidates(
          unguessed(brain).filter((item) => brain.known.has(item.character.id)),
          brain.observations,
          brain.strength.dims,
          settings
        ).length
      ).toBe(0);
      return brain;
    };

    const recalling = build(1);
    const knownBefore = new Set(recalling.known);
    const remembered = nextCEERankedBotGuess(recalling, pool, openings, settings, seeded(17));
    expect(knownBefore.has(remembered)).toBe(false);
    expect(recalling.known.has(remembered)).toBe(true);
    expect(poolIds).toContain(remembered);

    const stubborn = build(0);
    const fallback = nextCEERankedBotGuess(stubborn, pool, openings, settings, seeded(18));
    expect(stubborn.known.size).toBe(2);
    expect(fallback).toBe(102);
  });
});

// ==================== 思考时长 ====================
describe("CEE 排位人机思考时长", () => {
  const brainWith = (
    strength: CEERankedBotStrength,
    persona: CEERankedPersona
  ): CEERankedBotBrain =>
    createCEERankedBot({ persona, strength, opponentRating: 1500, pool, random: seeded(21) });

  it("结果夹在 2500 到 60000 毫秒之间", () => {
    const awen = personaOf("awen");
    const huge = brainWith({ ...anchorStrength(2300), thinkMedianMs: 500000, thinkSigma: 0 }, awen);
    expect(ceeRankedBotThinkMs(huge, 10, scripted(FLAT_Z))).toBe(60000);
    const tiny = brainWith({ ...anchorStrength(2300), thinkMedianMs: 10, thinkSigma: 0 }, awen);
    expect(ceeRankedBotThinkMs(tiny, 10, scripted(FLAT_Z))).toBe(2500);
  });

  it("发呆按 idleRate 追加 10000 到 20000 毫秒", () => {
    const idle = brainWith(
      { ...anchorStrength(2300), thinkMedianMs: 10000, thinkSigma: 0 },
      personaOf("yemao")
    );
    const plain = ceeRankedBotThinkMs(idle, 10, scripted([0.5, 0.25, 0.999]));
    const spaced = ceeRankedBotThinkMs(idle, 10, scripted([0.5, 0.25, 0.05, 0.5]));
    expect(plain).toBe(23400);
    expect(spaced - plain).toBe(15000);
  });

  it("慢热派第一手明显慢于第三手", () => {
    const yemao = brainWith(anchorStrength(1700), personaOf("yemao"));
    const first = ceeRankedBotThinkMs(yemao, 10, scripted(FLAT_Z));
    recordCEERankedBotFeedback(
      yemao,
      viewOf(101),
      buildCEEFeedback(viewOf(101), viewOf(102), settings)
    );
    recordCEERankedBotFeedback(
      yemao,
      viewOf(103),
      buildCEEFeedback(viewOf(103), viewOf(102), settings)
    );
    const third = ceeRankedBotThinkMs(yemao, 10, scripted(FLAT_Z));
    expect(first).toBe(32760);
    expect(third).toBe(11200);
    expect(first).toBeGreaterThan(third * 2);
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
