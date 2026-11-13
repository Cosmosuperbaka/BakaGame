// ==================== 排位结算的纯计算 ====================
// 从系列赛运行时算出新评级、审计记录与结果页元数据：只读运行时、不持有状态、不碰时钟。
import {
  CEE_RANKED_BOT_DAILY_RATED,
  CEE_RANKED_PLACEMENT_SERIES,
  CEE_RANKED_RULESET,
} from "../shared/CEERanked";
import { beijingDay } from "../domain/BeijingDay";
import type { CEERankedSeatIndex } from "../domain/CEERankedGame";
import {
  createCEERating,
  displayCEERating,
  rateCEEBotSeries,
  rateCEESeries,
  type CEERating,
} from "../domain/CEERankedRating";
import type { CEERankedSeriesRuntime } from "./CEERankedRuntime";
import type {
  CEERankedGameRecord,
  CEERankedGuessRecord,
  CEERankedRatingRecord,
  CEERankedSeriesPlayerRecord,
  CEERankedSeriesRecord,
} from "./CEERankedStore";
import type { CEERankedSeatResultMeta } from "./CEERankedViews";

/** 审计表里的角色名：中文名优先，没有中文名的旧数据回落到原名。 */
export function auditNameOf(character: { name: string; nameCn: string }): string {
  return character.nameCn || character.name;
}

/** 从审计记录取回评级三参数。 */
export function toRating(record: CEERankedRatingRecord): CEERating {
  return { rating: record.rating, rd: record.rd, lastPlayedAt: record.lastPlayedAt };
}

/** 没有评级记录时的初值：与 `createCEERating` 同一口径。 */
export function initialRatingRecord(userId: string): CEERankedRatingRecord {
  const base = createCEERating();
  return {
    userId,
    rating: base.rating,
    rd: base.rd,
    seriesPlayed: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    botRatedDay: null,
    botRatedCount: 0,
    lastPlayedAt: base.lastPlayedAt,
  };
}

/** 人机系列赛是否计分：定级中恒计分，已定级看当日额度。 */
export function shouldRateBotSeries(record: CEERankedRatingRecord, now: number): boolean {
  if (record.seriesPlayed < CEE_RANKED_PLACEMENT_SERIES) return true;
  if (record.botRatedDay !== beijingDay(now)) return true;
  return record.botRatedCount < CEE_RANKED_BOT_DAILY_RATED;
}

/** 结算后的评级行：计分才换 μ/φ，场数与胜平负无论计分与否都进账。 */
export function nextRatingRecord(
  prior: CEERankedRatingRecord,
  after: CEERating,
  score: 0 | 0.5 | 1,
  runtime: CEERankedSeriesRuntime,
  endedAt: number
): CEERankedRatingRecord {
  const rated = runtime.rated;
  const today = beijingDay(endedAt);
  const usesDailyQuota = runtime.bot && rated && prior.seriesPlayed >= CEE_RANKED_PLACEMENT_SERIES;
  return {
    userId: prior.userId,
    rating: rated ? after.rating : prior.rating,
    rd: rated ? after.rd : prior.rd,
    seriesPlayed: prior.seriesPlayed + 1,
    wins: prior.wins + (score === 1 ? 1 : 0),
    losses: prior.losses + (score === 0 ? 1 : 0),
    draws: prior.draws + (score === 0.5 ? 1 : 0),
    botRatedDay: usesDailyQuota ? today : prior.botRatedDay,
    botRatedCount: usesDailyQuota
      ? prior.botRatedDay === today
        ? prior.botRatedCount + 1
        : 1
      : prior.botRatedCount,
    lastPlayedAt: rated ? after.lastPlayedAt : prior.lastPlayedAt,
  };
}

/** 赛前与赛后的评级：不计分时原样带回，人机按固定最大不确定度结算。 */
export function resolveRatings(
  runtime: CEERankedSeriesRuntime,
  scores: [0 | 0.5 | 1, 0 | 0.5 | 1],
  endedAt: number
): { before: [CEERating, CEERating]; after: [CEERating, CEERating] } {
  const before: [CEERating, CEERating] = [
    runtime.seats[0].prior ? toRating(runtime.seats[0].prior) : createCEERating(),
    runtime.seats[1].prior ? toRating(runtime.seats[1].prior) : createCEERating(),
  ];
  const after: [CEERating, CEERating] = [before[0], before[1]];
  if (!runtime.rated) return { before, after };
  const spec = runtime.botSpec;
  if (spec === null) {
    const pair = rateCEESeries(before[0], before[1], scores[0], endedAt);
    after[0] = pair[0];
    after[1] = pair[1];
  } else {
    // 人机一律按最大不确定度参与计算：它的真实强度只知道「围绕目标分」。
    after[0] = rateCEEBotSeries(before[0], spec.targetRating, scores[0], endedAt);
  }
  return { before, after };
}

