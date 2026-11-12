import type { CEERankedGameSummary } from "@bakagame/shared";

/** 赢下的局数。旧规则（平局各得半分）留下的历史记录可能带半分：1.5 写作「1½」，0.5 写作「½」。 */
export const formatRankedPoints = (points: number): string => {
  const whole = Math.floor(points);
  if (points - whole < 0.5) return String(whole);
  return whole === 0 ? "½" : `${whole}½`;
};

/** 剩余整秒 → `m:ss`。 */
export const formatRankedClock = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/** 一局结束后的读法：谁先猜中，或者双方都没猜中。 */
export function rankedGameHeadline(game: CEERankedGameSummary): string {
  const prefix = `第 ${game.number} 局 · `;
  if (game.winner === null) return `${prefix}双方都没猜中，这局不算`;
  const reason =
    game.reason === "surrender"
      ? game.winner === "self"
        ? "对手认输"
        : "你认输了"
      : game.winner === "self"
        ? "你先猜中了"
        : "对手先猜中了";
  return prefix + reason;
}

/** 排位分变化的读法：正数带加号，零写 ±0，负数用数学减号（与战绩列表同一写法）。 */
export const formatRankedDelta = (delta: number): string =>
  delta > 0 ? `+${delta}` : delta === 0 ? "±0" : `−${Math.abs(delta)}`;

/** 胜率取整百分比；没有对局时为 null（调用方显示「—」或不显示）。 */
export const rankedWinRate = (wins: number, losses: number, draws = 0): number | null => {
  const total = wins + losses + draws;
  return total ? Math.round((wins / total) * 100) : null;
};

/** 战绩的可访问名：胜负数，有对局时带胜率。 */
export const rankedRecordLabel = (wins: number, losses: number, rate: number | null): string =>
  `${wins} 胜 ${losses} 负${rate === null ? "" : `，胜率 ${rate}%`}`;
