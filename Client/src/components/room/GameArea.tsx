import { motion, AnimatePresence } from "framer-motion";
import { Sunrise } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useGameStore } from "@/stores/useGameStore";
import { phaseSwap, spring, duration } from "@/lib/motion";
import { WaitingPhase } from "@/components/game/WaitingPhase";
import { AssignQuestionerPhase } from "@/components/game/AssignQuestionerPhase";
import { WordSubmissionPhase } from "@/components/game/WordSubmissionPhase";
import { DescriptionPhase } from "@/components/game/DescriptionPhase";
import { VotingPhase } from "@/components/game/VotingPhase";
import { NightPhase } from "@/components/game/NightPhase";
import { BlankGuessButton, BlankGuessWaiting } from "@/components/game/BlankGuessPhase";
import { GameOverPhase } from "@/components/game/GameOverPhase";
import { TestController } from "@/components/game/TestController";

export function GameArea({ revealedWord }: { revealedWord?: string }) {
  const snapshot = useGameStore((s) => s.snapshot);
  const daybreakNotice = useGameStore((s) => s.daybreakNotice);
  const isTestRoom = snapshot?.testMode ?? false;

  if (!snapshot) return null;

  const phase = snapshot.status.phase;

  return (
    <div className={`relative flex h-full flex-col overflow-hidden${isTestRoom ? " pb-16" : ""}`}>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-6 md:p-8">
          {/* 阶段切换：进入从略小放大，退出向外轻胀，形成前后层次感 */}
          <AnimatePresence mode="wait">
            <motion.div
              key={phase}
              variants={phaseSwap}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              <PhaseContent />
            </motion.div>
          </AnimatePresence>
        </div>
      </ScrollArea>

      {isTestRoom && <TestController />}
      <BlankGuessButton />

      {/* 词语揭示：大号居中展示，结束后词语 chip 通过 layoutId 飞入顶栏 */}
      <AnimatePresence>
        {revealedWord && (
          <motion.div
            key="reveal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: duration.quick }}
            className="pointer-events-none absolute inset-0 z-50 bg-panel/90 backdrop-blur-sm"
          />
        )}
      </AnimatePresence>
      {revealedWord ? (
        <div className="pointer-events-none absolute inset-0 z-[51] flex items-center justify-center">
          <motion.span
            layoutId="assigned-word"
            transition={{ layout: spring.drift }}
            className="max-w-[80vw] rounded-md bg-primary/10 px-8 py-5 text-center text-3xl font-bold text-primary md:text-4xl"
          >
            {revealedWord}
          </motion.span>
        </div>
      ) : null}

      {/* 天亮提示 */}
      <AnimatePresence>
        {daybreakNotice && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-background/90 backdrop-blur-sm"
          >
            <div className="text-center">
              <Sunrise className="mx-auto h-14 w-14 text-amber-500" />
              <h2 className="mt-4 text-2xl font-semibold">天亮了</h2>
              <p className="mt-1 text-sm text-muted-foreground">第 {daybreakNotice.day} 天开始</p>
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
    case "waiting":          return <WaitingPhase />;
    case "assigningQuestioner": return <AssignQuestionerPhase />;
    case "wordSubmission":   return <WordSubmissionPhase />;
    case "description":      return <DescriptionPhase />;
    case "tieBreak":         return tieBreakStage === "vote" ? <VotingPhase /> : <DescriptionPhase />;
    case "voting":           return <VotingPhase />;
    case "night":            return <NightPhase />;
    case "blankGuess":       return <BlankGuessWaiting />;
    case "gameOver":         return <GameOverPhase />;
    default:                 return <div className="py-12 text-center text-muted-foreground">未知阶段</div>;
  }
}
