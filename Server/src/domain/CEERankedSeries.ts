// ==================== 排位 Bo3 系列赛状态机（纯领域） ====================
import type { CEECharacterView, CEEGuess, CEESettings } from "../shared/CEE";
import {
  CEE_RANKED_INTERMISSION_MS,
  CEE_RANKED_OFFLINE_FORFEIT_MS,
  CEE_RANKED_SERIES_GAMES,
  CEE_RANKED_SERIES_WIN_POINTS,
  type CEERankedSeriesEndReason,
  type CEERankedSeriesPhase,
  type CEERankedTierId,
} from "../shared/CEERanked";
import { AppError } from "./Errors";
import {
  applyCEERankedGuess,
  createCEERankedGame,
  ceeRankedOvertimeHint,
  surrenderCEERankedGame,
  tickCEERankedGame,
  type CEERankedGame,
  type CEERankedSeatIndex,
} from "./CEERankedGame";

export interface CEERankedSeriesSeat {
  /** 人机为 null。 */
  userId: string | null;
  name: string;
  isBot: boolean;
  points: number;
  /** 开始连续离线的时刻；在线为 null。人机恒为 null。 */
  offlineSince: number | null;
}
export interface CEERankedSeries {
  id: string;
  tier: CEERankedTierId;
  settings: CEESettings;
  /** 开赛前抽好的三道题，互不相同。 */
  answers: [CEECharacterView, CEECharacterView, CEECharacterView];
  /** 与 answers 一一对应的加时提示。 */
  overtimeHints: [string, string, string];
  seats: [CEERankedSeriesSeat, CEERankedSeriesSeat];
  /** 已结束的局。 */
  games: CEERankedGame[];
  /** 进行中的局；局间与结算后为 null。 */
  current: CEERankedGame | null;
  phase: CEERankedSeriesPhase;
  nextGameAt: number | null;
  createdAt: number;
  winner: CEERankedSeatIndex | null;
  endReason: CEERankedSeriesEndReason | null;
  endedAt: number | null;
}

const otherSeriesSeat = (seat: CEERankedSeatIndex): CEERankedSeatIndex => (seat === 0 ? 1 : 0);

export function createCEERankedSeries(input: {
  id: string;
  tier: CEERankedTierId;
  settings: CEESettings;
  answers: [CEECharacterView, CEECharacterView, CEECharacterView];
  seats: [
    Omit<CEERankedSeriesSeat, "points" | "offlineSince">,
    Omit<CEERankedSeriesSeat, "points" | "offlineSince">,
  ];
  now: number;
  random: () => number;
}): CEERankedSeries {
  if (new Set(input.answers.map((answer) => answer.id)).size !== input.answers.length)
    throw new AppError("RANKED_INVALID_ANSWERS", "系列赛题目必须互不相同");
  const overtimeHints = input.answers.map((answer) =>
    ceeRankedOvertimeHint(answer, input.random)
  ) as [string, string, string];
  const seats: [CEERankedSeriesSeat, CEERankedSeriesSeat] = [
    { ...input.seats[0], points: 0, offlineSince: null },
    { ...input.seats[1], points: 0, offlineSince: null },
  ];
  const current = createCEERankedGame({
    number: 1,
    settings: input.settings,
    answer: input.answers[0],
    names: [seats[0].name, seats[1].name],
    overtimeHint: overtimeHints[0],
    now: input.now,
  });
  return {
    id: input.id,
    tier: input.tier,
    settings: input.settings,
    answers: input.answers,
    overtimeHints,
    seats,
    games: [],
    current,
    phase: current.phase,
    nextGameAt: null,
    createdAt: input.now,
    winner: null,
    endReason: null,
    endedAt: null,
  };
}

/** 系列赛的阶段（随当前局或局间/结算变化）。 */
export function ceeRankedSeriesPhase(series: CEERankedSeries): CEERankedSeriesPhase {
  if (series.current) return series.current.phase;
  if (series.endReason) return "settled";
  return "intermission";
}

/** 给已结算的当前局记分并移入 games；不改动系列赛阶段。 */
function archiveCurrentGame(series: CEERankedSeries): void {
  const game = series.current;
  if (!game) return;
  if (game.winner === null) {
    series.seats[0].points += 0.5;
    series.seats[1].points += 0.5;
  } else {
    series.seats[game.winner].points += 1;
  }
  series.games.push(game);
  series.current = null;
}

function settleSeries(
  series: CEERankedSeries,
  winner: CEERankedSeatIndex | null,
  reason: CEERankedSeriesEndReason,
  now: number
): void {
  series.winner = winner;
  series.endReason = reason;
  series.phase = "settled";
  series.current = null;
  series.nextGameAt = null;
  series.endedAt = now;
}

