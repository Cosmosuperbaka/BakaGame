import {
  CEE_RANKED_ALL_DIMENSIONS,
  CEE_RANKED_NUMERIC_DIMENSIONS,
  type CEERankedDimension,
} from "./CEERankedSolver";

// 排位人机的强度档与人格：锚点与插值、档位与实战分的换算、六个人格、爱噶的招牌开局。纯数据与
// 纯换算，决策见 CEERankedBot。

export type CEERankedStrategy = "random" | "consistent" | "sampled" | "optimal";
export interface CEERankedBotStrength {
  /** 在参考大小的题库里认识角色的比例（0–1），按热度加权抽取；换算见 `ceeRankedKnownCount`。 */
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

/**
 * 强度锚点：数值型字段在两档之间线性插值，离散字段取最近锚点并可小幅偏移。
 *
 * `level` 是强度表的档位，只用来插值；`rating` 是该档基线人格的实战分，与计分同一尺度
 * （按 `expectedCEESeriesScore` 对最大偏差人机的口径，由标定脚本在参考题库上互打拟合）。
 * 开局按想要的实战分反查档位，计分按档位换回的实战分算，两者不再混用：档位分差与实战分差
 * 并不成比例，混用会让高分段人机名不副实。
 *
 * 4100 档起推理基本完美（认识最大题库的全部角色、不犯错、线索几乎全用上），再往上只靠出手越来越快
 * 变强；表的顶端远高于任何真人能到的分数，高分玩家碰不到人机的上限。
 */
export const CEE_RANKED_BOT_ANCHORS: ReadonlyArray<{
  level: number;
  rating: number;
  strength: CEERankedBotStrength;
}> = [
  {
    level: 800,
    rating: 947,
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
    level: 1100,
    rating: 1175,
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
    level: 1400,
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
    level: 1700,
    rating: 1550,
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
    level: 2000,
    rating: 1721,
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
    level: 2300,
    rating: 1833,
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
  {
    level: 2600,
    rating: 2038,
    strength: {
      knowledge: 0.4,
      dims: [...CEE_RANKED_ALL_DIMENSIONS],
      strategy: "optimal",
      noise: 0.01,
      sampleSize: 0,
      mistakeRate: 0.01,
      lockThreshold: 3,
      thinkMedianMs: 8000,
      thinkSigma: 0.7,
      openingTopK: 2,
      recallRate: 0.2,
      memory: 10,
      numericReliability: 0.95,
      evidenceReliability: 0.8,
      firstGuessMedianMs: 4000,
    },
  },
  {
    level: 2900,
    rating: 2271,
    strength: {
      knowledge: 0.55,
      dims: [...CEE_RANKED_ALL_DIMENSIONS],
      strategy: "optimal",
      noise: 0,
      sampleSize: 0,
      mistakeRate: 0.005,
      lockThreshold: 3,
      thinkMedianMs: 5500,
      thinkSigma: 0.6,
      openingTopK: 1,
      recallRate: 0.25,
      memory: 12,
      numericReliability: 0.98,
      evidenceReliability: 0.9,
      firstGuessMedianMs: 3000,
    },
  },
  {
    level: 3200,
    rating: 2491,
    strength: {
      knowledge: 0.75,
      dims: [...CEE_RANKED_ALL_DIMENSIONS],
      strategy: "optimal",
      noise: 0,
      sampleSize: 0,
      mistakeRate: 0.002,
      lockThreshold: 3,
      thinkMedianMs: 4200,
      thinkSigma: 0.55,
      openingTopK: 1,
      recallRate: 0.35,
      memory: 16,
      numericReliability: 0.99,
      evidenceReliability: 0.95,
      firstGuessMedianMs: 2600,
    },
  },
  {
    level: 3500,
    rating: 2727,
    strength: {
      knowledge: 0.95,
      dims: [...CEE_RANKED_ALL_DIMENSIONS],
      strategy: "optimal",
      noise: 0,
      sampleSize: 0,
      mistakeRate: 0.001,
      lockThreshold: 3,
      thinkMedianMs: 3500,
      thinkSigma: 0.5,
      openingTopK: 1,
      recallRate: 0.45,
      memory: 20,
      numericReliability: 0.995,
      evidenceReliability: 0.98,
      firstGuessMedianMs: 2250,
    },
  },
  {
    level: 3800,
    rating: 3080,
    strength: {
      knowledge: 1.15,
      dims: [...CEE_RANKED_ALL_DIMENSIONS],
      strategy: "optimal",
      noise: 0,
      sampleSize: 0,
      mistakeRate: 0.0005,
      lockThreshold: 3,
      thinkMedianMs: 2900,
      thinkSigma: 0.47,
      openingTopK: 1,
      recallRate: 0.6,
      memory: 24,
      numericReliability: 0.998,
      evidenceReliability: 0.99,
      firstGuessMedianMs: 1950,
    },
  },
  {
    level: 4100,
    rating: 3396,
    strength: {
      knowledge: 1.4,
      dims: [...CEE_RANKED_ALL_DIMENSIONS],
      strategy: "optimal",
      noise: 0,
      sampleSize: 0,
      mistakeRate: 0,
      lockThreshold: 3,
      thinkMedianMs: 2400,
      thinkSigma: 0.45,
      openingTopK: 1,
      recallRate: 0.75,
      memory: 30,
      numericReliability: 0.999,
      evidenceReliability: 0.995,
      firstGuessMedianMs: 1700,
    },
  },
  {
    level: 4400,
    rating: 3773,
    strength: {
      knowledge: 1.4,
      dims: [...CEE_RANKED_ALL_DIMENSIONS],
      strategy: "optimal",
      noise: 0,
      sampleSize: 0,
      mistakeRate: 0,
      lockThreshold: 3,
      thinkMedianMs: 2000,
      thinkSigma: 0.42,
      openingTopK: 1,
      recallRate: 0.85,
      memory: 30,
      numericReliability: 0.9995,
      evidenceReliability: 0.998,
      firstGuessMedianMs: 1450,
    },
  },
  {
    level: 4700,
    rating: 4146,
    strength: {
      knowledge: 1.4,
      dims: [...CEE_RANKED_ALL_DIMENSIONS],
      strategy: "optimal",
      noise: 0,
      sampleSize: 0,
      mistakeRate: 0,
      lockThreshold: 3,
      thinkMedianMs: 1650,
      thinkSigma: 0.4,
      openingTopK: 1,
      recallRate: 0.95,
      memory: 30,
      numericReliability: 0.9998,
      evidenceReliability: 0.999,
      firstGuessMedianMs: 1250,
    },
  },
  {
    level: 5000,
    rating: 4565,
    strength: {
      knowledge: 1.4,
      dims: [...CEE_RANKED_ALL_DIMENSIONS],
      strategy: "optimal",
      noise: 0,
      sampleSize: 0,
      mistakeRate: 0,
      lockThreshold: 3,
      thinkMedianMs: 1350,
      thinkSigma: 0.37,
      openingTopK: 1,
      recallRate: 1,
      memory: 30,
      numericReliability: 1,
      evidenceReliability: 1,
      firstGuessMedianMs: 1050,
    },
  },
  {
    level: 5300,
    rating: 4970,
    strength: {
      knowledge: 1.4,
      dims: [...CEE_RANKED_ALL_DIMENSIONS],
      strategy: "optimal",
      noise: 0,
      sampleSize: 0,
      mistakeRate: 0,
      lockThreshold: 3,
      thinkMedianMs: 1100,
      thinkSigma: 0.35,
      openingTopK: 1,
      recallRate: 1,
      memory: 30,
      numericReliability: 1,
      evidenceReliability: 1,
      firstGuessMedianMs: 900,
    },
  },
  {
    level: 5600,
    rating: 5343,
    strength: {
      knowledge: 1.4,
      dims: [...CEE_RANKED_ALL_DIMENSIONS],
      strategy: "optimal",
      noise: 0,
      sampleSize: 0,
      mistakeRate: 0,
      lockThreshold: 3,
      thinkMedianMs: 900,
      thinkSigma: 0.33,
      openingTopK: 1,
      recallRate: 1,
      memory: 30,
      numericReliability: 1,
      evidenceReliability: 1,
      firstGuessMedianMs: 750,
    },
  },
];

const FIRST_ANCHOR = CEE_RANKED_BOT_ANCHORS[0];
const LAST_ANCHOR = CEE_RANKED_BOT_ANCHORS[CEE_RANKED_BOT_ANCHORS.length - 1];
const DISCRETE_SHIFT_RATE = 0.25;

export const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

type AnchorAxis = "level" | "rating";

/** 找到某一轴上的值落在的锚点区间；超出锚点范围时夹到两端。两条轴都随锚点严格递增。 */
const anchorBracket = (
  value: number,
  axis: AnchorAxis = "level"
): { lower: number; upper: number; ratio: number } => {
  const bounded = clamp(value, FIRST_ANCHOR[axis], LAST_ANCHOR[axis]);
  let lower = 0;
  while (
    lower + 2 < CEE_RANKED_BOT_ANCHORS.length &&
    bounded > CEE_RANKED_BOT_ANCHORS[lower + 1][axis]
  )
    lower += 1;
  const upper = lower + 1;
  const span = CEE_RANKED_BOT_ANCHORS[upper][axis] - CEE_RANKED_BOT_ANCHORS[lower][axis];
  return {
    lower,
    upper,
    ratio: span <= 0 ? 0 : (bounded - CEE_RANKED_BOT_ANCHORS[lower][axis]) / span,
  };
};

/** 从一条轴换到另一条轴：区间内线性插值，超出锚点范围夹到两端。 */
const convertAnchor = (value: number, from: AnchorAxis, to: AnchorAxis): number => {
  const { lower, upper, ratio } = anchorBracket(value, from);
  const low = CEE_RANKED_BOT_ANCHORS[lower][to];
  return low + (CEE_RANKED_BOT_ANCHORS[upper][to] - low) * ratio;
};

/**
 * 知识面的参考题库大小：`knowledge` 是在这么大的题库里认识的比例。题库更大时认识的比例按平方根
 * 变低、更小时变高，大题库因此对人机也更难，和真人一样（入门档几乎全是热门角色，传说档跨十几年）。
 * 取值贴近标定用的 d3 题库，让锚点表的标定口径不受这一换算影响。
 */
export const CEE_RANKED_KNOWLEDGE_REFERENCE_POOL = 300;

/** 在给定大小的题库里认识多少个角色：至少 1 个，不超过题库。 */
export function ceeRankedKnownCount(knowledge: number, poolSize: number): number {
  if (poolSize <= 0) return 0;
  const count = Math.round(
    Math.max(0, knowledge) * Math.sqrt(CEE_RANKED_KNOWLEDGE_REFERENCE_POOL * poolSize)
  );
  return Math.min(poolSize, Math.max(1, count));
}

/** 普通人机能达到的实战分范围（基线人格）：想要的分数超出时只能夹到两端。 */
export const CEE_RANKED_BOT_RATING_RANGE = {
  min: FIRST_ANCHOR.rating,
  max: LAST_ANCHOR.rating,
} as const;

/** 档位换实战分（基线人格）。 */
export const ceeRankedBotRatingOfLevel = (level: number): number =>
  convertAnchor(level, "level", "rating");

/** 实战分反查档位（基线人格），超出范围夹到两端的档位。 */
export const ceeRankedBotLevelOfRating = (rating: number): number =>
  convertAnchor(rating, "rating", "level");

/** 离散字段以 25% 概率偏移到最近锚点的相邻锚点，两端锚点只有一侧可去。 */
const shiftedIndex = (nearest: number, random: () => number): number => {
  if (random() >= DISCRETE_SHIFT_RATE) return nearest;
  const target = nearest + (random() < 0.5 ? -1 : 1);
  return target >= 0 && target < CEE_RANKED_BOT_ANCHORS.length ? target : nearest;
};

/** 某档位的强度：数值字段插值，离散字段取最近锚点（可小幅偏移）。 */
export function ceeRankedBotStrength(level: number, random: () => number): CEERankedBotStrength {
  const { lower, upper, ratio } = anchorBracket(level);
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
  /**
   * 同一档位下比基线人格强多少实战分，按 `CEE_RANKED_PERSONA_OFFSET_LEVELS` 各档给出、之间插值
   * （模拟拟合，标定脚本「人格偏移」一节）。排位是抢先猜中的赛跑，思考倍率直接变成强弱，
   * 而且档位越高、每手越快，同样的倍率差得越多；开局按它把档位挪回来，每个人格对真人的期望得分
   * 因此一致。爱噶不走强度表，恒为 0。
   */
  ratingOffsets: readonly number[];
}

/** 人格偏移的取样档位：`ratingOffsets` 与它一一对应，之外夹到两端。 */
export const CEE_RANKED_PERSONA_OFFSET_LEVELS: readonly number[] = [1400, 2000, 2600, 3800, 5000];

/** 某人格在某档位下比基线人格强多少实战分。 */
export function ceeRankedPersonaOffset(persona: CEERankedPersona, level: number): number {
  const levels = CEE_RANKED_PERSONA_OFFSET_LEVELS;
  const offsets = persona.ratingOffsets;
  if (offsets.length !== levels.length) return 0;
  const bounded = clamp(level, levels[0], levels[levels.length - 1]);
  let lower = 0;
  while (lower + 2 < levels.length && bounded > levels[lower + 1]) lower += 1;
  const ratio = (bounded - levels[lower]) / (levels[lower + 1] - levels[lower]);
  return offsets[lower] + (offsets[lower + 1] - offsets[lower]) * ratio;
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
    ratingOffsets: [0, 0, 0, 0, 0],
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
    ratingOffsets: [34, 24, 17, 98, 74],
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
    ratingOffsets: [-60, -101, -107, -183, -262],
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
    ratingOffsets: [-16, -28, -70, -79, -149],
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
    ratingOffsets: [-34, -44, -56, -76, -76],
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
    ratingOffsets: [-72, -68, -190, -562, -653],
  },
];

/** 爱噶的招牌第一手：丰川祥子（本地数据集角色编号）。 */
export const CEE_RANKED_AIGA_OPENING_ID = 132476;
/**
 * 爱噶每局以招牌开局的概率；其余局从本场开局谱切分最好的前几个里等概率挑。
 * 每局都固定首手时，真人能提前把这一手的反馈算进计划。
 */
export const CEE_RANKED_AIGA_SIGNATURE_RATE = 0.3;
export const CEE_RANKED_AIGA_OPENING_TOP_K = 3;

/** 等概率抽一个人格，avoid 给定时不抽它。 */
export function pickCEERankedPersona(
  random: () => number,
  avoid?: CEERankedPersonaId
): CEERankedPersona {
  const options = CEE_RANKED_PERSONAS.filter((persona) => persona.id !== avoid);
  return options[Math.min(options.length - 1, Math.floor(random() * options.length))];
}