/** 需要写回的真人评级行：人机席位没有评级，跳过。 */
export function seatRatingRecords(
  runtime: CEERankedSeriesRuntime,
  after: [CEERating, CEERating],
  scores: [0 | 0.5 | 1, 0 | 0.5 | 1],
  endedAt: number
): CEERankedRatingRecord[] {
  const rows: CEERankedRatingRecord[] = [];
  for (const index of [0, 1] as const) {
    const prior = runtime.seats[index].prior;
    if (prior === null) continue;
    rows.push(nextRatingRecord(prior, after[index], scores[index], runtime, endedAt));
  }
  return rows;
}

/** 结果页要展示的赛前/赛后展示分：定级中不显示分数，不计分也不显示。 */
export function settlementResults(
  runtime: CEERankedSeriesRuntime,
  rating: { before: [CEERating, CEERating]; after: [CEERating, CEERating] }
): [CEERankedSeatResultMeta | null, CEERankedSeatResultMeta | null] {
  const results: [CEERankedSeatResultMeta | null, CEERankedSeatResultMeta | null] = [null, null];
  for (const index of [0, 1] as const) {
    const prior = runtime.seats[index].prior;
    if (prior === null) continue;
    const playedAfter = prior.seriesPlayed + 1;
    const placed = prior.seriesPlayed >= CEE_RANKED_PLACEMENT_SERIES;
    results[index] = {
      ratingBefore: runtime.rated && placed ? displayCEERating(rating.before[index]) : null,
      ratingAfter:
        runtime.rated && playedAfter >= CEE_RANKED_PLACEMENT_SERIES
          ? displayCEERating(rating.after[index])
          : null,
      placementPlayed: placed ? null : playedAfter,
    };
  }
  return results;
}

export function seriesRecord(runtime: CEERankedSeriesRuntime, endedAt: number): CEERankedSeriesRecord {
  const series = runtime.series;
  return {
    id: series.id,
    ruleset: CEE_RANKED_RULESET,
    tier: series.tier,
    answerIds: series.answers.map((answer) => answer.id),
    startedAt: series.createdAt,
    endedAt: series.endedAt ?? endedAt,
    endReason: series.endReason ?? "completed",
    rated: runtime.rated,
    unratedReason: runtime.unratedReason,
    bot: runtime.bot,
    botEntry: runtime.botEntry,
  };
}

export function playerRecord(
  runtime: CEERankedSeriesRuntime,
  index: CEERankedSeatIndex,
  score: 0 | 0.5 | 1,
  before: CEERating,
  after: CEERating
): CEERankedSeriesPlayerRecord {
  const seat = runtime.seats[index];
  const prior = seat.prior;
  const rated = runtime.rated;
  const spec = seat.isBot ? runtime.botSpec : null;
  return {
    seat: index,
    userId: seat.userId,
    name: seat.name,
    clientType: seat.isBot ? null : seat.clientType,
    clientVersion: seat.isBot ? null : seat.clientVersion,
    botPersona: spec === null ? null : spec.persona.id,
    botTargetRating: spec === null ? null : spec.targetRating,
    botStrengthRating: spec === null ? null : spec.strengthRating,
    queueWaitMs: seat.queueWaitMs,
    points: runtime.series.seats[index].points,
    score,
    placement: prior !== null && prior.seriesPlayed < CEE_RANKED_PLACEMENT_SERIES,
    ratingBefore: prior === null ? null : before.rating,
    ratingAfter: prior === null ? null : rated ? after.rating : before.rating,
    rdBefore: prior === null ? null : before.rd,
    rdAfter: prior === null ? null : rated ? after.rd : before.rd,
  };
}

export function gameRecords(runtime: CEERankedSeriesRuntime, endedAt: number): CEERankedGameRecord[] {
  return runtime.series.games.map((game): CEERankedGameRecord => ({
    number: game.number,
    answerCharacterId: game.answer.id,
    answerName: auditNameOf(game.answer),
    winnerSeat: game.winner,
    endReason: game.endReason ?? "draw",
    attempts: [game.seats[0].attempts, game.seats[1].attempts],
    overtime: game.overtime,
    startedAt: game.startsAt,
    endedAt: game.endedAt ?? endedAt,
  }));
}

export function guessRecords(runtime: CEERankedSeriesRuntime): CEERankedGuessRecord[] {
  const rows: CEERankedGuessRecord[] = [];
  for (const game of runtime.series.games) {
    for (const index of [0, 1] as const) {
      const seat = runtime.seats[index];
      game.seats[index].guesses.forEach((guess, position) => {
        const ledger = seat.isBot ? undefined : runtime.guessLedger.get(guess.id);
        rows.push({
          gameNumber: game.number,
          seat: index,
          attempt: position + 1,
          characterId: guess.character.id,
          characterName: auditNameOf(guess.character),
          correct: guess.correct,
          createdAt: guess.createdAt,
          clientType: seat.isBot ? null : seat.clientType,
          searchedAt: ledger?.searchedAt ?? null,
          searchMatched: ledger?.searchMatched ?? null,
        });
      });
    }
  }
  return rows;
}
