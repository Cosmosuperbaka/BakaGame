import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { Flag, Lightbulb, LogOut } from "lucide-react";
import type { CEERankedSeriesView } from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { useSecondsLeft } from "@/hooks/UseSecondsLeft";
import { bannerRise, dropIn, readoutTick } from "@/lib/Motion";
import { CEEFeedbackTable } from "../CEEFeedbackTable";
import { CEESearch } from "../CEESearch";
import { CEERankedOpponentClues } from "./CEERankedOpponentClues";

/** 退出整场是判负的操作：显式确认，取消在前、确认用危险色。 */
function ExitDialog({
  open,
  busy,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>退出这场排位？</DialogTitle>
          <DialogDescription>
            退出即判负整场，排位分按输掉这场结算。只想放弃当前这一局，用「认输本局」。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            继续比赛
          </Button>
          <Button variant="destructive" loading={busy} onClick={onConfirm}>
            退出并判负
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 读秒：局号与秒数居中，秒数每次换一个节点顶上来。 */
function GameCountdown({ number, startsAt }: { number: number; startsAt: number }) {
  const seconds = useSecondsLeft(startsAt);
  return (
    <motion.div
      variants={dropIn}
      initial="initial"
      animate="animate"
      exit="exit"
      className="flex flex-col items-center gap-2 rounded-md border border-dashed py-10"
      role="status"
    >
      <span className="font-serif text-lg font-semibold">第 {number} 局即将开始</span>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={seconds}
          initial={readoutTick.initial}
          animate={readoutTick.animate}
          transition={readoutTick.transition}
          className="font-mono text-4xl tabular-nums"
        >
          {seconds}
        </motion.span>
      </AnimatePresence>
      <span className="text-xs text-muted-foreground">双方猜同一个角色，先猜中者得分</span>
    </motion.div>
  );
}

/**
 * 进行中的一局：左边是本人的搜索与反馈表，右边是对手的脱敏线索。
 * 加时公开的提示从上方横幅落下；认输只放弃本局，退出整场要二次确认。
 */
export function CEERankedMatch({
  series,
  pending,
  onGuess,
  onSurrender,
  onExit,
}: {
  series: CEERankedSeriesView;
  pending: { surrender?: boolean; exit?: boolean };
  onGuess: (characterId: number) => Promise<boolean>;
  onSurrender: () => void;
  onExit: () => void;
}) {
  const [exitOpen, setExitOpen] = useState(false);
  const game = series.game;
  if (!game) return null;
  const playing = game.phase === "playing" || game.phase === "overtime";
  const canGuess = playing && !series.self.finished;
  return (
    <div className="space-y-3">
      <AnimatePresence initial={false}>
        {game.hints.length ? (
          <motion.div
            key="hints"
            variants={bannerRise}
            initial="initial"
            animate="animate"
            exit="exit"
            className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
            role="status"
          >
            <Lightbulb className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
            <span>
              <span className="font-medium">加时提示：</span>
              {game.hints.join("；")}
            </span>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <section aria-label="你的猜测" className="min-w-0 space-y-3">
          <AnimatePresence initial={false} mode="popLayout">
            {game.phase === "countdown" ? (
              <GameCountdown key="countdown" number={game.number} startsAt={game.startsAt} />
            ) : (
              <motion.div
                key={`play-${game.number}`}
                variants={dropIn}
                initial="initial"
                animate="animate"
                className="space-y-3"
              >
                <CEESearch
                  allowSubjects
                  disabled={!canGuess}
                  bannedIds={game.guesses.map((guess) => guess.character.id)}
                  onSelect={(character) => onGuess(character.id)}
                  trailing={
                    <Button
                      type="button"
                      variant="outline"
                      className="h-10 px-3"
                      disabled={!playing || series.self.finished}
                      loading={Boolean(pending.surrender)}
                      onClick={onSurrender}
                    >
                      <Flag aria-hidden="true" />
                      认输本局
                    </Button>
                  }
                />
                {series.self.finished && playing ? (
                  <p className="text-sm text-muted-foreground" role="status">
                    你的次数已用完，等对手出手或等待加时
                  </p>
                ) : null}
                <CEEFeedbackTable key={game.number} guesses={game.guesses} />
              </motion.div>
            )}
          </AnimatePresence>
        </section>
        <aside className="min-w-0 space-y-3">
          <CEERankedOpponentClues
            key={game.number}
            guesses={game.opponentGuesses}
            attempts={series.opponent.attempts}
            allowance={series.opponent.allowance}
          />
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => setExitOpen(true)}
          >
            <LogOut aria-hidden="true" />
            退出这场
          </Button>
        </aside>
      </div>
      <ExitDialog
        open={exitOpen}
        busy={Boolean(pending.exit)}
        onOpenChange={setExitOpen}
        onConfirm={onExit}
      />
    </div>
  );
}
