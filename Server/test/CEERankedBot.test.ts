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
  CEE_RANKED_NUMERIC_DIMENSIONS,
  type CEERankedCandidate,
  type CEERankedDimension,
  type CEERankedObservation,
  evaluateCEEGuess,
  filterCEECandidates,
  rankCEEOpenings,
} from "../src/domain/CEERankedSolver";
import { type CEERankedOpening } from "../src/domain/CEERankedOpeningBook";
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
const poolIds = pool.map((item) => item.character.id);
const idsOf = (candidates: readonly CEERankedCandidate[]): number[] =>
  candidates.map((item) => item.character.id);
const viewOf = (id: number): CEECharacterView => {
  const found = pool.find((item) => item.character.id === id);
  if (!found) throw new Error(`夹具缺少角色 ${id}`);
  return found.character;
};
/**
 * 夹具开局谱：按本场题库评估整档候选，`solver` / `famous` 由用例点亮。
 *
 * 默认全 false —— 需要开局谱的用例自己指定，避免「没点亮也能被抽到」这种假通过。
 */
const openingBook = (options: { solver?: number[]; famous?: number[] } = {}): CEERankedOpening[] =>
  rankCEEOpenings(pool, settings).map((entry) => ({
    ...entry,
    solver: options.solver?.includes(entry.id) ?? false,
    famous: options.famous?.includes(entry.id) ?? false,
    popularity: viewOf(entry.id).popularity,
  }));
const openings = openingBook();
/** 构造一段开局列表：expectedRemaining 按给出顺序递增，方便断言「前 K 个」。 */
const scriptedOpenings = (
  ids: number[],
  flags: { solver?: boolean; famous?: boolean; popularity?: number } = {}
): CEERankedOpening[] =>
  ids.map((id, index) => ({
    id,
    expectedRemaining: index + 1,
    worstClass: 1,
    solver: flags.solver ?? true,
    famous: flags.famous ?? true,
    popularity: flags.popularity ?? 100,
  }));
const personaOf = (id: CEERankedPersonaId): CEERankedPersona => {
  const found = CEE_RANKED_PERSONAS.find((persona) => persona.id === id);
  if (!found) throw new Error(`缺少人格 ${id}`);
  return found;
};
const anchorStrength = (rating: number): CEERankedBotStrength =>
  ceeRankedBotStrength(rating, scripted([0.5]));
const unguessed = (brain: CEERankedBotBrain): CEERankedCandidate[] =>
  pool.filter((item) => !brain.guessed.has(item.character.id));
const observe = (guessId: number, answerId: number): CEERankedObservation => {
  const guess = viewOf(guessId);
  const answer = viewOf(answerId);
  return { guess, feedback: buildCEEFeedback(guess, answer, settings) };
};

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

  it("爱噶的记忆与可靠度不看强度表，忽略传进来的低档取值", () => {
    const brain = createCEERankedBot({
      persona: personaOf("aiga"),
      strength: {
        ...anchorStrength(800),
        memory: 1,
        numericReliability: 0,
        evidenceReliability: 0,
      },
      opponentRating: 1000,
      pool,
      random: seeded(1),
    });
    expect(brain.strength.memory).toBe(Number.POSITIVE_INFINITY);
    expect(brain.strength.numericReliability).toBe(1);
    expect(brain.strength.evidenceReliability).toBe(1);
  });

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