function startNextGame(series: CEERankedSeries, now: number): void {
  const index = series.games.length;
  series.current = createCEERankedGame({
    number: index + 1,
    settings: series.settings,
    answer: series.answers[index],
    names: [series.seats[0].name, series.seats[1].name],
    overtimeHint: series.overtimeHints[index],
    now,
  });
  series.nextGameAt = null;
  series.phase = series.current.phase;
}

/** 离场结算：有进行中的局先按退出方认输关闭，再整场判给对方。 */
function finishByLeaving(
  series: CEERankedSeries,
  seat: CEERankedSeatIndex,
  reason: CEERankedSeriesEndReason,
  now: number
): void {
  if (series.current) {
    if (series.current.phase !== "settled") surrenderCEERankedGame(series.current, seat, now);
    archiveCurrentGame(series);
  }
  settleSeries(series, otherSeriesSeat(seat), reason, now);
}

/** 推进时间驱动的变化（离线判负、局结算、局间开局）；有变化返回 true。 */
export function tickCEERankedSeries(series: CEERankedSeries, now: number): boolean {
  if (series.phase === "settled") return false;
  for (const seat of [0, 1] as const) {
    const target = series.seats[seat];
    if (
      !target.isBot &&
      target.offlineSince !== null &&
      now - target.offlineSince >= CEE_RANKED_OFFLINE_FORFEIT_MS
    ) {
      finishByLeaving(series, seat, "offline", now);
      return true;
    }
  }
  const current = series.current;
  if (current) {
    const changed = tickCEERankedGame(current, now);
    if (current.phase !== "settled") {
      series.phase = current.phase;
      return changed;
    }
    archiveCurrentGame(series);
    const [left, right] = series.seats;
    if (
      left.points >= CEE_RANKED_SERIES_WIN_POINTS ||
      right.points >= CEE_RANKED_SERIES_WIN_POINTS ||
      series.games.length >= CEE_RANKED_SERIES_GAMES
    ) {
      settleSeries(
        series,
        left.points > right.points ? 0 : right.points > left.points ? 1 : null,
        "completed",
        now
      );
    } else {
      series.phase = "intermission";
      series.nextGameAt = now + CEE_RANKED_INTERMISSION_MS;
    }
    return true;
  }
  if (series.phase === "intermission" && series.nextGameAt !== null && now >= series.nextGameAt) {
    startNextGame(series, now);
    return true;
  }
  return false;
}

export function applyCEERankedSeriesGuess(
  series: CEERankedSeries,
  seat: CEERankedSeatIndex,
  character: CEECharacterView,
  now: number
): CEEGuess {
  tickCEERankedSeries(series, now);
  if (!series.current) throw new AppError("INVALID_PHASE", "当前不能猜测");
  const guess = applyCEERankedGuess(series.current, seat, character, now);
  // 猜中即结算当前局，立刻记分并推进系列赛，不等下一次 tick。
  tickCEERankedSeries(series, now);
  return guess;
}

/** 认输当前局。 */
export function surrenderCEERankedSeriesGame(
  series: CEERankedSeries,
  seat: CEERankedSeatIndex,
  now: number
): void {
  tickCEERankedSeries(series, now);
  if (!series.current) throw new AppError("INVALID_PHASE", "当前没有进行中的局");
  surrenderCEERankedGame(series.current, seat, now);
  tickCEERankedSeries(series, now);
}

/** 退出整场，判负。 */
export function exitCEERankedSeries(
  series: CEERankedSeries,
  seat: CEERankedSeatIndex,
  now: number
): void {
  if (series.phase === "settled") throw new AppError("INVALID_PHASE", "本场已经结束");
  finishByLeaving(series, seat, "exit", now);
}

export function setCEERankedSeatOnline(
  series: CEERankedSeries,
  seat: CEERankedSeatIndex,
  online: boolean,
  now: number
): void {
  const target = series.seats[seat];
  if (target.isBot) return;
  if (online) {
    target.offlineSince = null;
    return;
  }
  // 重复下线不刷新时刻，离线时长才能连续累计到判负阈值。
  if (target.offlineSince === null) target.offlineSince = now;
}

/** 系列赛得分：胜 1、平 0.5、负 0；未结算抛错。 */
export function ceeRankedSeriesScore(
  series: CEERankedSeries,
  seat: CEERankedSeatIndex
): 0 | 0.5 | 1 {
  if (!series.endReason) throw new AppError("INVALID_PHASE", "本场尚未结束");
  if (series.winner === seat) return 1;
  if (series.winner === null) return 0.5;
  return 0;
}
