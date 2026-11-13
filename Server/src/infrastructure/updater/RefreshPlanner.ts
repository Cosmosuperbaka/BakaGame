import type { Database } from "bun:sqlite";

export const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
/** 失败退避上限：连续失败也别把条目永久钉死，一周后总得再试一次。 */
const MAX_BACKOFF_MS = 7 * DAY_MS;

/** 一层刷新策略：`coverage` 是热度排名前多少比例（按 heat 降序）。 */
export interface RefreshTier {
  coverage: number;
  intervalDays: number;
}

/** 默认三层：前 20% 两天一次，前 50% 一周一次，其余一个月一次。 */
export const DEFAULT_REFRESH_TIERS: RefreshTier[] = [
  { coverage: 0.2, intervalDays: 2 },
  { coverage: 0.5, intervalDays: 7 },
  { coverage: 1, intervalDays: 30 },
];

/**
 * 刷新计划：哪些条目到期、属于哪一层、失败后怎么退避。
 * 只读写数据集里的刷新状态表，不发请求，所以可以脱离网络单独测试。
 */
export class RefreshPlanner {
  constructor(
    private readonly db: Database,
    private readonly now: () => number,
    private readonly tiers: RefreshTier[],
    private readonly roundLimit: number
  ) {}

  /**
   * 把库里现有作品登记为「此刻已刷新」（只补没有记录的条目）。
   *
   * 不登记的话，部署首轮会把三万多条全部当成「从未刷新」，于是一上线就把全库刷一遍
   * —— 可这些数据是刚随构建产物流下来的，本来就是新鲜的。登记之后三层节奏从部署
   * 时刻起算，真正的首次刷新落在 2 / 7 / 30 天之后。
   */
  markDatasetFresh(): number {
    const result = this.db
      .query<never, [number]>(
        "INSERT OR IGNORE INTO bangumi_refresh (subject_id, tier, refreshed_at, failures, next_at)" +
          " SELECT id, -1, ?, 0, 0 FROM subjects"
      )
      .run(this.now());
    return result.changes;
  }

  /**
   * 挑出本轮到期的条目，筛选与限量都在查询层完成：库里有数万条作品，每轮（空转时也跑）
   * 把全表读成对象再在内存里排序，是纯粹的浪费。
   *
   * 到期判定有两条且必须同时满足：
   * - **新鲜度**：`now - refreshed_at >= 该层间隔`（分位本轮重算，所以同一条
   *   作品变热后会提前到期、变冷后会被推迟）。`refreshed_at` 只记**成功**刷新的时刻，
   *   失败不会把它推到现在，否则层间隔（天级）会压过退避，失败的条目被晾上几天甚至一个月。
   *   从未成功过的条目（没有状态行或刷新时刻为空）视为过期。
   * - **退避**：`now >= next_at`（连续失败的条目按指数退避往后压）。
   *
   * 热度名次（0 = 最热，热度相同按编号）决定所属层；每层的名次区间在这里先算成整数界，
   * 再写进条件里，所以层内的新鲜度阈值也是按层各自的间隔。
   */
  selectDue(): Array<{ id: number | string; tier: number }> {
    const total = (
      this.db.query<{ total: number }, []>("SELECT count(*) AS total FROM subjects").get() ?? {
        total: 0,
      }
    ).total;
    if (!total) return [];
    const now = this.now();
    const bounds = this.tierBounds(total);
    const clauses: string[] = [];
    const params: number[] = [now];
    let lower = 0;
    bounds.forEach((upper, tier) => {
      if (upper <= lower) return;
      const intervalMs = (this.tiers[tier]?.intervalDays ?? 30) * DAY_MS;
      clauses.push("(rank >= ? AND rank < ? AND (refreshed_at IS NULL OR refreshed_at <= ?))");
      params.push(lower, upper, now - intervalMs);
      lower = upper;
    });
    if (!clauses.length) return [];
    params.push(this.roundLimit);
    const rows = this.db
      .query<{ id: number | string; rank: number }, number[]>(
        "WITH ranked AS (" +
          " SELECT s.id AS id, ROW_NUMBER() OVER (ORDER BY s.heat DESC, s.id ASC) - 1 AS rank," +
          " r.refreshed_at AS refreshed_at, r.next_at AS next_at" +
          " FROM subjects s LEFT JOIN bangumi_refresh r ON r.subject_id = s.id)" +
          " SELECT id, rank FROM ranked WHERE (next_at IS NULL OR next_at <= ?) AND (" +
          clauses.join(" OR ") +
          ") ORDER BY rank LIMIT ?"
      )
      .all(...params);
    return rows.map((row) => ({ id: row.id, tier: this.tierAt(Number(row.rank) / total) }));
  }

