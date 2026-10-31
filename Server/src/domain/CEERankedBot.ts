import type { CEECharacterView, CEEFeedback, CEESettings } from "../shared/CEE";
import {
  CEE_RANKED_ALL_DIMENSIONS,
  CEE_RANKED_NUMERIC_DIMENSIONS,
  type CEERankedCandidate,
  type CEERankedDimension,
  type CEERankedObservation,
  chooseCEEBisectionGuess,
  countCEEViolations,
  evaluateCEEGuess,
  filterCEECandidates,
} from "./CEERankedSolver";
import { AppError } from "./Errors";

export type CEERankedStrategy = "random" | "consistent" | "sampled" | "optimal";
export interface CEERankedBotStrength {
  /** 认识题库角色的比例（0–1），按热度加权抽取。 */
  knowledge: number;
  dims: readonly CEERankedDimension[];
  strategy: CEERankedStrategy;
  /** sampled / optimal 时不选最优、改从前三里随机的概率。 */
  noise: number;
  /** sampled 时评估的猜测数。 */
  sampleSize: number;
  /** 每步犯错（猜一个与反馈矛盾的已知角色）的概率。 */
  mistakeRate: number;
  /** 一致候选不超过该数时直接下注（猜权重最高的）。 */
  lockThreshold: number;
  thinkMedianMs: number;
  thinkSigma: number;
  /** 首猜从开局排名前 K 个已知角色里等概率挑；0 表示按热度加权随机。 */
  openingTopK: number;
  /** 一致的已知候选为空时，每步「想起」一个一致但原本不认识的角色的概率。 */
  recallRate: number;
}

/** 强度锚点：数值型字段在两档之间线性插值，离散字段取最近锚点并可小幅偏移。 */
export const CEE_RANKED_BOT_ANCHORS: ReadonlyArray<{
  rating: number;
  strength: CEERankedBotStrength;
}> = [
  {
    rating: 800,
    strength: {
      knowledge: 0.45,
      dims: [...CEE_RANKED_NUMERIC_DIMENSIONS],
      strategy: "random",
      noise: 1,
      sampleSize: 0,
      mistakeRate: 0.25,
      lockThreshold: 1,
      thinkMedianMs: 26000,
      thinkSigma: 0.5,
      openingTopK: 0,
      recallRate: 0.1,
    },
  },
  {
    rating: 1100,
    strength: {
      knowledge: 0.6,
      dims: [...CEE_RANKED_NUMERIC_DIMENSIONS, "sharedAppearances"],
      strategy: "consistent",
      noise: 0.8,
      sampleSize: 0,
      mistakeRate: 0.18,
      lockThreshold: 2,
      thinkMedianMs: 21000,
      thinkSigma: 0.45,
      openingTopK: 0,
      recallRate: 0.15,
    },
  },
  {
    rating: 1400,
    strength: {
      knowledge: 0.75,
      dims: [...CEE_RANKED_NUMERIC_DIMENSIONS, "sharedAppearances", "tags"],
      strategy: "sampled",
      noise: 0.5,
      sampleSize: 24,
      mistakeRate: 0.1,
      lockThreshold: 2,
      thinkMedianMs: 17000,
      thinkSigma: 0.4,
      openingTopK: 20,
      recallRate: 0.2,
    },
  },
  {
    rating: 1700,
    strength: {
      knowledge: 0.88,
      dims: [...CEE_RANKED_ALL_DIMENSIONS],
      strategy: "sampled",
      noise: 0.25,
      sampleSize: 64,
      mistakeRate: 0.06,
      lockThreshold: 3,
      thinkMedianMs: 14000,
      thinkSigma: 0.35,
      openingTopK: 10,
      recallRate: 0.25,
    },
  },
  {
    rating: 2000,
    strength: {
      knowledge: 0.96,
      dims: [...CEE_RANKED_ALL_DIMENSIONS],
      strategy: "optimal",
      noise: 0.1,
      sampleSize: 0,
      mistakeRate: 0.03,
      lockThreshold: 3,
      thinkMedianMs: 11000,
      thinkSigma: 0.3,
      openingTopK: 5,
      recallRate: 0.3,
    },
  },
  {
    rating: 2300,
    strength: {
      knowledge: 1,
      dims: [...CEE_RANKED_ALL_DIMENSIONS],
      strategy: "optimal",
      noise: 0.02,
      sampleSize: 0,
      mistakeRate: 0.01,
      lockThreshold: 3,
      thinkMedianMs: 8500,
      thinkSigma: 0.3,
      openingTopK: 3,
      recallRate: 0.35,
    },
  },
];

