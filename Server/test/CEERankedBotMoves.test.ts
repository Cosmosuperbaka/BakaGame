import { describe, expect, it } from "bun:test";
import {
  CEE_RANKED_AIGA_OPENING_ID,
  type CEERankedBotStrength,
  type CEERankedPersona,
} from "../src/domain/CEERankedBotProfile";
import {
  createCEERankedBot,
  nextCEERankedBotGuess,
  recordCEERankedBotFeedback,
  type CEERankedBotBrain,
} from "../src/domain/CEERankedBot";
import {
  CEE_RANKED_ALL_DIMENSIONS,
  CEE_RANKED_NUMERIC_DIMENSIONS,
  type CEERankedCandidate,
  type CEERankedDimension,
  type CEERankedObservation,
  evaluateCEEGuess,
  filterCEECandidates,
} from "../src/domain/CEERankedSolver";
import { type CEERankedOpening } from "../src/domain/CEERankedOpeningBook";
import { buildCEEFeedback } from "../src/domain/CEERules";
import {
  anchorStrength,
  idsOf,
  observe,
  openings,
  personaOf,
  playGuesses,
  pool,
  poolIds,
  scriptedOpenings,
  settings,
  unguessed,
  view,
  viewOf,
} from "./support/CEERankedBotFixtures";
import { scripted, seeded } from "./support/Random";

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
});

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
