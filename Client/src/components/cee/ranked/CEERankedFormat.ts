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
