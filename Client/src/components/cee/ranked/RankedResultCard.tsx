import { motion } from "framer-motion";
import type { CEERankedSeriesView } from "@bakagame/shared";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { phaseTitleRise, revealCard } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { formatRankedPoints } from "./RankedFormat";

const OUTCOME_TITLE = { won: "胜利", lost: "惜败", drawn: "平局" } as const;

function reasonText(result: NonNullable<CEERankedSeriesView["result"]>): string {
  if (result.reason === "exit") return result.outcome === "won" ? "对手退出了比赛" : "你退出了比赛";
  if (result.reason === "offline") return result.outcome === "won" ? "对手掉线超时" : "你掉线超时";
  return result.outcome === "drawn" ? "三局打完，比分持平" : "三局两胜";
}

/** 定级进度：已完成的场次实心，形状与「x / 5」文字一起表达，不只靠颜色。 */
function PlacementPips({ played, total }: { played: number; total: number }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <ol className="flex gap-1.5" aria-hidden="true">
        {Array.from({ length: total }, (_, index) => (
          <li
            key={index}
            className={cn(
              "size-2.5 rounded-full border",
              index < played ? "border-primary bg-primary" : "border-border"
            )}
          />
        ))}
      </ol>
      <span className="text-sm text-muted-foreground">
        定级赛 {played} / {total}
      </span>
    </div>
  );
}

/** 分数变化区：只陈述服务端给出的结果，写库未落定、未计分、写库失败各有一句真实说明。 */
function RatingBlock({
  result,
  placementTotal,
}: {
  result: NonNullable<CEERankedSeriesView["result"]>;
  placementTotal: number;
}) {
  if (result.settlement === "pending")
    return (
      <p className="inline-flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Spinner className="size-4" />
        正在结算…
      </p>
    );
  if (result.settlement === "failed")
    return (
      <p className="text-sm text-muted-foreground" role="status">
        结算没能保存，本场不计分
      </p>
    );
  if (result.settlement === "unrated")
    return (
      <p className="text-sm text-muted-foreground" role="status">
        今日人机计分局已用完，本场不计分
      </p>
    );
  if (result.placementPlayed !== null && result.ratingAfter === null)
    return <PlacementPips played={result.placementPlayed} total={placementTotal} />;
  if (result.ratingAfter === null) return null;
  if (result.ratingBefore === null)
    return (
      <div className="flex flex-col items-center gap-1">
        <span className="text-sm text-muted-foreground">定级完成</span>
        <AnimatedNumber
          value={result.ratingAfter}
          className="font-serif text-4xl font-semibold tabular-nums"
        />
      </div>
    );
  const delta = result.ratingAfter - result.ratingBefore;
  return (
    <div className="flex items-baseline gap-3">
      <AnimatedNumber
        value={result.ratingAfter}
        from={result.ratingBefore}
        delay={revealCard.settle}
        className="font-serif text-4xl font-semibold tabular-nums"
      />
      <Badge variant={delta > 0 ? "matched" : delta < 0 ? "muted" : "subtle"} className="font-mono">
        {delta > 0 ? `+${delta}` : delta === 0 ? "±0" : delta}
      </Badge>
    </div>
  );
}

/**
 * 整场结算卡：结果标题自基线升起，卡片按揭晓动效亮相，分数从赛前滚到赛后。
 * 「再来一场」直接重新排队；「返回」回到排位首页。
 */
export function RankedResultCard({
  series,
  placementTotal,
  requeueing = false,
  leaving = false,
  onRequeue,
  onLeave,
}: {
  series: CEERankedSeriesView;
  placementTotal: number;
  requeueing?: boolean;
  leaving?: boolean;
  onRequeue: () => void;
  onLeave: () => void;
}) {
  const result = series.result;
  if (!result) return null;
  return (
    <motion.section
      aria-label="本场结果"
      initial={revealCard.initial}
      animate={revealCard.animate}
      transition={revealCard.transition}
      className="flex flex-col items-center gap-4 rounded-md border bg-card px-6 py-8 text-center shadow-sm"
    >
      <div className="overflow-hidden">
        <motion.h2
          initial={phaseTitleRise.initial}
          animate={phaseTitleRise.animate}
          transition={phaseTitleRise.transition}
          className={cn(
            "font-serif text-3xl font-semibold",
            result.outcome === "won" && "text-primary"
          )}
        >
          {OUTCOME_TITLE[result.outcome]}
        </motion.h2>
      </div>
      <p className="text-sm text-muted-foreground">
        {reasonText(result)} ·{" "}
        <span className="font-mono tabular-nums">
          {formatRankedPoints(series.self.points)} : {formatRankedPoints(series.opponent.points)}
        </span>{" "}
        · 对手 {series.opponent.name}
        {series.opponent.isBot ? "（人机）" : ""}
      </p>
      <RatingBlock result={result} placementTotal={placementTotal} />
      <div className="flex flex-wrap justify-center gap-2 pt-2">
        <Button
          onClick={onRequeue}
          loading={requeueing}
          disabled={leaving || result.settlement === "pending"}
        >
          再来一场
        </Button>
        <Button variant="outline" onClick={onLeave} loading={leaving} disabled={requeueing}>
          返回
        </Button>
      </div>
    </motion.section>
  );
}
