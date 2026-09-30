import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sunrise } from "lucide-react";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { backdrop, spring } from "@/lib/Motion";
import { PhaseStage } from "@/components/common/room/PhaseStage";
import { WaitingPhase } from "../phases/WaitingPhase";
import { AssignQuestionerPhase } from "../phases/AssignQuestionerPhase";
import { WordSubmissionPhase } from "../phases/WordSubmissionPhase";
import { DescriptionPhase } from "../phases/DescriptionPhase";
import { VotingPhase } from "../phases/VotingPhase";
import { NightPhase } from "../phases/NightPhase";
import { BlankGuessButton, BlankGuessStage } from "../phases/BlankGuessPhase";
import { GameOverPhase } from "../phases/GameOverPhase";
import { PhaseTimerControl } from "./PhaseTimerControl";
import { TestController } from "./TestController";

export function GameArea({ wordRevealed = false }: { wordRevealed?: boolean }) {
  const snapshot = useWhoIsFakerStore((s) => s.snapshot);
  const daybreakNotice = useWhoIsFakerStore((s) => s.daybreakNotice);
  const isTestRoom = snapshot?.testMode ?? false;
  const [wordDraft, setWordDraft] = useState({ civilianWord: "", undercoverWord: "", blankHint: "" });

  if (!snapshot) return null;

  const phase = snapshot.status.phase;

  return (
    <PhaseStage
      phaseKey={phase}
      reserveBottom={isTestRoom}
      before={<PhaseTimerControl className="mx-auto max-w-2xl mb-6" />}
      onPhaseSettled={() => {
        // 回到等待阶段时清空上一局的出题草稿，避免下一局沿用旧词。
        if (phase === "waiting") setWordDraft({ civilianWord: "", undercoverWord: "", blankHint: "" });
      }}
      overlays={<>
        {isTestRoom ? <TestController /> : null}
        <BlankGuessButton />

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
                  initial={{ y: 18, scale: 0.85 }}
                  animate={{ y: 0, scale: 1 }}
                  transition={spring.swift}
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
