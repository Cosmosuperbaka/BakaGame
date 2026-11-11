import { motion } from "framer-motion";
import { Bot, Handshake, LogOut, WifiOff } from "lucide-react";
import type { CEERankedSeriesView } from "@bakagame/shared";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { phaseTitleRise, revealCard } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { formatRankedPoints } from "./CEERankedFormat";
import { RankedGameMark, RankedOutcomeMark } from "./CEERankedMarks";

const OUTCOME_TITLE = { won: "胜利", lost: "惜败", drawn: "平局" } as const;

/**
 * 非常规的收场才另挂一枚标签：退出、掉线、加赛打满仍同分。正常打完的胜负由逐局结果条自己说清。
 */
function ReasonBadge({ result }: { result: NonNullable<CEERankedSeriesView["result"]> }) {
  const won = result.outcome === "won";
  const reason =
    result.reason === "exit"
      ? { icon: LogOut, text: won ? "对手退出了比赛" : "你退出了比赛" }
      : result.reason === "offline"
        ? { icon: WifiOff, text: won ? "对手掉线超时" : "你掉线超时" }
        : result.outcome === "drawn"
          ? { icon: Handshake, text: "加赛打满仍未分出胜负" }
          : null;
  if (!reason) return null;
  const Icon = reason.icon;
  return (
    <Badge variant="subtle" className="gap-1.5">
      <Icon className="size-3.5" aria-hidden="true" />
      {reason.text}
    </Badge>
  );
}

/** 对阵与比分：左边是你、右边是对手，中间是赢下的局数。 */
function VersusRow({ series }: { series: CEERankedSeriesView }) {
  return (
    <div className="grid w-full max-w-md grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3">
      <div className="min-w-0 text-right">
        <span className="block text-2xs text-muted-foreground">你</span>
        <span className="block truncate font-serif text-base font-semibold">
          {series.self.name}
        </span>
      </div>
      <div
        className="flex items-baseline gap-2 font-serif text-4xl font-semibold tabular-nums"
        aria-label={`比分 ${series.self.points} 比 ${series.opponent.points}`}
      >
        <span className={cn(series.result?.outcome === "won" && "text-primary")}>
          {formatRankedPoints(series.self.points)}
        </span>
        <span className="text-xl text-muted-foreground" aria-hidden="true">
          :
        </span>
        <span>{formatRankedPoints(series.opponent.points)}</span>
      </div>
      <div className="min-w-0 text-left">
        <span className="block text-2xs text-muted-foreground">对手</span>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-serif text-base font-semibold">
            {series.opponent.name}
          </span>
          {series.opponent.isBot ? (
            <Badge variant="secondary" size="xs" className="shrink-0">
              <Bot className="size-3" aria-hidden="true" />
              人机
            </Badge>
          ) : null}
        </span>
      </div>
    </div>
  );
}

/** 逐局结果条：每局一枚记号，平局（不算分）的加赛局也在里面，读得出这场是怎么打出来的。 */
function GameStrip({ series }: { series: CEERankedSeriesView }) {
  if (!series.games.length) return null;
  return (
    <ol className="flex flex-wrap justify-center gap-2" aria-label="各局结果">
      {series.games.map((game) => (
        <li key={game.number} className="flex flex-col items-center gap-1">
          <RankedGameMark winner={game.winner} number={game.number} />
          <span
            className="font-mono text-2xs text-muted-foreground tabular-nums"
            aria-hidden="true"
          >
            {game.number}
          </span>
        </li>
      ))}
    </ol>
  );
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
 * 整场结算卡：胜负徽章与标题自基线升起，下面是对阵比分、逐局结果条与分数变化；
 * 卡片按揭晓动效亮相，分数从赛前滚到赛后。
 * 「再来一场」直接重新排队；「返回」回到排位首页。
 */
export function CEERankedResultCard({
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
      <RankedOutcomeMark outcome={result.outcome} size="lg" />
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
      <ReasonBadge result={result} />
      <VersusRow series={series} />
      <GameStrip series={series} />
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
