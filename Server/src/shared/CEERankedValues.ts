// ==================== 排位赛纯值（规则常量与难度档） ====================
// 客户端经 `@bakagame/shared/values` 取值时不能带上 TypeBox，所以与命令 schema 分开放；
// 对 ./CEE 只用 import type。
import { createDefaultCEESettings } from "./CEEDefaults";
import type { CEESettings } from "./CEE";

/** 排位规则版本：写进对局记录；下面任何规则或难度档变化都要换新版本号。 */
export const CEE_RANKED_RULESET = "r1";
/** 三局两胜：先到 2 分者赢下系列赛（胜 1 分、平各 0.5 分），最多 3 局。 */
export const CEE_RANKED_SERIES_GAMES = 3;
export const CEE_RANKED_SERIES_WIN_POINTS = 2;
/** 每局开始前的读秒。 */
export const CEE_RANKED_COUNTDOWN_MS = 5_000;
/** 每局常规时段。 */
export const CEE_RANKED_GAME_MS = 180_000;
export const CEE_RANKED_OVERTIME_MS = 45_000;
/** 骤死加时每方追加的次数。 */
export const CEE_RANKED_OVERTIME_ATTEMPTS = 2;
/** 局间展示上一局结果的时长。 */
export const CEE_RANKED_INTERMISSION_MS = 10_000;
/** 连续离线超过该时长整场判负。 */
export const CEE_RANKED_OFFLINE_FORFEIT_MS = 90_000;
/** 定级赛场数：打满前不显示分数。 */
export const CEE_RANKED_PLACEMENT_SERIES = 5;
/** 排队满该时长可主动进人机局（不点则继续排队）。 */
export const CEE_RANKED_BOT_OPTION_MS = 10_000;
/** 排队满该时长仍未匹配到真人，自动进人机局。 */
export const CEE_RANKED_BOT_FALLBACK_MS = 30_000;
/** 定级结束后每个北京日计分的人机系列赛场数。 */
export const CEE_RANKED_BOT_DAILY_RATED = 5;

export type CEERankedTierId = "d1" | "d2" | "d3" | "d4" | "d5";
export interface CEERankedTier {
  id: CEERankedTierId;
  name: string;
  /** 进入该档所需的保守分（分数 − 偏差）下限。 */
  minRating: number;
  /** 题库年代跨度：startYear = 当前年 − yearSpan。 */
  yearSpan: number;
  topNSubjects: number;
}
export const CEE_RANKED_TIERS: readonly CEERankedTier[] = [
  { id: "d1", name: "入门", minRating: Number.NEGATIVE_INFINITY, yearSpan: 5, topNSubjects: 20 },
  { id: "d2", name: "进阶", minRating: 1250, yearSpan: 5, topNSubjects: 50 },
  { id: "d3", name: "资深", minRating: 1500, yearSpan: 5, topNSubjects: 100 },
  { id: "d4", name: "大师", minRating: 1750, yearSpan: 10, topNSubjects: 150 },
  { id: "d5", name: "传说", minRating: 2000, yearSpan: 15, topNSubjects: 200 },
];
/** 取 minRating 不超过保守分的最高一档。 */
export function ceeRankedTierFor(conservativeRating: number): CEERankedTier {
  let selected = CEE_RANKED_TIERS[0];
  for (const tier of CEE_RANKED_TIERS) if (conservativeRating >= tier.minRating) selected = tier;
  return selected;
}
export function ceeRankedTier(id: CEERankedTierId): CEERankedTier {
  return CEE_RANKED_TIERS.find((tier) => tier.id === id) ?? CEE_RANKED_TIERS[0];
}
/** 该档的固定玩法设置：在多人默认设置上收紧，不接受玩家修改。 */
export function createCEERankedSettings(
  tier: CEERankedTier,
  year = new Date().getFullYear()
): CEESettings {
  return {
    ...createDefaultCEESettings(year),
    startYear: year - tier.yearSpan,
    endYear: year,
    topNSubjects: tier.topNSubjects,
    useSubjectPerYear: false,
    mainCharacterOnly: true,
    maxAttempts: 10,
    timeLimit: 0,
    subjectSearch: true,
    subjectTagNum: 4,
    characterTagNum: 4,
    useHints: [],
    useImageHint: 0,
    globalPick: false,
    tagBan: false,
    syncMode: false,
    nonstopMode: false,
    answerMode: "random",
    bakaAntiCheat: false,
    allowAgents: false,
  };
}