const RATING_FLOOR = 800;
const RATING_CEILING = 2300;
const DISCRETE_SHIFT_RATE = 0.25;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

/** 找到分数落在的锚点区间；超出锚点范围时夹到两端。 */
const anchorBracket = (rating: number): { lower: number; upper: number; ratio: number } => {
  const bounded = clamp(rating, RATING_FLOOR, RATING_CEILING);
  let lower = 0;
  while (
    lower + 1 < CEE_RANKED_BOT_ANCHORS.length &&
    bounded > CEE_RANKED_BOT_ANCHORS[lower + 1].rating
  )
    lower += 1;
  const upper = lower + 1;
  const span = CEE_RANKED_BOT_ANCHORS[upper].rating - CEE_RANKED_BOT_ANCHORS[lower].rating;
  return {
    lower,
    upper,
    ratio: span <= 0 ? 0 : (bounded - CEE_RANKED_BOT_ANCHORS[lower].rating) / span,
  };
};

/** 离散字段以 25% 概率偏移到最近锚点的相邻锚点，两端锚点只有一侧可去。 */
const shiftedIndex = (nearest: number, random: () => number): number => {
  if (random() >= DISCRETE_SHIFT_RATE) return nearest;
  const target = nearest + (random() < 0.5 ? -1 : 1);
  return target >= 0 && target < CEE_RANKED_BOT_ANCHORS.length ? target : nearest;
};

export function ceeRankedBotStrength(
  targetRating: number,
  random: () => number
): CEERankedBotStrength {
  const { lower, upper, ratio } = anchorBracket(targetRating);
  const from = CEE_RANKED_BOT_ANCHORS[lower].strength;
  const to = CEE_RANKED_BOT_ANCHORS[upper].strength;
  const mix = (a: number, b: number): number =>
    ratio === 0 ? a : ratio === 1 ? b : a + (b - a) * ratio;
  const discrete =
    CEE_RANKED_BOT_ANCHORS[shiftedIndex(ratio <= 0.5 ? lower : upper, random)].strength;
  return {
    knowledge: mix(from.knowledge, to.knowledge),
    dims: discrete.dims,
    strategy: discrete.strategy,
    noise: mix(from.noise, to.noise),
    sampleSize: Math.round(mix(from.sampleSize, to.sampleSize)),
    mistakeRate: mix(from.mistakeRate, to.mistakeRate),
    lockThreshold: discrete.lockThreshold,
    thinkMedianMs: mix(from.thinkMedianMs, to.thinkMedianMs),
    thinkSigma: mix(from.thinkSigma, to.thinkSigma),
    openingTopK: Math.round(mix(from.openingTopK, to.openingTopK)),
    recallRate: mix(from.recallRate, to.recallRate),
  };
}

export type CEERankedPersonaId = "aiga" | "dango" | "awen" | "kaoju" | "mangmang" | "yemao";
export type CEERankedTempo = "steady" | "erratic" | "warmup";
export interface CEERankedPersona {
  id: CEERankedPersonaId;
  name: string;
  /** 选角色时热度权重的指数：越大越偏爱热门。 */
  popularityBias: number;
  mistakeFactor: number;
  thinkFactor: number;
  lockOffset: number;
  idleRate: number;
  tempo: CEERankedTempo;
  openingStyle: "ranked" | "popular";
}