  /**
   * 每一层的名次上界（不含）：第 t 层覆盖 `tierAt(名次 / 总数) === t` 的名次。
   * 用与 `tierAt` 同一个比较表达式调整，避免浮点边界与逐行判定不一致。
   */
  private tierBounds(total: number): number[] {
    const bounds: number[] = [];
    for (let tier = 0; tier < this.tiers.length; tier += 1) {
      const coverage = this.tiers[tier]?.coverage ?? 1;
      let bound = Math.min(total, Math.max(0, Math.ceil(coverage * total)));
      while (bound > 0 && (bound - 1) / total >= coverage) bound -= 1;
      while (bound < total && bound / total < coverage) bound += 1;
      bounds.push(tier === this.tiers.length - 1 ? total : bound);
    }
    return bounds;
  }

  /** 热度排名（0 = 最热）落在哪一层。 */
  private tierAt(ratio: number): number {
    for (let index = 0; index < this.tiers.length; index += 1) {
      if (ratio < (this.tiers[index]?.coverage ?? 1)) return index;
    }
    return Math.max(0, this.tiers.length - 1);
  }

  /** 是否过期到值得为一次玩家请求回源（口径取最热的那一层间隔）。 */
  isStale(subjectId: number): boolean {
    const row = this.db
      .query<{ refreshed_at: number; next_at: number }, [number]>(
        "SELECT refreshed_at, next_at FROM bangumi_refresh WHERE subject_id = ?"
      )
      .get(subjectId);
    if (!row) return true;
    // 退避期内的失败条目不接受按需刷新：否则玩家反复点开同一条就会反复打上游。
    if (this.now() < row.next_at) return false;
    const shortest = Math.min(...this.tiers.map((tier) => tier.intervalDays));
    return this.now() - row.refreshed_at >= shortest * DAY_MS;
  }

  failuresOf(subjectId: number): number {
    const row = this.db
      .query<{ failures: number }, [number]>(
        "SELECT failures FROM bangumi_refresh WHERE subject_id = ?"
      )
      .get(subjectId);
    return Number(row?.failures ?? 0);
  }

  /** 连续失败的指数退避：1h → 2h → 4h … 封顶一周。 */
  backoffFor(failures: number): number {
    return Math.min(MAX_BACKOFF_MS, HOUR_MS * 2 ** Math.max(0, failures - 1));
  }

  /** 成功：记下刷新时刻，清零失败计数与退避。 */
  markRefreshed(subjectId: number, now: number, tier: number): void {
    this.db
      .query<never, [number, number, number, number, number]>(
        "INSERT INTO bangumi_refresh (subject_id, tier, refreshed_at, failures, next_at) VALUES (?,?,?,?,?)" +
          " ON CONFLICT(subject_id) DO UPDATE SET tier = excluded.tier, refreshed_at = excluded.refreshed_at," +
          " failures = excluded.failures, next_at = excluded.next_at"
      )
      .run(subjectId, tier, now, 0, 0);
  }

  /**
   * 失败（或 nsfw 跳过）：只推后下次尝试时刻，**保留**上一次成功刷新的时刻。
   * 从未成功过的新条目写 0，表示「从未刷新」，退避一过就会被再次选中。
   */
  markFailed(subjectId: number, tier: number, failures: number, nextAt: number): void {
    this.db
      .query<never, [number, number, number, number]>(
        "INSERT INTO bangumi_refresh (subject_id, tier, refreshed_at, failures, next_at) VALUES (?,?,0,?,?)" +
          " ON CONFLICT(subject_id) DO UPDATE SET tier = excluded.tier," +
          " failures = excluded.failures, next_at = excluded.next_at"
      )
      .run(subjectId, tier, failures, nextAt);
  }
}
