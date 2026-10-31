import { AppError } from "../domain/Errors";
import { CEE_RANKED_BOT_FALLBACK_MS } from "../shared/CEERanked";

export interface CEERankedQueueEntry {
  userId: string;
  /** 排队时的评分均值 μ，配对用它算分差。 */
  rating: number;
  queuedAt: number;
  /** 上一位真人对手及该场结束时刻，用于 3 分钟内不重复匹配。 */
  lastOpponent: { userId: string; at: number } | null;
}

export const CEE_RANKED_WINDOW_INITIAL = 150;
export const CEE_RANKED_WINDOW_STEP = 50;
export const CEE_RANKED_WINDOW_STEP_MS = 5_000;
export const CEE_RANKED_WINDOW_MAX = 500;
export const CEE_RANKED_REMATCH_COOLDOWN_MS = 180_000;

/** 等待越久窗口越宽：每 5 秒放宽一档，到顶后不再放宽。 */
export function ceeRankedWindow(entry: CEERankedQueueEntry, now: number): number {
  const waited = Math.max(0, now - entry.queuedAt);
  return Math.min(
    CEE_RANKED_WINDOW_MAX,
    CEE_RANKED_WINDOW_INITIAL +
      CEE_RANKED_WINDOW_STEP * Math.floor(waited / CEE_RANKED_WINDOW_STEP_MS)
  );
}

/**
 * 匹配队列：纯逻辑，不持有计时器。
 *
 * 计时与推送都由服务层负责，这里只做一跳的配对与兜底判定，测试可以直接调 `tick` 而不需要驱动时钟。
 */
export class CEERankedQueue {
  private readonly entries = new Map<string, CEERankedQueueEntry>();

  add(entry: CEERankedQueueEntry): void {
    if (this.entries.has(entry.userId)) throw new AppError("RANKED_ALREADY_QUEUED", "已经在排队了");
    this.entries.set(entry.userId, entry);
  }
  remove(userId: string): CEERankedQueueEntry | undefined {
    const entry = this.entries.get(userId);
    this.entries.delete(userId);
    return entry;
  }
  get(userId: string): CEERankedQueueEntry | undefined {
    return this.entries.get(userId);
  }
  get size(): number {
    return this.entries.size;
  }

  /** 一跳：先配真人，再把等满兜底时长的人交给人机；返回的条目都已移出队列。 */
  tick(now: number): {
    pairs: Array<[CEERankedQueueEntry, CEERankedQueueEntry]>;
    fallbacks: CEERankedQueueEntry[];
  } {
    const ordered = [...this.entries.values()].sort((a, b) => a.queuedAt - b.queuedAt);
    const unpaired = new Set(ordered);
    const pairs: Array<[CEERankedQueueEntry, CEERankedQueueEntry]> = [];
    for (const first of ordered) {
      if (!unpaired.has(first)) continue;
      const second = this.findPartner(first, unpaired, now);
      if (!second) continue;
      unpaired.delete(first);
      unpaired.delete(second);
      this.entries.delete(first.userId);
      this.entries.delete(second.userId);
      pairs.push([first, second]);
    }
    const fallbacks: CEERankedQueueEntry[] = [];
    for (const entry of ordered) {
      if (!unpaired.has(entry)) continue;
      if (now - entry.queuedAt < CEE_RANKED_BOT_FALLBACK_MS) continue;
      unpaired.delete(entry);
      this.entries.delete(entry.userId);
      fallbacks.push(entry);
    }
    return { pairs, fallbacks };
  }

  /** 分差在窗口内且不违反重复匹配限制里挑最小者；并列取更早排队者。 */
  private findPartner(
    first: CEERankedQueueEntry,
    unpaired: ReadonlySet<CEERankedQueueEntry>,
    now: number
  ): CEERankedQueueEntry | undefined {
    const windowOfFirst = ceeRankedWindow(first, now);
    let best: CEERankedQueueEntry | undefined;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const candidate of unpaired) {
      if (candidate === first) continue;
      const gap = Math.abs(first.rating - candidate.rating);
      const windowOfCandidate = ceeRankedWindow(candidate, now);
      if (gap > Math.max(windowOfFirst, windowOfCandidate)) continue;
      const bothMaxed =
        windowOfFirst >= CEE_RANKED_WINDOW_MAX && windowOfCandidate >= CEE_RANKED_WINDOW_MAX;
      if (!bothMaxed && blockedByRematch(first, candidate, now)) continue;
      if (
        gap < bestGap ||
        (gap === bestGap && best !== undefined && candidate.queuedAt < best.queuedAt)
      ) {
        best = candidate;
        bestGap = gap;
      }
    }
    return best;
  }
}

/** 任一方的上一位真人对手是对方且仍在冷却里时不重复匹配。 */
function blockedByRematch(
  first: CEERankedQueueEntry,
  second: CEERankedQueueEntry,
  now: number
): boolean {
  const recent = (opponent: string | undefined, at: number | undefined): boolean =>
    opponent === second.userId && at !== undefined && now - at < CEE_RANKED_REMATCH_COOLDOWN_MS;
  const recentOther = (opponent: string | undefined, at: number | undefined): boolean =>
    opponent === first.userId && at !== undefined && now - at < CEE_RANKED_REMATCH_COOLDOWN_MS;
  return (
    recent(first.lastOpponent?.userId, first.lastOpponent?.at) ||
    recentOther(second.lastOpponent?.userId, second.lastOpponent?.at)
  );
}
