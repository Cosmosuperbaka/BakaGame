import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { CEERankedHistoryEntry } from "@bakagame/shared";
import { ceeRankedTier } from "@bakagame/shared/values";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { listContainer, listItem, skeletonFade } from "@/lib/Motion";
import { formatRelativeTime } from "@/lib/Time";
import { formatRankedPoints } from "./CEERankedFormat";
import { RankedOutcomeMark, RankedRatingDelta } from "./CEERankedMarks";

const OUTCOME_TEXT = { won: "胜", lost: "负", drawn: "平" } as const;

function HistoryRow({ entry }: { entry: CEERankedHistoryEntry }) {
  return (
    <motion.li
      variants={listItem}
      className="flex items-center gap-2 py-2.5 sm:gap-3"
      aria-label={`${OUTCOME_TEXT[entry.outcome]}，对手 ${entry.opponentName}，比分 ${entry.selfPoints} 比 ${entry.opponentPoints}`}
    >
      <RankedOutcomeMark outcome={entry.outcome} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium">{entry.opponentName}</span>
          {entry.opponentIsBot ? (
            <Badge variant="subtle" size="xs" className="shrink-0">
              人机
            </Badge>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-2xs text-muted-foreground">
          <span>{ceeRankedTier(entry.tierId).name}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={new Date(entry.endedAt).toISOString()}>
            {formatRelativeTime(new Date(entry.endedAt).toISOString())}
          </time>
        </div>
      </div>
      <span className="shrink-0 font-mono text-sm tabular-nums" aria-hidden="true">
        {formatRankedPoints(entry.selfPoints)}
        <span className="px-0.5 text-muted-foreground">:</span>
        {formatRankedPoints(entry.opponentPoints)}
      </span>
      <span className="flex w-14 shrink-0 justify-end">
        <RankedRatingDelta delta={entry.ratingDelta} placement={entry.placement} />
      </span>
    </motion.li>
  );
}

/**
 * 全部战绩：面板内固定高度、纵向滚动，滚到底自动往前翻一页；
 * 底部按钮既是翻页的哨兵，也让不便滚动的人能手动加载。
 */
export function CEERankedHistory({
  entries,
  hasMore,
  loading,
  onLoadMore,
}: {
  entries: readonly CEERankedHistoryEntry[] | null;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadMore = useRef(onLoadMore);
  useEffect(() => {
    loadMore.current = onLoadMore;
  });
  // 每拼上一页就重新观察：哨兵翻完一页仍在可视区（列表还没撑满面板）时，观察器的首次回调会接着翻。
  const count = entries?.length ?? null;
  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (count === null || !hasMore || !root || !sentinel) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) loadMore.current();
      },
      { root, rootMargin: "0px 0px 120px 0px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [count, hasMore]);

  return (
    <div ref={scrollRef} className="scroll-fade-y max-h-104 py-3" aria-label="全部战绩">
      <AnimatePresence initial={false} mode="popLayout">
        {entries === null ? (
          <motion.div
            key="loading"
            exit={skeletonFade.exit}
            className="space-y-2"
            aria-hidden="true"
          >
            {[0, 1, 2].map((index) => (
              <div key={index} className="h-11 motion-safe:animate-breathe rounded-md bg-muted" />
            ))}
          </motion.div>
        ) : entries.length ? (
          <motion.div key="list">
            <motion.ol
              variants={listContainer(Math.min(entries.length, 20))}
              initial="initial"
              animate="animate"
              className="divide-y"
            >
              {entries.map((entry) => (
                <HistoryRow key={entry.seriesId} entry={entry} />
              ))}
            </motion.ol>
            <div ref={sentinelRef} className="flex justify-center pt-2">
              {hasMore ? (
                <Button variant="ghost" size="sm" loading={loading} onClick={onLoadMore}>
                  加载更早的战绩
                </Button>
              ) : (
                <span className="py-1 text-2xs text-muted-foreground">
                  共 {entries.length} 场，已经到底了
                </span>
              )}
            </div>
          </motion.div>
        ) : (
          <motion.p
            key="empty"
            className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground"
          >
            还没有排位记录，打完第一场后显示在这里
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
