// ==================== 排位评分（Glicko 两参数） ====================

export interface CEERating {
  rating: number;
  rd: number;
  /** 上一场系列赛结算时刻（毫秒）；从未对局为 null。 */
  lastPlayedAt: number | null;
}
export interface CEERatingOpponent {
  rating: number;
  rd: number;
}
export type CEESeriesScore = 0 | 0.5 | 1;

export const CEE_RANKED_INITIAL_RATING = 1500;
export const CEE_RANKED_INITIAL_RD = 350;
export const CEE_RANKED_RD_MIN = 50;
export const CEE_RANKED_RD_MAX = 350;
/** 每过一天偏差按 √(φ² + c²) 回涨的 c。 */
export const CEE_RANKED_RD_GROWTH = 12.8;
export const CEE_RANKED_RATING_PERIOD_MS = 86_400_000;
/** Bo3 胜率约等于单局胜率在分差上放大 1.5 倍。 */
export const CEE_RANKED_SERIES_SCALE = 1.5;
/** 人机以最大不确定度参与计算。 */
export const CEE_RANKED_BOT_RD = 350;

/** Glicko 原尺度的 q = ln10 / 400。 */
const Q = Math.LN10 / 400;

const SCORE_COMPLEMENT: Record<CEESeriesScore, CEESeriesScore> = { 0: 1, 0.5: 0.5, 1: 0 };

function clampRd(rd: number): number {
  return Math.min(CEE_RANKED_RD_MAX, Math.max(CEE_RANKED_RD_MIN, rd));
}
/** 对手不确定度对本次结算的折扣：φ 越大影响越小。 */
function deviationWeight(rd: number): number {
  return 1 / Math.sqrt(1 + (3 * Q * Q * rd * rd) / (Math.PI * Math.PI));
}

export function createCEERating(): CEERating {
  return { rating: CEE_RANKED_INITIAL_RATING, rd: CEE_RANKED_INITIAL_RD, lastPlayedAt: null };
}
export function inflateCEERatingDeviation(rating: CEERating, now: number): CEERating {
  if (rating.lastPlayedAt === null || now <= rating.lastPlayedAt) return { ...rating };
  const periods = (now - rating.lastPlayedAt) / CEE_RANKED_RATING_PERIOD_MS;
  const rd = Math.sqrt(
    rating.rd * rating.rd + CEE_RANKED_RD_GROWTH * CEE_RANKED_RD_GROWTH * periods
  );
  return { ...rating, rd: Math.min(rd, CEE_RANKED_RD_MAX) };
}
export function expectedCEESeriesScore(
  player: CEERatingOpponent,
  opponent: CEERatingOpponent,
  scale: number = CEE_RANKED_SERIES_SCALE
): number {
  return (
    1 /
    (1 + Math.exp(-scale * Q * deviationWeight(opponent.rd) * (player.rating - opponent.rating)))
  );
}
/** 一个评级期的批量更新：所有期望得分都按更新前的 μ 计算，只做 rd 夹取不回涨。 */
export function updateCEERatingPeriod(
  player: CEERatingOpponent,
  results: ReadonlyArray<{ opponent: CEERatingOpponent; score: CEESeriesScore }>,
  scale: number = CEE_RANKED_SERIES_SCALE
): CEERatingOpponent {
  if (results.length === 0) return { ...player };
  const variance = player.rd * player.rd;
  let precision = 0;
  let delta = 0;
  for (const { opponent, score } of results) {
    const weight = deviationWeight(opponent.rd);
    const expected = expectedCEESeriesScore(player, opponent, scale);
    precision += scale * scale * Q * Q * weight * weight * expected * (1 - expected);
    delta += scale * Q * weight * (score - expected);
  }
  const nextVariance = 1 / (1 / variance + precision);
  return { rating: player.rating + nextVariance * delta, rd: clampRd(Math.sqrt(nextVariance)) };
}
/** 真人对真人：双方都用对方膨胀后的偏差，B 的得分是 A 的补。 */
export function rateCEESeries(
  a: CEERating,
  b: CEERating,
  scoreA: CEESeriesScore,
  now: number
): [CEERating, CEERating] {
  const inflatedA = inflateCEERatingDeviation(a, now);
  const inflatedB = inflateCEERatingDeviation(b, now);
  const nextA = updateCEERatingPeriod(inflatedA, [
    { opponent: { rating: inflatedB.rating, rd: inflatedB.rd }, score: scoreA },
  ]);
  const nextB = updateCEERatingPeriod(inflatedB, [
    {
      opponent: { rating: inflatedA.rating, rd: inflatedA.rd },
      score: SCORE_COMPLEMENT[scoreA],
    },
  ]);
  return [
    { ...nextA, lastPlayedAt: now },
    { ...nextB, lastPlayedAt: now },
  ];
}
export function rateCEEBotSeries(
  player: CEERating,
  botRating: number,
  score: CEESeriesScore,
  now: number
): CEERating {
  const inflated = inflateCEERatingDeviation(player, now);
  const next = updateCEERatingPeriod(inflated, [
    { opponent: { rating: botRating, rd: CEE_RANKED_BOT_RD }, score },
  ]);
  return { ...next, lastPlayedAt: now };
}
/** 定档用保守分：把久未对局的衰减先算进来，再按不确定性打折。 */
export function conservativeCEERating(rating: CEERating, now: number): number {
  const inflated = inflateCEERatingDeviation(rating, now);
  return inflated.rating - inflated.rd;
}
export function displayCEERating(rating: Pick<CEERating, "rating">): number {
  return Math.round(rating.rating);
}
