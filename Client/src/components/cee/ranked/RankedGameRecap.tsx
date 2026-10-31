import { motion } from "framer-motion";
import { Check, Lightbulb, X } from "lucide-react";
import type { CEEGuess, CEERankedGameSummary } from "@bakagame/shared";
import { rankedGameHeadline } from "./RankedFormat";
import { CEEAnswerCard } from "../CEEAnswerCard";
import { listContainer, listItem } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

/** 一方的猜测清单：结束后双方完整公开，猜中、命中共同作品、未命中用图标区分。 */
function GuessList({ title, guesses }: { title: string; guesses: CEEGuess[] }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <h4 className="text-xs font-medium text-muted-foreground">
        {title} · {guesses.length} 次
      </h4>
      {guesses.length ? (
        <motion.ol
          variants={listContainer(guesses.length)}
          initial="initial"
          animate="animate"
          className="space-y-1"
        >
          {guesses.map((guess, index) => {
            const Icon = guess.correct ? Check : guess.partial ? Lightbulb : X;
            const label = guess.correct ? "猜中" : guess.partial ? "命中共同作品" : "未命中";
            return (
              <motion.li
                key={guess.id}
                variants={listItem}
                className={cn(
                  "flex items-center gap-2 rounded-md border px-2 py-1 text-sm",
                  guess.correct ? "border-success/50 bg-success/5" : "bg-panel"
                )}
              >
                <span className="w-5 shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {guess.character.nameCn || guess.character.name}
                </span>
                <Icon
                  className={cn(
                    "size-3.5 shrink-0",
                    guess.correct
                      ? "text-success"
                      : guess.partial
                        ? "text-warning"
                        : "text-muted-foreground"
                  )}
                  role="img"
                  aria-label={label}
                />
              </motion.li>
            );
          })}
        </motion.ol>
      ) : (
        <p className="rounded-md border border-dashed px-2 py-3 text-center text-xs text-muted-foreground">
          没有出手
        </p>
      )}
    </div>
  );
}

/**
 * 一局的复盘：答案揭晓卡加双方完整猜测。局间展示刚结束的那一局（答案卡按揭晓动效亮相），
 * 结算页逐局回看时不再重播揭晓。
 */
export function RankedGameRecap({
  game,
  reveal = false,
}: {
  game: CEERankedGameSummary;
  reveal?: boolean;
}) {
  return (
    <section aria-label={`第 ${game.number} 局复盘`} className="space-y-3">
      <h3 className="font-serif text-lg font-semibold">{rankedGameHeadline(game)}</h3>
      <CEEAnswerCard answer={game.answer} sealed={reveal} />
      <div className="grid gap-3 sm:grid-cols-2">
        <GuessList title="你的猜测" guesses={game.guesses} />
        <GuessList title="对手的猜测" guesses={game.opponentGuesses} />
      </div>
    </section>
  );
}
