import {
  CEE_RANKED_ALL_DIMENSIONS,
  CEE_RANKED_NUMERIC_DIMENSIONS,
  type CEERankedDimension,
} from "./CEERankedSolver";

// 排位人机的强度档与人格：六档锚点与插值、六个人格、爱噶的固定开局。纯数据，决策见 CEERankedBot。

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

export const clamp = (value: number, low: number, high: number): number =>
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