export const CEE_RANKED_PERSONAS: readonly CEERankedPersona[] = [
  {
    id: "aiga",
    name: "爱噶",
    popularityBias: 0,
    mistakeFactor: 0,
    thinkFactor: 1,
    lockOffset: 0,
    idleRate: 0,
    tempo: "steady",
    openingStyle: "ranked",
  },
  {
    id: "dango",
    name: "团子",
    popularityBias: 1.5,
    mistakeFactor: 1.4,
    thinkFactor: 0.8,
    lockOffset: 0,
    idleRate: 0.05,
    tempo: "steady",
    openingStyle: "popular",
  },
  {
    id: "awen",
    name: "阿稳",
    popularityBias: 0.5,
    mistakeFactor: 0.4,
    thinkFactor: 1.3,
    lockOffset: -1,
    idleRate: 0.03,
    tempo: "steady",
    openingStyle: "ranked",
  },
  {
    id: "kaoju",
    name: "考据君",
    popularityBias: 0.3,
    mistakeFactor: 0.8,
    thinkFactor: 1.1,
    lockOffset: 0,
    idleRate: 0.06,
    tempo: "steady",
    openingStyle: "ranked",
  },
  {
    id: "mangmang",
    name: "莽莽",
    popularityBias: 1,
    mistakeFactor: 1.2,
    thinkFactor: 0.9,
    lockOffset: 2,
    idleRate: 0.04,
    tempo: "erratic",
    openingStyle: "popular",
  },
  {
    id: "yemao",
    name: "夜猫",
    popularityBias: 0.8,
    mistakeFactor: 1,
    thinkFactor: 1,
    lockOffset: 0,
    idleRate: 0.1,
    tempo: "warmup",
    openingStyle: "ranked",
  },
];

/** 爱噶每局固定的第一手：丰川祥子（本地数据集角色编号）。 */
export const CEE_RANKED_AIGA_OPENING_ID = 132476;

/** 等概率抽一个人格，avoid 给定时不抽它。 */
export function pickCEERankedPersona(
  random: () => number,
  avoid?: CEERankedPersonaId
): CEERankedPersona {
  const options = CEE_RANKED_PERSONAS.filter((persona) => persona.id !== avoid);
  return options[Math.min(options.length - 1, Math.floor(random() * options.length))];
}

export interface CEERankedBotBrain {
  persona: CEERankedPersona;
  strength: CEERankedBotStrength;
  /** 爱噶的猜测间隔按对手分数决定。 */
  opponentRating: number;
  known: Set<number>;
  observations: CEERankedObservation[];
  guessed: Set<number>;
  step: number;
}

const KAOJU_EVIDENCE_DIMENSIONS: readonly CEERankedDimension[] = [
  "tags",
  "sharedAppearances",
  "extraTags",
];

/** 考据君总会用上证据类维度，爱噶固定用全维度。 */
const effectiveDims = (
  personaId: CEERankedPersonaId,
  dims: readonly CEERankedDimension[]
): readonly CEERankedDimension[] => {
  if (personaId === "aiga") return [...CEE_RANKED_ALL_DIMENSIONS];
  if (personaId !== "kaoju") return dims;
  return [...dims, ...KAOJU_EVIDENCE_DIMENSIONS.filter((dim) => !dims.includes(dim))];
};

const randomIndex = (length: number, random: () => number): number =>
  Math.min(length - 1, Math.floor(random() * length));

const weightedIndex = (weights: readonly number[], random: () => number): number => {
  const total = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
  if (total <= 0) return randomIndex(weights.length, random);
  let roll = random() * total;
  for (let index = 0; index < weights.length; index += 1) {
    roll -= Math.max(0, weights[index]);
    if (roll < 0) return index;
  }
  return weights.length - 1;
};

const pickWeighted = (
  items: readonly CEERankedCandidate[],
  weightOf: (candidate: CEERankedCandidate) => number,
  random: () => number
): CEERankedCandidate => items[weightedIndex(items.map(weightOf), random)];

const pickTied = <T>(items: readonly T[], random: () => number): T =>
  items[randomIndex(items.length, random)];

const pickHeaviest = (
  items: readonly CEERankedCandidate[],
  random: () => number
): CEERankedCandidate => {
  const best = items.reduce((max, item) => Math.max(max, item.weight), Number.NEGATIVE_INFINITY);
  return pickTied(
    items.filter((item) => item.weight === best),
    random
  );
};

/** 热度权重：指数越大越偏爱热门，热度 0 也要有权重所以基数取 1。 */
const heatWeight = (character: CEECharacterView, persona: CEERankedPersona): number =>
  Math.pow(character.popularity + 1, persona.popularityBias);

const takeRandom = (
  items: readonly CEERankedCandidate[],
  count: number,
  random: () => number
): CEERankedCandidate[] => {
  const rest = [...items];
  const taken: CEERankedCandidate[] = [];
  while (taken.length < count && rest.length)
    taken.push(rest.splice(randomIndex(rest.length, random), 1)[0]);
  return taken;
};

