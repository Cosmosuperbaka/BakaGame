import { AnimatePresence, motion } from "framer-motion";
import { Bot, Clock3, Hourglass, WifiOff } from "lucide-react";
import type { CEERankedSeatView, CEERankedSeriesView } from "@bakagame/shared";
import { CEE_RANKED_SERIES_GAMES } from "@bakagame/shared/values";
import { Badge } from "@/components/ui/Badge";
import { useSecondsLeft } from "@/hooks/UseSecondsLeft";
import { readoutTick, spring } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { formatRankedClock, formatRankedPoints } from "./CEERankedFormat";
import { RankedAttemptMeter } from "./CEERankedMarks";

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

function SeatPlate({
  seat,
  side,
  live,
}: {
  seat: CEERankedSeatView;
  side: "self" | "opponent";
  /** 本场还没结束：离线标记只在这时有意义，结算后掉线方回来看结果页不该还挂着「离线」。 */
  live: boolean;
}) {
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
        <RankedAttemptMeter used={seat.attempts} allowance={seat.allowance} side={side} />
        {seat.online || !live ? null : (
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
 * 各局胜负点：本人赢的实心主色、对手赢的实心墨色、不算的平局虚线浅灰，进行中的那一局只描主色边。
 * 至少画满正赛三局；平局后的加赛局逐个追加。形状与文字共同表达结果，不只靠颜色。
 */
function GamePips({ series }: { series: CEERankedSeriesView }) {
  const count = Math.max(CEE_RANKED_SERIES_GAMES, series.games.length + (series.game ? 1 : 0));
  return (
    <ol className="flex items-center gap-1.5" aria-label="各局结果">
      {Array.from({ length: count }, (_, index) => {
        const game = series.games[index];
        const live = !game && series.game?.number === index + 1;
        const label = game
          ? `第 ${index + 1} 局：${game.winner === "self" ? "你赢" : game.winner === "opponent" ? "对手赢" : "双方都没猜中，不算"}`
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
 * 排位对局顶栏：左右是双方名牌与本局次数格，中间是系列赛比分、各局胜负点、局号与难度标签和时钟。
 * 窄屏时名牌与比分仍在同一行，名字截断让位给比分。
 */
export function CEERankedScoreboard({ series }: { series: CEERankedSeriesView }) {
  const gameNumber = series.game?.number ?? series.games.length;
  const live = series.phase !== "settled";
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border bg-panel px-3 py-2.5 sm:flex-nowrap sm:px-4">
      <SeatPlate seat={series.self} side="self" live={live} />
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
        <div className="flex flex-wrap items-center justify-center gap-1">
          <Badge variant="subtle" size="xs">
            {series.phase === "settled" ? "本场结束" : `第 ${Math.max(1, gameNumber)} 局`}
          </Badge>
          {series.phase !== "settled" && gameNumber > CEE_RANKED_SERIES_GAMES ? (
            <Badge variant="active" size="xs">
              加赛
            </Badge>
          ) : null}
          <Badge variant="outline" size="xs">
            {series.tier.name}
          </Badge>
          {/* 不计分要在开打时就看得到，而不是打完才在结果页得知。 */}
          {series.rated ? null : (
            <Badge variant="restricted" size="xs">
              不计分
            </Badge>
          )}
        </div>
        <SeriesClock series={series} />
      </div>
      <SeatPlate seat={series.opponent} side="opponent" live={live} />
    </header>
  );
}