// ==================== 普通人格 ====================
describe("CEE 排位人机出手规则", () => {
  const dango = personaOf("dango");

  it("整局不重复猜、不猜题库外的角色，最终猜中答案", () => {
    const brain = createCEERankedBot({
      persona: dango,
      strength: { ...anchorStrength(2300), knowledge: 1 },
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
        // 精确回忆口径：记忆与可靠度拉满，本用例只考察 recallRate 这条路。
        strength: {
          ...anchorStrength(800),
          ...weak,
          recallRate,
          memory: Number.POSITIVE_INFINITY,
          numericReliability: 1,
          evidenceReliability: 1,
        },
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

// ==================== 开局谱第一手 ====================
describe("CEE 排位人机开局", () => {
  const fresh = (
    persona: CEERankedPersona,
    strength: CEERankedBotStrength,
    seed: number
  ): CEERankedBotBrain =>
    createCEERankedBot({
      persona,
      strength: { ...strength, knowledge: 1 },
      opponentRating: 2300,
      pool,
      random: seeded(seed),
    });
  const firstPicks = (
    persona: CEERankedPersona,
    strength: CEERankedBotStrength,
    book: CEERankedOpening[]
  ): number[] =>
    Array.from({ length: 60 }, (_unused, index) =>
      nextCEERankedBotGuess(
        fresh(persona, strength, 40 + index),
        pool,
        book,
        settings,
        seeded(440 + index)
      )
    );

  it("ranked 风格且 openingTopK = 3 时第一手只在前三个开局里，并且能选到题库外的角色", () => {
    const book = scriptedOpenings([901, 902, 903, 904]);
    expect(poolIds).not.toContain(901);
    const picks = firstPicks(personaOf("awen"), anchorStrength(2300), book);
    expect(picks.every((id) => [901, 902, 903].includes(id))).toBe(true);
    expect(new Set(picks).size).toBe(3);
  });

  it("弱档 openingTopK = 0 与 popular 风格都只用 famous 条目", () => {
    // 前三条不是 famous：切分效果再好也不会被这两类人格抽到。
    const book = scriptedOpenings([911, 912, 913], { famous: false }).concat(
      scriptedOpenings([921, 922], { solver: false })
    );
    const popular = firstPicks(personaOf("dango"), anchorStrength(2300), book);
    expect(popular.every((id) => [921, 922].includes(id))).toBe(true);
    expect(new Set(popular).size).toBe(2);
    const weak = firstPicks(personaOf("awen"), anchorStrength(1100), book);
    expect(anchorStrength(1100).openingTopK).toBe(0);
    expect(weak.every((id) => [921, 922].includes(id))).toBe(true);
  });

  it("第一手猜题库外的开局后，第二手起只在题库内推理", () => {
    const brain = fresh(personaOf("awen"), anchorStrength(2300), 51);
    const book = scriptedOpenings([901]);
    expect(nextCEERankedBotGuess(brain, pool, book, settings, seeded(52))).toBe(901);
    const outsider = view({ id: 901, popularity: 300 });
    recordCEERankedBotFeedback(brain, outsider, buildCEEFeedback(outsider, viewOf(106), settings));
    for (let step = 0; step < poolIds.length; step += 1) {
      const id = nextCEERankedBotGuess(brain, pool, book, settings, seeded(60 + step));
      expect(poolIds).toContain(id);
      if (id === 106) return;
      recordCEERankedBotFeedback(
        brain,
        viewOf(id),
        buildCEEFeedback(viewOf(id), viewOf(106), settings)
      );
    }
    throw new Error("没能猜中答案");
  });

  it("开局列表为空时退回在已知题库角色里按热度加权", () => {
    const picks = firstPicks(personaOf("dango"), anchorStrength(2300), []);
    expect(picks.every((id) => poolIds.includes(id))).toBe(true);
    // 团子的热度指数 1.5：夹具里最热的 108（480）必然被抽到，最冷的 107（90）未必。
    expect(picks).toContain(108);
  });

  it("猜过的开局不再重复出现在第一手", () => {
    // 开局谱只剩 931 与 932，931 已经猜过：第一手只能是 932。
    const brain = {
      ...fresh(personaOf("awen"), anchorStrength(2300), 53),
      guessed: new Set([931]),
    };
    const book = scriptedOpenings([931, 932]);
    const picks = Array.from({ length: 30 }, (_unused, index) =>
      nextCEERankedBotGuess(brain, pool, book, settings, seeded(540 + index))
    );
    expect(picks.every((id) => id === 932)).toBe(true);
  });
});

// ==================== 不完美推理 ====================
describe("CEE 排位人机不完美推理", () => {
  const sortedIds = (candidates: readonly CEERankedCandidate[]): number[] =>
    idsOf(candidates).sort((a, b) => a - b);

  /** 观测过的编号不再进候选集。 */
  const remainingAfter = (observations: readonly CEERankedObservation[]): CEERankedCandidate[] => {
    const guessed = new Set(observations.map((item) => item.guess.id));
    return pool.filter((item) => !guessed.has(item.character.id));
  };

  /** 连换 300 颗骰子，收集这一步所有可能被猜到的编号。 */
  const pickSet = (
    strength: CEERankedBotStrength,
    dims: readonly CEERankedDimension[],
    observations: readonly CEERankedObservation[]
  ): number[] => {
    const brain = createCEERankedBot({
      persona: personaOf("awen"),
      strength: {
        ...strength,
        dims,
        knowledge: 1,
        strategy: "consistent",
        lockThreshold: 0,
        mistakeRate: 0,
        noise: 0,
        recallRate: 0,
        openingTopK: 0,
      },
      opponentRating: 2300,
      pool,
      random: seeded(301),
    });
    for (const observation of observations)
      recordCEERankedBotFeedback(brain, observation.guess, observation.feedback);
    const picks = new Set<number>();
    for (let seed = 0; seed < 300; seed += 1)
      picks.add(nextCEERankedBotGuess(brain, pool, openings, settings, seeded(500 + seed)));
    return [...picks].sort((a, b) => a - b);
  };
  /** 精确回忆口径的基准：全记得、两组线索都用上。 */
  const full = {
    ...anchorStrength(2300),
    memory: Number.POSITIVE_INFINITY,
    numericReliability: 1,
    evidenceReliability: 1,
  };

  // 只比对热度：观测 101 把候选压到 1 个，观测 107 只压到 7 个，先后顺序体现「忘掉早先的观测」。
  const heatDims: CEERankedDimension[] = ["popularity"];
  const heatNotes = [observe(101, 106), observe(107, 106)];
  const heatRemaining = remainingAfter(heatNotes);

  // 热度（数值组）与共同作品（证据组）各排除一部分候选，用来分开看两个可靠度。
  const mixedDims: CEERankedDimension[] = ["popularity", "sharedAppearances"];
  const mixedNotes = [observe(105, 103)];
  const mixedRemaining = remainingAfter(mixedNotes);

  it("两组线索都用上、全部记得时与原精确排除口径完全一致", () => {
    for (const dims of [
      CEE_RANKED_NUMERIC_DIMENSIONS,
      CEE_RANKED_ALL_DIMENSIONS,
      heatDims,
      mixedDims,
    ]) {
      for (const notes of [heatNotes, mixedNotes])
        expect(pickSet(full, dims, notes)).toEqual(
          sortedIds(filterCEECandidates(remainingAfter(notes), notes, dims, settings))
        );
    }
  });

  it("memory = 1 时只按最后一条反馈过滤，早先的观测不再排除候选", () => {
    const exact = sortedIds(filterCEECandidates(heatRemaining, heatNotes, heatDims, settings));
    const lastOnly = sortedIds(
      filterCEECandidates(heatRemaining, [heatNotes[1]], heatDims, settings)
    );
    expect(exact.length).toBe(1);
    expect(lastOnly.length).toBeGreaterThan(exact.length);
    expect(pickSet(full, heatDims, heatNotes)).toEqual(exact);
    expect(pickSet({ ...full, memory: 1 }, heatDims, heatNotes)).toEqual(lastOnly);
    // memory = 2 覆盖这两条观测，行为回到全部记得。
    expect(pickSet({ ...full, memory: 2 }, heatDims, heatNotes)).toEqual(exact);
  });

  it("可靠度为 0 的那组维度不参与过滤", () => {
    const both = sortedIds(filterCEECandidates(mixedRemaining, mixedNotes, mixedDims, settings));
    const numericOnly = sortedIds(
      filterCEECandidates(mixedRemaining, mixedNotes, ["popularity"], settings)
    );
    const evidenceOnly = sortedIds(
      filterCEECandidates(mixedRemaining, mixedNotes, ["sharedAppearances"], settings)
    );
    expect([both.length, numericOnly.length, evidenceOnly.length, mixedRemaining.length]).toEqual([
      2, 4, 6, 9,
    ]);
    expect(pickSet(full, mixedDims, mixedNotes)).toEqual(both);
    expect(pickSet({ ...full, numericReliability: 0 }, mixedDims, mixedNotes)).toEqual(
      evidenceOnly
    );
    expect(pickSet({ ...full, evidenceReliability: 0 }, mixedDims, mixedNotes)).toEqual(
      numericOnly
    );
    // 两组都抽不到：等于不比对任何维度。
    expect(
      pickSet({ ...full, numericReliability: 0, evidenceReliability: 0 }, mixedDims, mixedNotes)
    ).toEqual(sortedIds(mixedRemaining));
  });

  it("爱噶的记忆不看强度表：低档强度也按全部观测精确排除", () => {
    const brain = createCEERankedBot({
      persona: personaOf("aiga"),
      strength: {
        ...anchorStrength(800),
        memory: 1,
        numericReliability: 0,
        evidenceReliability: 0,
      },
      opponentRating: 1000,
      pool,
      random: seeded(1),
    });
    for (const observation of mixedNotes)
      recordCEERankedBotFeedback(brain, observation.guess, observation.feedback);
    const id = nextCEERankedBotGuess(brain, pool, openings, settings, seeded(2));
    const exact = idsOf(
      filterCEECandidates(
        remainingAfter(mixedNotes),
        mixedNotes,
        CEE_RANKED_ALL_DIMENSIONS,
        settings
      )
    );
    expect(exact).toContain(id);
  });
});

// ==================== 锚点表单调 ====================
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