/** 按 knowledge × 题库大小（至少 1 个）以热度为权重无放回抽取认识的角色。 */
const drawKnown = (
  knowledge: number,
  pool: readonly CEERankedCandidate[],
  random: () => number
): Set<number> => {
  const target = Math.min(pool.length, Math.max(1, Math.round(knowledge * pool.length)));
  const rest = [...pool];
  const known = new Set<number>();
  while (known.size < target && rest.length) {
    const picked = pickWeighted(rest, (item) => item.character.popularity + 1, random);
    known.add(picked.character.id);
    rest.splice(rest.indexOf(picked), 1);
  }
  return known;
};

export function createCEERankedBot(input: {
  persona: CEERankedPersona;
  strength: CEERankedBotStrength;
  opponentRating: number;
  pool: readonly CEERankedCandidate[];
  random: () => number;
}): CEERankedBotBrain {
  const dims = effectiveDims(input.persona.id, input.strength.dims);
  const strength = { ...input.strength, dims };
  const known =
    input.persona.id === "aiga"
      ? new Set(input.pool.map((item) => item.character.id))
      : drawKnown(strength.knowledge, input.pool, input.random);
  return {
    persona: input.persona,
    strength,
    opponentRating: input.opponentRating,
    known,
    observations: [],
    guessed: new Set(),
    step: 0,
  };
}

export function recordCEERankedBotFeedback(
  brain: CEERankedBotBrain,
  guess: CEECharacterView,
  feedback: CEEFeedback
): void {
  brain.observations.push({ guess, feedback });
  brain.guessed.add(guess.id);
  brain.step += 1;
}

/** 该人格此刻还能猜的题库候选：没猜过，且要么认识、要么是爱噶（整个题库都认识）。 */
export const ceeRankedBotEligible = (
  brain: CEERankedBotBrain,
  pool: readonly CEERankedCandidate[]
): CEERankedCandidate[] =>
  pool.filter(
    (item) =>
      !brain.guessed.has(item.character.id) &&
      (brain.persona.id === "aiga" || brain.known.has(item.character.id))
  );

const consistentFor = (
  brain: CEERankedBotBrain,
  candidates: readonly CEERankedCandidate[],
  settings: CEESettings
): CEERankedCandidate[] =>
  filterCEECandidates(candidates, brain.observations, brain.strength.dims, settings);

/** 一致候选为空时按概率「想起」一个一致但原本不认识的角色。 */
const recallConsistent = (
  brain: CEERankedBotBrain,
  eligible: readonly CEERankedCandidate[],
  pool: readonly CEERankedCandidate[],
  settings: CEESettings,
  random: () => number
): CEERankedCandidate[] => {
  if (random() >= brain.strength.recallRate) return [];
  const strangers = pool.filter(
    (item) => !brain.known.has(item.character.id) && !brain.guessed.has(item.character.id)
  );
  const remembered = consistentFor(brain, strangers, settings);
  if (!remembered.length) return [];
  const recalled = pickWeighted(remembered, (item) => item.character.popularity + 1, random);
  brain.known.add(recalled.character.id);
  return consistentFor(brain, [...eligible, recalled], settings);
};

const fewestViolations = (
  brain: CEERankedBotBrain,
  candidates: readonly CEERankedCandidate[],
  settings: CEESettings
): CEERankedCandidate[] => {
  let best = Number.POSITIVE_INFINITY;
  const tied: CEERankedCandidate[] = [];
  for (const candidate of candidates) {
    const count = countCEEViolations(
      candidate.character,
      brain.observations,
      brain.strength.dims,
      settings
    );
    if (count < best) {
      best = count;
      tied.length = 0;
      tied.push(candidate);
    } else if (count === best) tied.push(candidate);
  }
  return tied;
};

const slipGuess = (
  brain: CEERankedBotBrain,
  eligible: readonly CEERankedCandidate[],
  consistent: readonly CEERankedCandidate[],
  random: () => number
): number | null => {
  const chance = clamp(brain.strength.mistakeRate * brain.persona.mistakeFactor, 0, 1);
  if (chance <= 0 || random() >= chance) return null;
  const consistentIds = new Set(consistent.map((item) => item.character.id));
  const slips = eligible.filter((item) => !consistentIds.has(item.character.id));
  return slips.length ? pickTied(slips, random).character.id : null;
};

