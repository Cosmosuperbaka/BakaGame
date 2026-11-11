import { Check, Handshake, Minus, TrendingDown, TrendingUp, Trophy, Swords, X } from "lucide-react";
import type { CEERankedHistoryEntry, CEERankedOutcome } from "@bakagame/shared";
import { cn } from "@/lib/Utils";

const OUTCOME_LABEL: Record<CEERankedOutcome, string> = { won: "胜", lost: "负", drawn: "平" };
const OUTCOME_ICON = { won: Trophy, lost: Swords, drawn: Handshake } as const;

/**
 * 一场系列赛的胜负记号：赢是主色描边加奖杯，输是中性底加交叉的剑，平是虚线框加握手。
 * 形状、图标与可访问名一起表达结果，不只靠颜色。
 */
export function RankedOutcomeMark({
  outcome,
  size = "md",
  className,
}: {
  outcome: CEERankedOutcome;
  size?: "md" | "lg";
  className?: string;
}) {
  const Icon = OUTCOME_ICON[outcome];
  return (
    <span
      role="img"
      aria-label={OUTCOME_LABEL[outcome]}
      className={cn(
        "inline-flex shrink-0 items-center justify-center border",
        size === "lg" ? "size-14 rounded-full border-2" : "size-8 rounded-md",
        outcome === "won" && "border-primary/50 bg-primary/10 text-primary",
        outcome === "lost" && "border-transparent bg-muted text-muted-foreground",
        outcome === "drawn" && "border-dashed border-border text-muted-foreground",
        className
      )}
    >
      <Icon className={size === "lg" ? "size-6" : "size-4"} aria-hidden="true" />
    </span>
  );
}

/**
 * 胜负条与计数：一条按胜率切开的横条，下面是带图标的胜、负（有平局时再加平）与胜率。
 * 横条只是总览，具体数字仍以文字给出；没有对局时横条留空并说明。
 */
export function RankedRecordMeter({
  wins,
  losses,
  draws,
}: {
  wins: number;
  losses: number;
  draws: number;
}) {
  const total = wins + losses + draws;
  const rate = total ? Math.round((wins / total) * 100) : null;
  return (
    <div className="space-y-1.5">
      <div
        className="flex h-2 gap-px overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={total ? `${wins} 胜 ${losses} 负，胜率 ${rate}%` : "还没有对局"}
      >
        {wins ? <span className="bg-primary" style={{ flexGrow: wins }} /> : null}
        {draws ? <span className="bg-muted-foreground/40" style={{ flexGrow: draws }} /> : null}
        {losses ? <span className="bg-foreground/55" style={{ flexGrow: losses }} /> : null}
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
        <span className="inline-flex items-center gap-1">
          <Trophy className="size-3.5 text-primary" />
          <span className="font-mono text-foreground tabular-nums">{wins}</span>胜
        </span>
        <span className="inline-flex items-center gap-1">
          <Swords className="size-3.5" />
          <span className="font-mono text-foreground tabular-nums">{losses}</span>负
        </span>
        {draws ? (
          <span className="inline-flex items-center gap-1">
            <Handshake className="size-3.5" />
            <span className="font-mono text-foreground tabular-nums">{draws}</span>平
          </span>
        ) : null}
        <span className="ml-auto font-mono tabular-nums">{rate === null ? "—" : `${rate}%`}</span>
      </div>
    </div>
  );
}

/** 近况：最近几场从旧到新排成一行小方块，最新的在最右。 */
export function RankedRecentForm({ entries }: { entries: readonly CEERankedHistoryEntry[] }) {
  if (!entries.length) return null;
  const ordered = [...entries].reverse();
  return (
    <div className="flex items-center gap-2">
      <span className="shrink-0 text-2xs text-muted-foreground">近况</span>
      <ol
        className="flex min-w-0 flex-wrap gap-1"
        aria-label={`最近 ${ordered.length} 场：${ordered.map((entry) => OUTCOME_LABEL[entry.outcome]).join("")}`}
      >
        {ordered.map((entry) => {
          const Icon = entry.outcome === "won" ? Check : entry.outcome === "lost" ? X : Minus;
          return (
            <li
              key={entry.seriesId}
              aria-hidden="true"
              className={cn(
                "flex size-4 items-center justify-center rounded-sm border",
                entry.outcome === "won" && "border-primary bg-primary text-primary-foreground",
                entry.outcome === "lost" && "border-transparent bg-foreground/55 text-background",
                entry.outcome === "drawn" && "border-dashed border-border text-muted-foreground"
              )}
            >
              <Icon className="size-3" strokeWidth={3} />
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * 分数变化：涨分绿色上扬箭头、掉分中性下行箭头；定级赛写「定级」，未计分给一道横线。
 * 箭头与正负号一起表达方向，不只靠颜色。
 */
export function RankedRatingDelta({
  delta,
  placement,
}: {
  delta: number | null;
  placement: boolean;
}) {
  if (placement) return <span className="shrink-0 text-2xs text-muted-foreground">定级</span>;
  if (delta === null)
    return (
      <span className="shrink-0 text-xs text-muted-foreground" aria-label="未计分">
        —
      </span>
    );
  const Icon = delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 font-mono text-xs tabular-nums",
        delta > 0 ? "text-success" : "text-muted-foreground"
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {delta > 0 ? `+${delta}` : delta === 0 ? "±0" : `−${Math.abs(delta)}`}
    </span>
  );
}
