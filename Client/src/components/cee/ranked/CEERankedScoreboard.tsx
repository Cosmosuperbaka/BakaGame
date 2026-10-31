import { AnimatePresence, motion } from "framer-motion";
import { Bot, Clock3, Hourglass, WifiOff } from "lucide-react";
import type { CEERankedSeatView, CEERankedSeriesView } from "@bakagame/shared";
import { Badge } from "@/components/ui/Badge";
import { useSecondsLeft } from "@/hooks/UseSecondsLeft";
import { readoutTick, spring } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { formatRankedClock, formatRankedPoints } from "./CEERankedFormat";

/** 名牌上的身份：人机标明「人机」、定级中只给进度、已定级给整数分；人机的强度从不出现。 */
function SeatIdentity({ seat }: { seat: CEERankedSeatView }) {
  if (seat.isBot)
    return (
      <Badge variant="secondary" size="xs" className="shrink-0">
        <Bot aria-hidden="true" className="h-3 w-3" />
        人机
      </Badge>
    );
  if (seat.placementPlayed !== null)
    return (
      <Badge variant="subtle" size="xs" className="shrink-0">
        定级中
      </Badge>
    );
  return seat.rating === null ? null : (
    <span className="font-mono text-xs text-muted-foreground tabular-nums">{seat.rating}</span>
  );
}

function SeatPlate({ seat, side }: { seat: CEERankedSeatView; side: "self" | "opponent" }) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col gap-1",
        side === "opponent" ? "items-end text-right" : "items-start"
      )}
    >
      <span className="text-2xs text-muted-foreground">{side === "self" ? "你" : "对手"}</span>
      <div
        className={cn(
          "flex min-w-0 max-w-full items-center gap-1.5",
          side === "opponent" && "flex-row-reverse"
        )}
      >
        <span className="truncate font-serif text-base font-semibold">{seat.name}</span>
        <SeatIdentity seat={seat} />
      </div>
      <div
        className={cn(
          "flex items-center gap-2 text-xs text-muted-foreground",
          side === "opponent" && "flex-row-reverse"
        )}
      >
        <span className="font-mono tabular-nums">
          已猜 {seat.attempts} / {seat.allowance}
        </span>
        {seat.online ? null : (
          <span className="inline-flex items-center gap-1 text-warning">
            <WifiOff className="size-3" aria-hidden="true" />
            离线
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * 三局的胜负点：本人赢的实心主色、对手赢的实心墨色、平局虚线浅灰，进行中的那一局只描主色边。
 * 形状与文字共同表达结果，不只靠颜色。
 */
function GamePips({ series }: { series: CEERankedSeriesView }) {
  return (
    <ol className="flex items-center gap-1.5" aria-label="各局结果">
      {[0, 1, 2].map((index) => {
        const game = series.games[index];
        const live = !game && series.game?.number === index + 1;
        const label = game
          ? `第 ${index + 1} 局：${game.winner === "self" ? "你赢" : game.winner === "opponent" ? "对手赢" : "平局"}`
          : live
            ? `第 ${index + 1} 局：进行中`
            : `第 ${index + 1} 局：未开始`;
        return (
          <li key={index} aria-label={label}>
            <motion.span
              key={game ? `done-${game.winner ?? "draw"}` : live ? "live" : "idle"}
              initial={game ? { scale: 0.6 } : false}
              animate={{ scale: 1 }}
              transition={spring.impulse}
              className={cn(
                "block size-2.5 rounded-full border",
                game?.winner === "self" && "border-primary bg-primary",
                game?.winner === "opponent" && "border-foreground/70 bg-foreground/70",
                game &&
                  game.winner === null &&
                  "border-dashed border-foreground/60 bg-muted-foreground/30",
                !game && live && "border-primary",
                !game && !live && "border-border"
              )}
            />
          </li>
        );
      })}
    </ol>
  );
}

/** 对局时钟：读秒、常规、加时、局间各一种读法；加时转为警示色并写明「加时」。 */
function SeriesClock({ series }: { series: CEERankedSeriesView }) {
  const game = series.game;
  const target =
    series.phase === "intermission"
      ? series.nextGameAt
      : game?.phase === "countdown"
        ? game.startsAt
        : (game?.deadlineAt ?? null);
  const seconds = useSecondsLeft(target);
  if (series.phase === "settled" || target === null) return null;
  const overtime = series.phase === "overtime";
  const caption =
    series.phase === "intermission"
      ? "下一局"
      : series.phase === "countdown"
        ? "即将开始"
        : overtime
          ? "加时"
          : "剩余";
  const Icon = series.phase === "countdown" || series.phase === "intermission" ? Hourglass : Clock3;
  return (
    <div
      role="timer"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs",
        overtime ? "border-warning/50 bg-warning/10 text-warning" : "text-muted-foreground"
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      <span>{caption}</span>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={seconds}
          initial={readoutTick.initial}
          animate={readoutTick.animate}
          transition={readoutTick.transition}
          className="font-mono tabular-nums"
        >
          {series.phase === "countdown" || series.phase === "intermission"
            ? `${seconds}s`
            : formatRankedClock(seconds)}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}

/**
 * 排位对局顶栏：左右是双方名牌，中间是系列赛比分、三局胜负点、本场难度与时钟。
 * 窄屏时名牌与比分仍在同一行，名字截断让位给比分。
 */
export function CEERankedScoreboard({ series }: { series: CEERankedSeriesView }) {
  const gameNumber = series.game?.number ?? series.games.length;
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border bg-panel px-3 py-2.5 sm:flex-nowrap sm:px-4">
      <SeatPlate seat={series.self} side="self" />
      <div className="order-last flex basis-full flex-col items-center gap-1 sm:order-none sm:basis-auto sm:shrink-0">
        <div
          className="flex items-baseline gap-2 font-serif text-2xl font-semibold tabular-nums"
          aria-label={`比分 ${series.self.points} 比 ${series.opponent.points}`}
        >
          <span>{formatRankedPoints(series.self.points)}</span>
          <span className="text-base text-muted-foreground" aria-hidden="true">
            :
          </span>
          <span>{formatRankedPoints(series.opponent.points)}</span>
        </div>
        <GamePips series={series} />
        <span className="text-2xs text-muted-foreground">
          {series.phase === "settled" ? "本场结束" : `第 ${Math.max(1, gameNumber)} 局`} ·{" "}
          {series.tier.name}
        </span>
        <SeriesClock series={series} />
      </div>
      <SeatPlate seat={series.opponent} side="opponent" />
    </header>
  );
}