const openingGuess = (
  brain: CEERankedBotBrain,
  eligible: readonly CEERankedCandidate[],
  openings: ReadonlyArray<{ id: number }>,
  random: () => number
): number => {
  const { openingTopK } = brain.strength;
  if (brain.persona.openingStyle === "ranked" && openingTopK > 0) {
    const knownIds = new Set(eligible.map((item) => item.character.id));
    const ranked = openings.filter((entry) => knownIds.has(entry.id)).slice(0, openingTopK);
    if (ranked.length) return pickTied(ranked, random).id;
  }
  return pickWeighted(eligible, (item) => heatWeight(item.character, brain.persona), random)
    .character.id;
};

/** sampled 的评估名额：一致集里取一半，其余名额给已知但未猜过的角色。 */
const sampledCandidates = (
  brain: CEERankedBotBrain,
  eligible: readonly CEERankedCandidate[],
  consistent: readonly CEERankedCandidate[],
  random: () => number
): CEERankedCandidate[] => {
  const quota = Math.max(1, brain.strength.sampleSize);
  const consistentIds = new Set(consistent.map((item) => item.character.id));
  const fromConsistent = takeRandom(consistent, Math.max(1, Math.floor(quota / 2)), random);
  const others = eligible.filter((item) => !consistentIds.has(item.character.id));
  return [...fromConsistent, ...takeRandom(others, quota - fromConsistent.length, random)];
};

const scoredGuess = (
  brain: CEERankedBotBrain,
  guesses: readonly CEERankedCandidate[],
  consistent: readonly CEERankedCandidate[],
  settings: CEESettings,
  random: () => number
): number => {
  const consistentIds = new Set(consistent.map((item) => item.character.id));
  const ranked = guesses
    .map((item) => ({
      item,
      split: evaluateCEEGuess(item.character, consistent, brain.strength.dims, settings),
    }))
    .sort(
      (a, b) =>
        a.split.expectedRemaining - b.split.expectedRemaining ||
        Number(consistentIds.has(b.item.character.id)) -
          Number(consistentIds.has(a.item.character.id)) ||
        b.item.weight - a.item.weight ||
        a.item.character.id - b.item.character.id
    );
  if (brain.strength.noise > 0 && ranked.length > 1 && random() < brain.strength.noise) {
    const top = ranked.slice(0, 3);
    return top[randomIndex(top.length, random)].item.character.id;
  }
  return ranked[0].item.character.id;
};

const strategyGuess = (
  brain: CEERankedBotBrain,
  eligible: readonly CEERankedCandidate[],
  consistent: readonly CEERankedCandidate[],
  settings: CEESettings,
  random: () => number
): number => {
  const { strategy } = brain.strength;
  if (strategy === "random")
    return pickWeighted(eligible, (item) => heatWeight(item.character, brain.persona), random)
      .character.id;
  if (strategy === "consistent")
    return pickWeighted(
      consistent,
      (item) => item.weight * heatWeight(item.character, brain.persona),
      random
    ).character.id;
  const guesses =
    strategy === "optimal" ? eligible : sampledCandidates(brain, eligible, consistent, random);
  return scoredGuess(brain, guesses, consistent, settings, random);
};

const aigaGuess = (
  brain: CEERankedBotBrain,
  pool: readonly CEERankedCandidate[],
  settings: CEESettings
): number => {
  if (brain.step === 0) return CEE_RANKED_AIGA_OPENING_ID;
  const pending = ceeRankedBotEligible(brain, pool);
  const consistent = filterCEECandidates(
    pending,
    brain.observations,
    CEE_RANKED_ALL_DIMENSIONS,
    settings
  );
  if (consistent.length) return chooseCEEBisectionGuess(consistent, settings, brain.guessed).id;
  if (!pending.length) throw new AppError("RANKED_NO_CANDIDATE", "人机已没有可猜的已知角色");
  const tied = fewestViolations(brain, pending, settings);
  return Math.min(...tied.map((item) => item.character.id));
};

