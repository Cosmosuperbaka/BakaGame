// ==================== 排位资料、战绩与排行榜查询 ====================
// 只读仓储：个人资料、战绩翻页、全服排行榜。榜单头部缓存是这里唯一的状态，结算写库成功时由结算方作废。
import type {
  CEERankedHistoryEntry,
  CEERankedHistoryPage,
  CEERankedLeaderboard,
  CEERankedOutcome,
  CEERankedProfile,
  CEERankedTierId,
} from "../shared/CEERanked";
import { CEE_RANKED_BOT_DAILY_RATED, CEE_RANKED_PLACEMENT_SERIES } from "../shared/CEERanked";
import { beijingDay } from "../domain/BeijingDay";
import { displayCEERating } from "../domain/CEERankedRating";
import { requireStore, type CEERankedContext } from "./CEERankedRuntime";
import { initialRatingRecord } from "./CEERankedSettlement";
import type { CEERankedHistoryRecord, CEERankedLeaderboardRecord } from "./CEERankedStore";

/** 战绩每页条数（首页资料带第一页，往前翻页同一口径）。 */
const HISTORY_PAGE = 20;
/** 排行榜条数与缓存时长：榜单人人都看，结算写库成功时立即作废。 */
const LEADERBOARD_SIZE = 50;
const LEADERBOARD_TTL_MS = 30_000;

export class CEERankedProfileQueries {
  private readonly ctx: CEERankedContext;
  /** 排行榜头部缓存；本人名次每次单独算，不进缓存。 */
  private leaderboardCache: {
    rows: CEERankedLeaderboardRecord[];
    total: number;
    at: number;
  } | null = null;

  constructor(ctx: CEERankedContext) {
    this.ctx = ctx;
  }

  /** 分数变了：排行榜下次现查，刚打完的人看得到自己的新名次。 */
  invalidate(): void {
    this.leaderboardCache = null;
  }

  async profile(userId: string): Promise<CEERankedProfile> {
    const store = requireStore(this.ctx);
    const record = (await store.getRating(userId)) ?? initialRatingRecord(userId);
    const page = await this.history(userId);
    const placed = record.seriesPlayed >= CEE_RANKED_PLACEMENT_SERIES;
    const today = beijingDay(this.ctx.now());
    return {
      rating: placed ? displayCEERating(record) : null,
      placementPlayed: Math.min(record.seriesPlayed, CEE_RANKED_PLACEMENT_SERIES),
      placementTotal: CEE_RANKED_PLACEMENT_SERIES,
      seriesPlayed: record.seriesPlayed,
      wins: record.wins,
      losses: record.losses,
      draws: record.draws,
      botRatedToday: record.botRatedDay === today ? record.botRatedCount : 0,
      botRatedLimit: CEE_RANKED_BOT_DAILY_RATED,
      recent: page.entries,
      recentHasMore: page.hasMore,
    };
  }

  /** 多取一条判断是否还有更早的战绩，不另发计数查询。 */
  async history(userId: string, before?: number): Promise<CEERankedHistoryPage> {
    const rows = await requireStore(this.ctx).listHistory(userId, HISTORY_PAGE + 1, before);
    return {
      entries: rows.slice(0, HISTORY_PAGE).map(historyEntryOf),
      hasMore: rows.length > HISTORY_PAGE,
    };
  }

  async leaderboard(userId: string): Promise<CEERankedLeaderboard> {
    const store = requireStore(this.ctx);
    const now = this.ctx.now();
    let cache = this.leaderboardCache;
    if (!cache || now - cache.at >= LEADERBOARD_TTL_MS) {
      const [rows, counted] = await Promise.all([
        store.listLeaderboard(CEE_RANKED_PLACEMENT_SERIES, LEADERBOARD_SIZE),
        store.countLeaderboard(CEE_RANKED_PLACEMENT_SERIES),
      ]);
      cache = { rows, total: counted.total, at: now };
      this.leaderboardCache = cache;
    }
    const entries = cache.rows.map((row, index) => ({
      rank: index + 1,
      name: row.name,
      rating: displayCEERating(row),
      wins: row.wins,
      losses: row.losses,
      seriesPlayed: row.seriesPlayed,
      self: row.userId === userId,
    }));
    const listed = entries.find((entry) => entry.self);
    if (listed)
      return { entries, self: { rank: listed.rank, rating: listed.rating }, total: cache.total };
    // 榜外的本人现查名次：定级中或没打过不进榜。
    const record = await store.getRating(userId);
    if (!record || record.seriesPlayed < CEE_RANKED_PLACEMENT_SERIES)
      return { entries, self: null, total: cache.total };
    const { above, total } = await store.countLeaderboard(
      CEE_RANKED_PLACEMENT_SERIES,
      record.rating
    );
    return {
      entries,
      self: { rank: above + 1, rating: displayCEERating(record) },
      total: Math.max(total, cache.total),
    };
  }
}

/** 战绩列表的一条：由结算记录换算结果与分差。 */
function historyEntryOf(item: CEERankedHistoryRecord): CEERankedHistoryEntry {
  const outcome: CEERankedOutcome =
    item.score === 1 ? "won" : item.score === 0.5 ? "drawn" : "lost";
  const delta =
    item.rated && item.ratingBefore !== null && item.ratingAfter !== null
      ? Math.round(item.ratingAfter) - Math.round(item.ratingBefore)
      : null;
  return {
    seriesId: item.seriesId,
    endedAt: item.endedAt,
    tierId: item.tier as CEERankedTierId,
    opponentName: item.opponentName,
    opponentIsBot: item.opponentIsBot,
    outcome,
    selfPoints: item.selfPoints,
    opponentPoints: item.opponentPoints,
    ratingDelta: delta,
    placement: item.placement,
  };
}
