// ==================== 排位赛季登记 ====================
// 赛季是排位准入的时间窗：窗外拒绝新开（排队与打人机），窗内开出的系列赛照常打完、照常结算。
// 加新赛季只需在列表里追加一项。本模块零依赖，客户端经 @bakagame/shared/values 引用同一份登记。

export interface CEERankedSeason {
  id: string;
  /** 开始时刻（含），ISO 字符串，带 +08:00。 */
  startsAt: string;
  /** 结束时刻（不含，开区间），ISO 字符串，带 +08:00。 */
  endsAt: string;
}

export const CEE_RANKED_SEASONS: readonly CEERankedSeason[] = [
  // S1 的开始时刻先按拟定上线日写，发布时校正为实际上线日。
  { id: "S1", startsAt: "2026-11-19T00:00:00+08:00", endsAt: "2027-01-01T00:00:00+08:00" },
];

/** 某时刻进行中的赛季；不在任何赛季窗口内为 null。 */
export function currentCEERankedSeason(
  at: number,
  seasons: readonly CEERankedSeason[] = CEE_RANKED_SEASONS
): CEERankedSeason | null {
  return (
    seasons.find((season) => Date.parse(season.startsAt) <= at && at < Date.parse(season.endsAt)) ??
    null
  );
}

/** 下一个尚未开始的赛季（按开始时刻取最早）；没有则 null。 */
export function nextCEERankedSeason(
  at: number,
  seasons: readonly CEERankedSeason[] = CEE_RANKED_SEASONS
): CEERankedSeason | null {
  let best: CEERankedSeason | null = null;
  for (const season of seasons) {
    const start = Date.parse(season.startsAt);
    if (start <= at) continue;
    if (best === null || start < Date.parse(best.startsAt)) best = season;
  }
  return best;
}
