import { motion, AnimatePresence } from "framer-motion";
import { ScrollArea } from "@/components/ui/scroll-area";
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

export function GameArea() {
  const snapshot = useGameStore((s) => s.snapshot);
  const isTestRoom = snapshot?.testMode ?? false;

  if (!snapshot) return null;

  const phase = snapshot.status.phase;

  return (
    <div className="relative flex flex-col h-full overflow-hidden">
      <ScrollArea className="flex-1">
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

      {/* 测试房间专用：底部悬浮控制器 */}
      {isTestRoom && <TestController />}

      {/* 白板猜词浮动按钮（仅白板角色可见，始终可触发） */}
      <BlankGuessButton />
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
    case "daybreak":
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
