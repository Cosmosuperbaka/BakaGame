// ==================== 排位赛视图 ====================
import type { CEEGuess } from "../shared/CEE";
import {
  ceeRankedTier,
  type CEERankedGameView,
  type CEERankedGameSummary,
  type CEERankedMaskedGuess,
  type CEERankedOutcome,
  type CEERankedSeatView,
  type CEERankedSeriesResult,
  type CEERankedSeriesView,
  type CEERankedSettlement,
} from "../shared/CEERanked";
import {
  ceeRankedGameSeatFinished,
  maskCEEFeedback,
  type CEERankedGame,
  type CEERankedSeatIndex,
} from "../domain/CEERankedGame";
import {
  ceeRankedSeriesPhase,
  ceeRankedSeriesScore,
  type CEERankedSeries,
} from "../domain/CEERankedSeries";

export interface CEERankedSeatMeta {
  /** 展示分；人机或定级中传 null。 */
  rating: number | null;
  placementPlayed: number | null;
  online: boolean;
}
export interface CEERankedSeatResultMeta {
  ratingBefore: number | null;
  ratingAfter: number | null;
  placementPlayed: number | null;
}
export interface CEERankedViewMeta {
  seats: [CEERankedSeatMeta, CEERankedSeatMeta];
  rated: boolean;
  settlement: CEERankedSettlement;
  /** 结算写库完成后才有，未完成传 [null, null]。 */
  results: [CEERankedSeatResultMeta | null, CEERankedSeatResultMeta | null];
}

const oppositeSeat = (seat: CEERankedSeatIndex): CEERankedSeatIndex => (seat === 0 ? 1 : 0);

/** 对方猜测只留符号与计数：数值、角色、作品与标签文字一概不下发。 */
function maskedGuesses(guesses: CEEGuess[]): CEERankedMaskedGuess[] {
  return guesses.map((guess, index) => ({
    index: index + 1,
    correct: guess.correct,
    createdAt: guess.createdAt,
    feedback: maskCEEFeedback(guess.feedback),
  }));
}

function gameView(game: CEERankedGame, seat: CEERankedSeatIndex): CEERankedGameView {
  return {
    number: game.number,
    phase: game.phase,
    startsAt: game.startsAt,
    deadlineAt: game.deadlineAt,
    guesses: game.seats[seat].guesses,
    opponentGuesses: maskedGuesses(game.seats[oppositeSeat(seat)].guesses),
    hints: game.hints,
  };
}

function gameSummary(game: CEERankedGame, seat: CEERankedSeatIndex): CEERankedGameSummary {
  return {
    number: game.number,
    answer: game.answer,
    winner: game.winner === null ? null : game.winner === seat ? "self" : "opponent",
    // 进入 games 的局必已结算并带结束原因，兜底只为收窄类型。
    reason: game.endReason ?? "draw",
    overtime: game.overtime,
    guesses: game.seats[seat].guesses,
    opponentGuesses: game.seats[oppositeSeat(seat)].guesses,
  };
}

function seatView(
  series: CEERankedSeries,
  index: CEERankedSeatIndex,
  meta: CEERankedViewMeta,
  reference: CEERankedGame | undefined
): CEERankedSeatView {
  const seat = series.seats[index];
  const seatMeta = meta.seats[index];
  const gameSeat = reference?.seats[index];
  return {
    name: seat.name,
    isBot: seat.isBot,
    rating: seat.isBot ? null : seatMeta.rating,
    placementPlayed: seat.isBot ? null : seatMeta.placementPlayed,
    points: seat.points,
    attempts: gameSeat?.attempts ?? 0,
    allowance: gameSeat?.allowance ?? 0,
    finished: gameSeat ? ceeRankedGameSeatFinished(gameSeat) : false,
    online: seatMeta.online,
  };
}

function seriesResult(
  series: CEERankedSeries,
  seat: CEERankedSeatIndex,
  meta: CEERankedViewMeta
): CEERankedSeriesResult | null {
  if (!series.endReason) return null;
  const score = ceeRankedSeriesScore(series, seat);
  const outcome: CEERankedOutcome = score === 1 ? "won" : score === 0.5 ? "drawn" : "lost";
  const settled = meta.results[seat];
  return {
    outcome,
    reason: series.endReason,
    settlement: meta.settlement,
    ratingBefore: settled?.ratingBefore ?? null,
    ratingAfter: settled?.ratingAfter ?? null,
    placementPlayed: settled?.placementPlayed ?? null,
  };
}

export function ceeRankedSeriesView(
  series: CEERankedSeries,
  seat: CEERankedSeatIndex,
  meta: CEERankedViewMeta
): CEERankedSeriesView {
  const phase = ceeRankedSeriesPhase(series);
  // 局间与结算后的次数字段取最后一局；第 1 局之前不存在两者皆无的状态。
  const reference = series.current ?? series.games.at(-1);
  const opponent = oppositeSeat(seat);
  const tier = ceeRankedTier(series.tier);
  return {
    seriesId: series.id,
    tier: { id: tier.id, name: tier.name },
    phase,
    rated: meta.rated,
    self: seatView(series, seat, meta, reference),
    opponent: seatView(series, opponent, meta, reference),
    game: series.current ? gameView(series.current, seat) : null,
    nextGameAt: phase === "intermission" ? series.nextGameAt : null,
    games: series.games.map((game) => gameSummary(game, seat)),
    result: seriesResult(series, seat, meta),
  };
}
