import { motion, AnimatePresence } from "framer-motion";
import { Sunrise } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useGameStore } from "@/stores/useGameStore";
import { WaitingPhase } from "@/components/game/WaitingPhase";
import { AssignQuestionerPhase } from "@/components/game/AssignQuestionerPhase";
import { WordSubmissionPhase } from "@/components/game/WordSubmissionPhase";
import { DescriptionPhase } from "@/components/game/DescriptionPhase";
import { VotingPhase } from "@/components/game/VotingPhase";
import { NightPhase } from "@/components/game/NightPhase";
import { BlankGuessButton, BlankGuessWaiting } from "@/components/game/BlankGuessPhase";
import { GameOverPhase } from "@/components/game/GameOverPhase";
import { TestController } from "@/components/game/TestController";

export function GameArea({ wordRevealText }: { wordRevealText?: string }) {
  const snapshot = useGameStore((s) => s.snapshot);
  const daybreakNotice = useGameStore((s) => s.daybreakNotice);
  const isTestRoom = snapshot?.testMode ?? false;

  if (!snapshot) return null;

  const phase = snapshot.status.phase;

  return (
    <div className={cn("relative flex h-full flex-col overflow-hidden", isTestRoom && "pb-16")}>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-6 md:p-8">
          <AnimatePresence mode="wait">
            <motion.div
              key={phase}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
            >
              <PhaseContent />
            </motion.div>
          </AnimatePresence>
        </div>
      </ScrollArea>

      {/* 特殊房间使用的底部悬浮阶段控制器 */}
      {isTestRoom && <TestController />}

      {/* 白板猜词浮动按钮（仅白板角色可见，始终可触发） */}
      <BlankGuessButton />

      {wordRevealText ? (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-card/96 backdrop-blur-sm">
          <motion.span
            layoutId="assigned-word"
            transition={{ layout: { duration: 0.65, ease: [0.22, 1, 0.36, 1] } }}
            className="max-w-[80vw] rounded-md bg-muted px-8 py-5 text-center text-3xl font-bold text-foreground shadow-sm md:text-4xl"
          >
            {wordRevealText}
          </motion.span>
        </div>
      ) : null}

      <AnimatePresence>
        {daybreakNotice && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="absolute inset-0 z-40 flex items-center justify-center bg-background/94 backdrop-blur-sm pointer-events-none"
          >
            <div className="text-center">
              <Sunrise className="h-14 w-14 mx-auto text-amber-500" />
              <h2 className="mt-4 text-2xl font-semibold">天亮了</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                第 {daybreakNotice.day} 天开始
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function PhaseContent() {
  const phase = useGameStore((s) => s.snapshot?.status.phase);
  const tieBreakStage = useGameStore((s) => s.snapshot?.status.tieBreakStage);

  switch (phase) {
    case "waiting":
      return <WaitingPhase />;
    case "assigningQuestioner":
      return <AssignQuestionerPhase />;
    case "wordSubmission":
      return <WordSubmissionPhase />;
    case "description":
      return <DescriptionPhase />;
    case "tieBreak":
      return tieBreakStage === "vote" ? <VotingPhase /> : <DescriptionPhase />;
    case "voting":
      return <VotingPhase />;
    case "night":
      return <NightPhase />;
    case "blankGuess":
      // 白板猜词阶段：白板玩家使用右下角浮动按钮提交；其他玩家等待。
      return <BlankGuessWaiting />;
    case "gameOver":
      return <GameOverPhase />;
    default:
      return <div className="text-center text-muted-foreground py-12">未知阶段</div>;
  }
}
