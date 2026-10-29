import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { backdrop } from "@/lib/Motion";
import { PhaseStage } from "@/components/common/room/PhaseStage";
import { FakerWaitingPhase } from "../phases/FakerWaitingPhase";
import { FakerAssignQuestionerPhase } from "../phases/FakerAssignQuestionerPhase";
import { FakerWordSubmissionPhase } from "../phases/FakerWordSubmissionPhase";
import { FakerDescriptionPhase } from "../phases/FakerDescriptionPhase";
import { FakerVotingPhase } from "../phases/FakerVotingPhase";
import { FakerNightPhase } from "../phases/FakerNightPhase";
import { FakerFeedbackPhase } from "../phases/FakerFeedbackPhase";
import { BlankGuessButton, BlankGuessStage } from "../phases/FakerBlankGuessPhase";
import { FakerGameOverPhase } from "../phases/FakerGameOverPhase";
import { FakerDisconnectHandler } from "./FakerDisconnectHandler";
import { FakerPhaseTimerControl } from "./FakerPhaseTimerControl";
import { FakerTestController } from "./FakerTestController";

export function FakerGameArea({ wordRevealed = false }: { wordRevealed?: boolean }) {
  const snapshot = useWhoIsFakerStore((s) => s.snapshot);
  const isTestRoom = snapshot?.testMode ?? false;
  const [wordDraft, setWordDraft] = useState({
    civilianWord: "",
    undercoverWord: "",
    blankHint: "",
  });

  if (!snapshot) return null;

  const status = snapshot.status;
  const phase = status.phase;
  // 阶段内的子状态（补充发言、平票 PK 的描述与投票、第几次 PK、白板待裁定、反馈种类、换天换局）
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
    status.feedback?.kind ?? "",
    status.feedback?.tieBreak ? "pk" : "",
  ].join(":");

  return (
    <PhaseStage
      phaseKey={phaseKey}
      reserveBottom={isTestRoom}
      // 不随阶段切换的区块：掉线待决可能挂在任何进行中的阶段上，限时栏跨子阶段保留，
      // 白板猜词入口排在限时栏下方，不压在倒计时条上
      before={
        <>
          <FakerDisconnectHandler />
          <FakerPhaseTimerControl className="mx-auto mb-6 max-w-2xl" />
          <BlankGuessButton />
        </>
      }
      onPhaseSettled={() => {
        // 回到等待阶段时清空上一局的出题草稿，避免下一局沿用旧词。
        if (phase === "waiting")
          setWordDraft({ civilianWord: "", undercoverWord: "", blankHint: "" });
      }}
      overlays={
        <>
          {isTestRoom ? <FakerTestController /> : null}

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
        </>
      }
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
    case "waiting":
      return <FakerWaitingPhase />;
    case "assigningQuestioner":
      return <FakerAssignQuestionerPhase />;
    case "wordSubmission":
      return (
        <FakerWordSubmissionPhase wordDraft={wordDraft} onWordDraftChange={onWordDraftChange} />
      );
    case "description":
      return <FakerDescriptionPhase />;
    case "tieBreak":
      return tieBreakStage === "vote" ? <FakerVotingPhase /> : <FakerDescriptionPhase />;
    case "voting":
      return <FakerVotingPhase />;
    case "night":
      return <FakerNightPhase />;
    case "blankGuess":
      return <BlankGuessStage />;
    case "feedback":
      return <FakerFeedbackPhase />;
    case "gameOver":
      return <FakerGameOverPhase />;
    default:
      return <div className="py-12 text-center text-muted-foreground">未知阶段</div>;
  }
}