const regularGuess = (
  brain: CEERankedBotBrain,
  pool: readonly CEERankedCandidate[],
  openings: ReadonlyArray<{ id: number }>,
  settings: CEESettings,
  random: () => number
): number => {
  const eligible = ceeRankedBotEligible(brain, pool);
  if (!eligible.length) throw new AppError("RANKED_NO_CANDIDATE", "人机已没有可猜的已知角色");
  if (brain.step === 0) return openingGuess(brain, eligible, openings, random);
  let consistent = consistentFor(brain, eligible, settings);
  if (!consistent.length) {
    consistent = recallConsistent(brain, eligible, pool, settings, random);
    if (!consistent.length)
      return pickTied(fewestViolations(brain, eligible, settings), random).character.id;
  }
  const slipped = slipGuess(brain, eligible, consistent, random);
  if (slipped !== null) return slipped;
  const lockLimit = Math.max(1, brain.strength.lockThreshold + brain.persona.lockOffset);
  if (consistent.length <= lockLimit) return pickHeaviest(consistent, random).character.id;
  return strategyGuess(brain, eligible, consistent, settings, random);
};

export function nextCEERankedBotGuess(
  brain: CEERankedBotBrain,
  pool: readonly CEERankedCandidate[],
  openings: ReadonlyArray<{ id: number }>,
  settings: CEESettings,
  random: () => number
): number {
  // 爱噶的出手是固定规则，不消耗 random；random 只用于她的思考时长。
  if (brain.persona.id === "aiga") return aigaGuess(brain, pool, settings);
  return regularGuess(brain, pool, openings, settings, random);
}

const THINK_FLOOR_MS = 2500;
const THINK_CEILING_MS = 60000;

/** 标准正态：Box–Muller，只依赖传入的 random。 */
const gaussian = (random: () => number): number =>
  Math.sqrt(-2 * Math.log(Math.max(1e-12, random()))) * Math.cos(2 * Math.PI * random());

const logNormalMs = (median: number, sigma: number, random: () => number): number =>
  clamp(Math.round(median * Math.exp(sigma * gaussian(random))), THINK_FLOOR_MS, THINK_CEILING_MS);

const AIGA_CURVE: ReadonlyArray<{ rating: number; medianMs: number }> = [
  { rating: 800, medianMs: 35000 },
  { rating: 1500, medianMs: 18000 },
  { rating: 2300, medianMs: 7000 },
];
const AIGA_SIGMA = 0.15;

/** 爱噶的思考时长：只看对手分数。 */
export function ceeRankedAigaThinkMs(opponentRating: number, random: () => number): number {
  const bounded = clamp(
    opponentRating,
    AIGA_CURVE[0].rating,
    AIGA_CURVE[AIGA_CURVE.length - 1].rating
  );
  let segment = 0;
  while (segment + 1 < AIGA_CURVE.length && bounded > AIGA_CURVE[segment + 1].rating) segment += 1;
  const from = AIGA_CURVE[segment];
  const to = AIGA_CURVE[Math.min(segment + 1, AIGA_CURVE.length - 1)];
  const ratio = to.rating === from.rating ? 0 : (bounded - from.rating) / (to.rating - from.rating);
  return logNormalMs(from.medianMs + (to.medianMs - from.medianMs) * ratio, AIGA_SIGMA, random);
}

const tempoFactor = (tempo: CEERankedTempo, step: number): number => {
  if (tempo !== "warmup") return 1;
  if (step === 0) return 1.8;
  return step === 1 ? 1.5 : 0.8;
};

export function ceeRankedBotThinkMs(
  brain: CEERankedBotBrain,
  candidatesLeft: number,
  random: () => number
): number {
  if (brain.persona.id === "aiga") return ceeRankedAigaThinkMs(brain.opponentRating, random);
  const phase = brain.step === 0 ? 1.3 : candidatesLeft <= 3 ? 0.6 : 1;
  const sigma = brain.strength.thinkSigma + (brain.persona.tempo === "erratic" ? 0.3 : 0);
  const median =
    brain.strength.thinkMedianMs *
    brain.persona.thinkFactor *
    phase *
    tempoFactor(brain.persona.tempo, brain.step);
  const value = median * Math.exp(sigma * gaussian(random));
  const idle = random() < brain.persona.idleRate ? 10000 + random() * 10000 : 0;
  return clamp(Math.round(value + idle), THINK_FLOOR_MS, THINK_CEILING_MS);
}
