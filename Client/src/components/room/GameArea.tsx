import { useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sunrise } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useGameStore } from "@/stores/useGameStore";
import { backdrop, phaseSwap, spring } from "@/lib/motion";
import { WaitingPhase } from "@/components/game/WaitingPhase";
import { AssignQuestionerPhase } from "@/components/game/AssignQuestionerPhase";
import { WordSubmissionPhase } from "@/components/game/WordSubmissionPhase";
import { DescriptionPhase } from "@/components/game/DescriptionPhase";
import { VotingPhase } from "@/components/game/VotingPhase";
import { NightPhase } from "@/components/game/NightPhase";
import { BlankGuessButton, BlankGuessWaiting } from "@/components/game/BlankGuessPhase";
import { GameOverPhase } from "@/components/game/GameOverPhase";
import { TestController } from "@/components/game/TestController";

export function GameArea({ wordRevealed = false }: { wordRevealed?: boolean }) {
  const snapshot = useGameStore((s) => s.snapshot);
  const daybreakNotice = useGameStore((s) => s.daybreakNotice);
  const isTestRoom = snapshot?.testMode ?? false;
  const phaseRef = useRef<HTMLDivElement>(null);

  if (!snapshot) return null;

  const phase = snapshot.status.phase;

  return (
    <div className={`relative flex h-full flex-col overflow-hidden${isTestRoom ? " pb-16" : ""}`}>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-6 md:p-8">
          {/* 阶段切换：进入从略小放大，退出向外轻胀，形成前后层次感。
              动画结束后清掉 transform，避免残留的分数缩放让文本子像素抖动。 */}
          <AnimatePresence mode="wait">
            <motion.div
              key={phase}
              variants={phaseSwap}
              initial="initial"
              animate="animate"
              exit="exit"
              onAnimationComplete={(definition) => {
                if (definition !== "animate") return;
                const node = phaseRef.current;
                if (node) node.style.transform = "";
              }}
              ref={phaseRef}
              style={{ willChange: "transform, opacity" }}
            >
              <PhaseContent />
            </motion.div>
          </AnimatePresence>
        </div>
      </ScrollArea>

      {isTestRoom && <TestController />}
      <BlankGuessButton />

      {/* 揭词背板。词语本体由 RoomPage 的 AssignedWord 承担，
          此处只压暗底层内容，让注意力先落在词语上。 */}
      <AnimatePresence>
        {wordRevealed && (
          <motion.div
            key="reveal-backdrop"
            variants={backdrop}
            initial="initial"
            animate="animate"
            exit="exit"
            className="pointer-events-none absolute inset-0 z-50 bg-panel/90 backdrop-blur-sm"
          />
        )}
      </AnimatePresence>

      {/* 天亮提示：日出图标自下升起，与"天亮"语义一致 */}
      <AnimatePresence>
        {daybreakNotice && (
          <motion.div
            variants={backdrop}
            initial="initial"
            animate="animate"
            exit="exit"
            className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-background/90 backdrop-blur-sm"
          >
            <div className="text-center">
              <motion.span
                className="block"
                initial={{ y: 18, scale: 0.85 }}
                animate={{ y: 0, scale: 1 }}
                transition={spring.swift}
              >
                <Sunrise className="mx-auto h-14 w-14 text-amber-500" />
              </motion.span>
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
