import type { CEERankedBotBrain } from "./CEERankedBot";
import { clamp, type CEERankedTempo } from "./CEERankedBotProfile";

// 排位人机的思考时长：普通人格按强度档与节奏，爱噶只看她自己的节奏分。

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
 * 爱噶每手思考间隔的中位数，按她这场的实战分插值。她的推理固定且完美（基本 2～3 手猜中），
 * 难度全靠速度：曲线上每个点的 `rating` 是她按该间隔出手时的实战分，与普通人机锚点的
 * `rating` 同一尺度（标定脚本「爱噶曲线」一节按对基线人机的系列赛得分拟合）。
 */
export const CEE_RANKED_AIGA_THINK_CURVE: ReadonlyArray<{ rating: number; medianMs: number }> = [
  { rating: 1150, medianMs: 120000 },
  { rating: 1400, medianMs: 92000 },
  { rating: 1550, medianMs: 60000 },
  { rating: 1650, medianMs: 38000 },
  { rating: 1750, medianMs: 26000 },
  { rating: 1850, medianMs: 14000 },
  { rating: 1950, medianMs: 10200 },
  { rating: 2100, medianMs: 7400 },
  { rating: 2250, medianMs: 4900 },
  { rating: 2450, medianMs: 3600 },
];
const AIGA_CURVE = CEE_RANKED_AIGA_THINK_CURVE;
const AIGA_SIGMA = 0.2;

/** 爱噶能达到的实战分范围：想要的分数超出时只能夹到两端。 */
export const CEE_RANKED_AIGA_RATING_RANGE = {
  min: AIGA_CURVE[0].rating,
  max: AIGA_CURVE[AIGA_CURVE.length - 1].rating,
} as const;

/** 爱噶的思考时长：只看她的节奏分。 */
export function ceeRankedAigaThinkMs(paceRating: number, random: () => number): number {
  const bounded = clamp(
    paceRating,
    CEE_RANKED_AIGA_RATING_RANGE.min,
    CEE_RANKED_AIGA_RATING_RANGE.max
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
  if (brain.persona.id === "aiga") return ceeRankedAigaThinkMs(brain.paceRating, random);
  const phase = candidatesLeft <= 3 ? 0.6 : 1;
  const sigma = brain.strength.thinkSigma + (brain.persona.tempo === "erratic" ? 0.3 : 0);
  const base = brain.step === 0 ? brain.strength.firstGuessMedianMs : brain.strength.thinkMedianMs;
  const median =
    base * brain.persona.thinkFactor * phase * tempoFactor(brain.persona.tempo, brain.step);
  const value = median * Math.exp(sigma * gaussian(random));
  const idle = random() < brain.persona.idleRate ? 10000 + random() * 10000 : 0;
  return clamp(Math.round(value + idle), THINK_FLOOR_MS, THINK_CEILING_MS);
}
