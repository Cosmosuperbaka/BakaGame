import { AnimatePresence, motion } from "framer-motion";
import { Crown, Medal } from "lucide-react";
import type { CEERankedLeaderboard, CEERankedLeaderboardEntry } from "@bakagame/shared";
import { Badge } from "@/components/ui/Badge";
import { PresenceBoundary } from "@/components/ui/PresenceBoundary";
import { listContainer, listItem, skeletonFade } from "@/lib/motion/Choreography";
import { cn } from "@/lib/Utils";
import { rankedRecordLabel, rankedWinRate } from "./CEERankedFormat";

/** 名次：第一名皇冠、二三名奖牌，其余等宽数字。 */
function RankCell({ rank }: { rank: number }) {
  if (rank <= 3) {
    const Icon = rank === 1 ? Crown : Medal;
    return (
      <span
        role="img"
        aria-label={`第 ${rank} 名`}
        className={cn(
          "flex size-7 items-center justify-center rounded-full border",
          rank === 1 ? "border-primary/50 bg-primary/10 text-primary" : "bg-muted text-foreground"
        )}
      >
        <Icon className="size-4" aria-hidden="true" />
      </span>
    );
  }
  return (
    <span
      className="flex size-7 items-center justify-center font-mono text-xs text-muted-foreground tabular-nums"
      aria-label={`第 ${rank} 名`}
    >
      {rank}
    </span>
  );
}

function LeaderboardRow({ entry }: { entry: CEERankedLeaderboardEntry }) {
  const rate = rankedWinRate(entry.wins, entry.losses);
  return (
    <motion.li
      variants={listItem}
      aria-current={entry.self ? "true" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-md border px-2 py-2",
        entry.self ? "border-primary/40 bg-primary/5" : "border-transparent"
      )}
    >
      <RankCell rank={entry.rank} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium">{entry.name}</span>
          {entry.self ? (
            <Badge variant="active" size="xs" className="shrink-0">
              你
            </Badge>
          ) : null}
        </div>
        <div
          className="mt-1 flex h-1 w-24 gap-px overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label={rankedRecordLabel(entry.wins, entry.losses, rate)}
        >
          {entry.wins ? <span className="bg-primary" style={{ flexGrow: entry.wins }} /> : null}
          {entry.losses ? (
            <span className="bg-foreground/55" style={{ flexGrow: entry.losses }} />
          ) : null}
        </div>
      </div>
      <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
        {rate === null ? "—" : `${rate}%`}
      </span>
      <span className="w-12 shrink-0 text-right font-serif text-base font-semibold tabular-nums">
        {entry.rating}
      </span>
    </motion.li>
  );
}

/**
 * 全服排行榜：头部是本人名次（榜外也给出），下面是按分数排的前若干名，面板内纵向滚动。
 * 只收打满定级赛的账号；定级中的本人只给一句怎样上榜。
 */
export function CEERankedLeaderboardPanel({
  leaderboard,
}: {
  leaderboard: CEERankedLeaderboard | null;
}) {
  return (
    <div className="space-y-3">
      <AnimatePresence initial={false} mode="popLayout">
        {leaderboard === null ? (
          <motion.div
            key="loading"
            exit={skeletonFade.exit}
            className="space-y-2 py-3"
            aria-hidden="true"
          >
            <div className="h-12 motion-safe:animate-breathe rounded-md bg-muted" />
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="h-10 motion-safe:animate-breathe rounded-md bg-muted" />
            ))}
          </motion.div>
        ) : (
          <motion.div key="board" className="space-y-1">
            <div className="flex items-center gap-3 rounded-md border bg-card px-3 py-2.5">
              <Crown className="size-5 shrink-0 text-primary" aria-hidden="true" />
              {leaderboard.self ? (
                <p
                  className="flex min-w-0 flex-1 items-baseline gap-2"
                  aria-label={`你的名次第 ${leaderboard.self.rank} 名，共 ${leaderboard.total} 人`}
                >
                  <span className="text-xs text-muted-foreground">你的名次</span>
                  <span className="font-serif text-2xl font-semibold tabular-nums">
                    #{leaderboard.self.rank}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                    / {leaderboard.total}
                  </span>
                </p>
              ) : (
                <p className="min-w-0 flex-1 text-sm text-muted-foreground">打满定级赛后上榜</p>
              )}
              {leaderboard.self ? (
                <span className="font-serif text-lg font-semibold tabular-nums">
                  {leaderboard.self.rating}
                </span>
              ) : null}
            </div>
            {leaderboard.entries.length ? (
              <motion.ol
                variants={listContainer(Math.min(leaderboard.entries.length, 20))}
                initial="initial"
                animate="animate"
                className="scroll-fade-y max-h-88 space-y-0.5 py-3"
                aria-label="排行榜"
              >
                {/* 榜单常是首屏那一项（沿用上次取到的榜）：重新取榜后多出的名次照常入场 */}
                <PresenceBoundary>
                  {leaderboard.entries.map((entry) => (
                    <LeaderboardRow key={entry.rank} entry={entry} />
                  ))}
                </PresenceBoundary>
              </motion.ol>
            ) : (
              <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                还没有人打满定级赛，第一个上榜的就是你
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
