import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sunrise } from "lucide-react";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { backdrop, sunrise } from "@/lib/Motion";
import { PhaseStage } from "@/components/common/room/PhaseStage";
import { WaitingPhase } from "../phases/WaitingPhase";
import { AssignQuestionerPhase } from "../phases/AssignQuestionerPhase";
import { WordSubmissionPhase } from "../phases/WordSubmissionPhase";
import { DescriptionPhase } from "../phases/DescriptionPhase";
import { VotingPhase } from "../phases/VotingPhase";
import { NightPhase } from "../phases/NightPhase";
import { BlankGuessButton, BlankGuessStage } from "../phases/BlankGuessPhase";
import { GameOverPhase } from "../phases/GameOverPhase";
import { DisconnectHandler } from "./DisconnectHandler";
import { PhaseTimerControl } from "./PhaseTimerControl";
import { TestController } from "./TestController";

export function GameArea({ wordRevealed = false }: { wordRevealed?: boolean }) {
  const snapshot = useWhoIsFakerStore((s) => s.snapshot);
  const daybreakNotice = useWhoIsFakerStore((s) => s.daybreakNotice);
  const isTestRoom = snapshot?.testMode ?? false;
  const [wordDraft, setWordDraft] = useState({ civilianWord: "", undercoverWord: "", blankHint: "" });

  if (!snapshot) return null;

  const status = snapshot.status;
  const phase = status.phase;
  // 阶段内的子状态（补充发言、平票 PK 的描述与投票、第几次 PK、白板待裁定、换天换局）
  // 同样换掉整块内容，拼进标识里才会走 phaseSwap，而不是在原地硬切。
  const phaseKey = [
    status.roundId ?? "",
    phase,
    status.day,
    status.speechMode ?? "",
    status.tieBreakStage ?? "",
    status.tieBreakIndex ?? "",
    status.supplementIndex ?? "",
    status.blankGuessPendingReview ? "review" : "",
  ].join(":");

  return (
    <PhaseStage
      phaseKey={phaseKey}
      reserveBottom={isTestRoom}
      // 不随阶段切换的区块：掉线待决可能挂在任何进行中的阶段上，限时栏跨子阶段保留，
      // 白板猜词入口排在限时栏下方，不压在倒计时条上
      before={<>
        <DisconnectHandler />
        <PhaseTimerControl className="mx-auto mb-6 max-w-2xl" />
        <BlankGuessButton />
      </>}
      onPhaseSettled={() => {
        // 回到等待阶段时清空上一局的出题草稿，避免下一局沿用旧词。
        if (phase === "waiting") setWordDraft({ civilianWord: "", undercoverWord: "", blankHint: "" });
      }}
      overlays={<>
        {isTestRoom ? <TestController /> : null}

        {/* 揭词背板。词语本体由 RoomPage 的 AssignedWord 承担，
            此处只压暗底层内容，让注意力先落在词语上。 */}
        <AnimatePresence>
          {wordRevealed ? (
            <motion.div
              key="reveal-backdrop"
              variants={backdrop}
              initial="initial"
              animate="animate"
              exit="exit"
              className="pointer-events-none absolute inset-0 z-overlay bg-panel/90 backdrop-blur-sm"
            />
          ) : null}
        </AnimatePresence>

        {/* 天亮提示：日出图标自下升起，与"天亮"语义一致 */}
        <AnimatePresence>
          {daybreakNotice ? (
            <motion.div
              variants={backdrop}
              initial="initial"
              animate="animate"
              exit="exit"
              className="pointer-events-none absolute inset-0 z-dropdown flex items-center justify-center bg-panel/90 backdrop-blur-sm"
            >
              <div className="text-center">
                <motion.span
                  className="block"
                  {...sunrise}
                >
                  <Sunrise className="mx-auto h-14 w-14 text-warning" />
                </motion.span>
                <h2 className="mt-4 text-2xl font-semibold">天亮了</h2>
                <p className="mt-1 text-sm text-muted-foreground">第 {daybreakNotice.day} 天开始</p>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </>}
    >
      <PhaseContent wordDraft={wordDraft} onWordDraftChange={setWordDraft} />
    </PhaseStage>
  );
}

type WordDraft = { civilianWord: string; undercoverWord: string; blankHint: string };

function PhaseContent({
  wordDraft,
  onWordDraftChange,
}: {
  wordDraft: WordDraft;
  onWordDraftChange: (draft: WordDraft) => void;
}) {
  const phase = useWhoIsFakerStore((s) => s.snapshot?.status.phase);
  const tieBreakStage = useWhoIsFakerStore((s) => s.snapshot?.status.tieBreakStage);

  switch (phase) {
    case "waiting":          return <WaitingPhase />;
    case "assigningQuestioner": return <AssignQuestionerPhase />;
    case "wordSubmission":   return <WordSubmissionPhase wordDraft={wordDraft} onWordDraftChange={onWordDraftChange} />;
    case "description":      return <DescriptionPhase />;
    case "tieBreak":         return tieBreakStage === "vote" ? <VotingPhase /> : <DescriptionPhase />;
    case "voting":           return <VotingPhase />;
    case "night":            return <NightPhase />;
    case "blankGuess":       return <BlankGuessStage />;
    case "gameOver":         return <GameOverPhase />;
    default:                 return <div className="py-12 text-center text-muted-foreground">未知阶段</div>;
  }
}
