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
import type { CEERankedOpening } from "./CEERankedOpeningBook";
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
  /** 只记得最近几条反馈；Infinity 表示全部。 */
  memory: number;
  /** 每一步、每条反馈里，数值与性别线索被用上的概率。 */
  numericReliability: number;
  /** 每一步、每条反馈里，共同作品与标签类线索被用上的概率。 */
  evidenceReliability: number;
  /** 第一手的思考间隔中位数（看题、回忆名单的时间都算在这里）。 */
  firstGuessMedianMs: number;
}

/** 强度锚点：数值型字段在两档之间线性插值，离散字段取最近锚点并可小幅偏移。 */
export const CEE_RANKED_BOT_ANCHORS: ReadonlyArray<{
  rating: number;
  strength: CEERankedBotStrength;
}> = [
  {
    rating: 800,
    strength: {
      knowledge: 0.15,
      dims: [...CEE_RANKED_NUMERIC_DIMENSIONS],
      strategy: "random",
      noise: 1,
      sampleSize: 0,
      mistakeRate: 0.3,
      lockThreshold: 1,
      thinkMedianMs: 45000,
      thinkSigma: 0.8,
      openingTopK: 0,
      recallRate: 0.1,
      memory: 1,
      numericReliability: 0.2,
      evidenceReliability: 0.05,
      firstGuessMedianMs: 15000,
    },
  },
  {
    rating: 1100,
    strength: {
      knowledge: 0.15,
      dims: [...CEE_RANKED_NUMERIC_DIMENSIONS, "sharedAppearances"],
      strategy: "consistent",
      noise: 0.8,
      sampleSize: 0,
      mistakeRate: 0.22,
      lockThreshold: 2,
      thinkMedianMs: 36000,
      thinkSigma: 0.8,
      openingTopK: 0,
      recallRate: 0.1,
      memory: 2,
      numericReliability: 0.35,
      evidenceReliability: 0.1,
      firstGuessMedianMs: 12000,
    },
  },
  {
    rating: 1400,
    strength: {
      knowledge: 0.15,
      dims: [...CEE_RANKED_NUMERIC_DIMENSIONS, "sharedAppearances", "tags"],
      strategy: "sampled",
      noise: 0.5,
      sampleSize: 24,
      mistakeRate: 0.15,
      lockThreshold: 2,
      thinkMedianMs: 31000,
      thinkSigma: 0.8,
      openingTopK: 20,
      recallRate: 0.1,
      memory: 3,
      numericReliability: 0.5,
      evidenceReliability: 0.2,
      firstGuessMedianMs: 11000,
    },
  },
  {
    rating: 1700,
    strength: {
      knowledge: 0.15,
      dims: [...CEE_RANKED_ALL_DIMENSIONS],
      strategy: "sampled",
      noise: 0.25,
      sampleSize: 64,
      mistakeRate: 0.09,
      lockThreshold: 3,
      thinkMedianMs: 20000,
      thinkSigma: 0.8,
      openingTopK: 10,
      recallRate: 0.1,
      memory: 4,
      numericReliability: 0.65,
      evidenceReliability: 0.35,
      firstGuessMedianMs: 8000,
    },
  },
  {
    rating: 2000,
    strength: {
      knowledge: 0.25,
      dims: [...CEE_RANKED_ALL_DIMENSIONS],
      strategy: "optimal",
      noise: 0.1,
      sampleSize: 0,
      mistakeRate: 0.05,
      lockThreshold: 3,
      thinkMedianMs: 15000,
      thinkSigma: 0.8,
      openingTopK: 5,
      recallRate: 0.12,
      memory: 6,
      numericReliability: 0.8,
      evidenceReliability: 0.5,
      firstGuessMedianMs: 6000,
    },
  },
  {
    rating: 2300,
    strength: {
      knowledge: 0.3,
      dims: [...CEE_RANKED_ALL_DIMENSIONS],
      strategy: "optimal",
      noise: 0.02,
      sampleSize: 0,
      mistakeRate: 0.02,
      lockThreshold: 3,
      thinkMedianMs: 11000,
      thinkSigma: 0.8,
      openingTopK: 3,
      recallRate: 0.15,
      memory: 8,
      numericReliability: 0.9,
      evidenceReliability: 0.65,
      firstGuessMedianMs: 5000,
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
    memory: Math.round(mix(from.memory, to.memory)),
    numericReliability: mix(from.numericReliability, to.numericReliability),
    evidenceReliability: mix(from.evidenceReliability, to.evidenceReliability),
    firstGuessMedianMs: mix(from.firstGuessMedianMs, to.firstGuessMedianMs),
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

/** 证据类线索：共同作品与两种标签，人机按 evidenceReliability 决定用不用得上。 */
const EVIDENCE_DIMENSIONS: readonly CEERankedDimension[] = [
  "sharedAppearances",
  "tags",
  "extraTags",
];

/** 考据君总会用上证据类维度，爱噶固定用全维度。 */
const effectiveDims = (
  personaId: CEERankedPersonaId,
  dims: readonly CEERankedDimension[]
): readonly CEERankedDimension[] => {
  if (personaId === "aiga") return [...CEE_RANKED_ALL_DIMENSIONS];
  if (personaId !== "kaoju") return dims;
  return [...dims, ...EVIDENCE_DIMENSIONS.filter((dim) => !dims.includes(dim))];
};

/** 强度表里抽出的维度子集：只保留 `dims` 与本组的交集，保持 `dims` 的先后顺序。 */
const dimsOfGroup = (
  dims: readonly CEERankedDimension[],
  group: readonly CEERankedDimension[]
): CEERankedDimension[] => dims.filter((dim) => group.includes(dim));

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
  // 爱噶的推理固定：记忆与可靠度不看强度表，否则她的步数会随强度档抖动。
  const strength: CEERankedBotStrength =
    input.persona.id === "aiga"
      ? {
          ...input.strength,
          dims,
          memory: Number.POSITIVE_INFINITY,
          numericReliability: 1,
          evidenceReliability: 1,
        }
      : { ...input.strength, dims };
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

/** 同一步抽到的一份「记忆」：最近 memory 条观测，以及每条观测各自用得上哪些维度。 */
interface CEERankedRecall {
  observations: readonly CEERankedObservation[];
  dimsPerObservation: readonly (readonly CEERankedDimension[])[];
}

/**
 * 回忆这一步：只取最后 memory 条反馈，每条按两个可靠度各抽一次，决定数值组与证据组线索
 * 是否用上。同一步只抽一次，让回忆、犯错、下注与策略都基于同一份结果。
 */
const drawRecall = (brain: CEERankedBotBrain, random: () => number): CEERankedRecall => {
  const { memory, numericReliability, evidenceReliability, dims } = brain.strength;
  const observations = brain.observations.slice(
    Math.max(0, brain.observations.length - Math.trunc(memory))
  );
  const dimsPerObservation = observations.map(() => {
    const numeric =
      random() < numericReliability ? dimsOfGroup(dims, CEE_RANKED_NUMERIC_DIMENSIONS) : [];
    const evidence = random() < evidenceReliability ? dimsOfGroup(dims, EVIDENCE_DIMENSIONS) : [];
    return [...numeric, ...evidence];
  });
  return { observations, dimsPerObservation };
};

const consistentFor = (
  brain: CEERankedBotBrain,
  candidates: readonly CEERankedCandidate[],
  recall: CEERankedRecall,
  settings: CEESettings
): CEERankedCandidate[] =>
  filterCEECandidates(
    candidates,
    recall.observations,
    brain.strength.dims,
    settings,
    recall.dimsPerObservation
  );

/** 一致候选为空时按概率「想起」一个一致但原本不认识的角色。 */
const recallConsistent = (
  brain: CEERankedBotBrain,
  eligible: readonly CEERankedCandidate[],
  pool: readonly CEERankedCandidate[],
  recall: CEERankedRecall,
  settings: CEESettings,
  random: () => number
): CEERankedCandidate[] => {
  if (random() >= brain.strength.recallRate) return [];
  const strangers = pool.filter(
    (item) => !brain.known.has(item.character.id) && !brain.guessed.has(item.character.id)
  );
  const remembered = consistentFor(brain, strangers, recall, settings);
  if (!remembered.length) return [];
  const recalled = pickWeighted(remembered, (item) => item.character.popularity + 1, random);
  brain.known.add(recalled.character.id);
  return consistentFor(brain, [...eligible, recalled], recall, settings);
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

/** 开局热度权重：与 `heatWeight` 同口径，热度 0 也要有权重所以基数取 1。 */
const openingWeight = (opening: CEERankedOpening, persona: CEERankedPersona): number =>
  Math.pow(opening.popularity + 1, persona.popularityBias);

const openingGuess = (
  brain: CEERankedBotBrain,
  eligible: readonly CEERankedCandidate[],
  openings: ReadonlyArray<CEERankedOpening>,
  random: () => number
): number => {
  const fresh = openings.filter((entry) => !brain.guessed.has(entry.id));
  const { openingTopK } = brain.strength;
  // 开局谱角色不要求在本场题库里，也不要求她「被认识」：猜她照样有反馈。
  const options =
    brain.persona.openingStyle === "ranked" && openingTopK > 0
      ? fresh.slice(0, openingTopK)
      : fresh.filter((entry) => entry.famous);
  if (options.length) {
    const weights = options.map((entry) => openingWeight(entry, brain.persona));
    return options[weightedIndex(weights, random)].id;
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
  openings: ReadonlyArray<CEERankedOpening>,
  settings: CEESettings,
  random: () => number
): number => {
  const eligible = ceeRankedBotEligible(brain, pool);
  if (!eligible.length) throw new AppError("RANKED_NO_CANDIDATE", "人机已没有可猜的已知角色");
  if (brain.step === 0) return openingGuess(brain, eligible, openings, random);
  const recall = drawRecall(brain, random);
  let consistent = consistentFor(brain, eligible, recall, settings);
  if (!consistent.length) {
    consistent = recallConsistent(brain, eligible, pool, recall, settings, random);
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
  openings: ReadonlyArray<CEERankedOpening>,
  settings: CEESettings,
  random: () => number
): number {
  // 爱噶的出手是固定规则，不消耗 random；random 只用于她的思考时长。
  if (brain.persona.id === "aiga") return aigaGuess(brain, pool, settings);
  return regularGuess(brain, pool, openings, settings, random);
}

const THINK_FLOOR_MS = 2500;
/** 普通人格的间隔上限：真人 p90 的相邻间隔约 1 分钟，留出发呆的余量。 */
const THINK_CEILING_MS = 90000;
/** 爱噶的间隔上限：低分段她的中位数接近两分钟，再低会把曲线夹平。 */
const AIGA_CEILING_MS = 120000;

/** 标准正态：Box–Muller，只依赖传入的 random。 */
const gaussian = (random: () => number): number =>
  Math.sqrt(-2 * Math.log(Math.max(1e-12, random()))) * Math.cos(2 * Math.PI * random());

const logNormalMs = (
  median: number,
  sigma: number,
  ceiling: number,
  random: () => number
): number =>
  clamp(Math.round(median * Math.exp(sigma * gaussian(random))), THINK_FLOOR_MS, ceiling);

/**
 * 爱噶每手思考间隔的中位数，只按对手分数插值。她的推理固定且完美（基本 2～3 手猜中），
 * 难度全靠速度：每个锚点让她对同分基线人机的系列赛胜率在七成五左右（标定脚本「爱噶对齐」一节），
 * 比同分普通人机难缠但打得过。她比标称分强出的部分记在计分上（见 `CEERankedHandicap` 的先验）。
 */
export const CEE_RANKED_AIGA_THINK_CURVE: ReadonlyArray<{ rating: number; medianMs: number }> = [
  { rating: 800, medianMs: 113000 },
  { rating: 1100, medianMs: 96000 },
  { rating: 1400, medianMs: 53000 },
  { rating: 1700, medianMs: 32000 },
  { rating: 2000, medianMs: 15000 },
  { rating: 2300, medianMs: 10000 },
];
const AIGA_CURVE = CEE_RANKED_AIGA_THINK_CURVE;
const AIGA_SIGMA = 0.2;

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
  return logNormalMs(
    from.medianMs + (to.medianMs - from.medianMs) * ratio,
    AIGA_SIGMA,
    AIGA_CEILING_MS,
    random
  );
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
  const phase = candidatesLeft <= 3 ? 0.6 : 1;
  const sigma = brain.strength.thinkSigma + (brain.persona.tempo === "erratic" ? 0.3 : 0);
  const base = brain.step === 0 ? brain.strength.firstGuessMedianMs : brain.strength.thinkMedianMs;
  const median =
    base * brain.persona.thinkFactor * phase * tempoFactor(brain.persona.tempo, brain.step);
  const value = median * Math.exp(sigma * gaussian(random));
  const idle = random() < brain.persona.idleRate ? 10000 + random() * 10000 : 0;
  return clamp(Math.round(value + idle), THINK_FLOOR_MS, THINK_CEILING_MS);
}
