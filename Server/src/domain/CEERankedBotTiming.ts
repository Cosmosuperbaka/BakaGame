import type { CEERankedBotBrain } from "./CEERankedBot";
import { clamp, type CEERankedTempo } from "./CEERankedBotProfile";

// 排位人机的思考时长：普通人格按强度档与节奏，爱噶只看对手分数。

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
