import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { History } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { useGame } from "@/contexts/GameContext";
import { WaitingPhase } from "@/components/game/WaitingPhase";
import { AssignQuestionerPhase } from "@/components/game/AssignQuestionerPhase";
import { WordSubmissionPhase } from "@/components/game/WordSubmissionPhase";
import { DescriptionPhase } from "@/components/game/DescriptionPhase";
import { VotingPhase } from "@/components/game/VotingPhase";
import { NightPhase } from "@/components/game/NightPhase";
import { BlankGuessPhase } from "@/components/game/BlankGuessPhase";
import { GameOverPhase } from "@/components/game/GameOverPhase";
import { DescriptionHistoryView } from "@/components/game/DescriptionHistory";
import { PrivateInfo } from "@/components/game/PrivateInfo";
import { TestController } from "@/components/game/TestController";

export function GameArea() {
  const { state } = useGame();
  const snapshot = state.snapshot;
  const privateState = state.privateState;
  const [showHistory, setShowHistory] = useState(false);

  if (!snapshot) return null;

  const phase = snapshot.status.phase;
  const started = snapshot.status.started;
  const isTestRoom = snapshot.testMode;

  return (
    <div className="relative flex flex-col h-full overflow-hidden">
      <ScrollArea className="flex-1">
        <div className="p-6 md:p-8">
          {/* 身份信息 + 查看描述按钮 */}
          {started && (privateState || (phase !== "waiting" && phase !== "gameOver")) && (
            <div className="flex items-center gap-3 mb-5 flex-wrap">
              {privateState && <PrivateInfo privateState={privateState} />}
              {phase !== "waiting" && phase !== "gameOver" && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setShowHistory(true)}
                >
                  <History className="h-3.5 w-3.5" />
                  查看描述
                </Button>
              )}
            </div>
          )}

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

      {/* 查看描述：覆盖整个游戏区域 */}
      <AnimatePresence>
        {showHistory && (
          <DescriptionHistoryView onClose={() => setShowHistory(false)} />
        )}
      </AnimatePresence>
    </div>
  );
}

function PhaseContent() {
  const { state } = useGame();
  const phase = state.snapshot?.status.phase;

  switch (phase) {
    case "waiting":
      return <WaitingPhase />;
    case "assigningQuestioner":
      return <AssignQuestionerPhase />;
    case "wordSubmission":
      return <WordSubmissionPhase />;
    case "description":
    case "tieBreak":
    case "daybreak":
      return <DescriptionPhase />;
    case "voting":
      return <VotingPhase />;
    case "night":
      return <NightPhase />;
    case "blankGuess":
      return <BlankGuessPhase />;
    case "gameOver":
      return <GameOverPhase />;
    default:
      return <div className="text-center text-muted-foreground py-12">未知阶段</div>;
  }
}
