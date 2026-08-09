import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CircleHelp, Gavel, HelpCircle, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { duration, ease, spring } from "@/lib/motion";
import { useGameStore } from "@/stores/useGameStore";
import { PhaseHeader } from "@/components/game/PhaseHeader";
import { PendingSpeech } from "@/components/game/PendingSpeech";
import type { BlankGuessReason } from "@/types";

/** 草稿推送节流：逐字广播会把每次按键都变成一次往返。 */
const DRAFT_PUSH_DELAY_MS = 220;

/** 进入猜词的原因，向全房说明这次打断从何而来。 */
const REASON_TEXT: Record<BlankGuessReason, string> = {
  active: "白板主动发起猜词",
  eliminated: "白板被淘汰后猜词",
  finale: "游戏即将结束，白板仍存活",
};

/**
 * 白板猜词入口。猜词只有一次机会且会打断全场，
 * 因此点击后先确认，再由服务端把房间切进阻塞阶段。
 */
export function BlankGuessButton() {
  const privateState = useGameStore((s) => s.privateState);
  const phase = useGameStore((s) => s.snapshot?.status.phase);
  const sendCommand = useGameStore((s) => s.sendCommand);
  const addToast = useGameStore((s) => s.addToast);
  const [confirming, setConfirming] = useState(false);

  // 已在猜词阶段时入口收起，界面交给下面的输入组件。
  const canEnter =
    (privateState?.canSubmitBlankGuess ?? false) &&
    !(privateState?.blankGuessUsed ?? false) &&
    phase !== "gameOver" &&
    phase !== "blankGuess";

  const handleEnter = useCallback(async () => {
    try {
      await sendCommand("game.enterBlankGuess");
      setConfirming(false);
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    }
  }, [sendCommand, addToast]);

  if (!canEnter) return null;

  return (
    <>
      {/* 固定在游戏区右上角，避开底部阶段控制器。 */}
      <div className="absolute right-3 top-3 z-30 md:right-5 md:top-5">
        <Button size="lg" className="gap-2 shadow-md" onClick={() => setConfirming(true)}>
          <HelpCircle className="h-4 w-4" />
          白板猜词
        </Button>
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>发起白板猜词？</DialogTitle>
            <DialogDescription>
              全场会立刻暂停下来等你猜词，你输入的内容所有人都能实时看到。
              机会只有一次，用掉后无论对错都不能再猜。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              再想想
            </Button>
            <Button onClick={handleEnter} className="gap-2">
              <HelpCircle className="h-4 w-4" />
              进入猜词
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** 白板本人的猜词界面。输入过程实时广播给全房。 */
function BlankGuessInput() {
  const snapshot = useGameStore((s) => s.snapshot)!;
  const sendCommand = useGameStore((s) => s.sendCommand);
  const addToast = useGameStore((s) => s.addToast);
  const [wordA, setWordA] = useState("");
  const [wordB, setWordB] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const pushTimer = useRef<number | undefined>(undefined);
  const pendingReview = snapshot.status.blankGuessPendingReview ?? false;

  // 节流推送草稿：让其他人看到进展，又不至于逐键往返。
  useEffect(() => {
    if (pendingReview) return;
    pushTimer.current = window.setTimeout(() => {
      void sendCommand("game.updateBlankGuessDraft", { words: [wordA, wordB] }).catch(() => {
        // 草稿推送失败不影响正式提交，静默即可。
      });
    }, DRAFT_PUSH_DELAY_MS);
    return () => window.clearTimeout(pushTimer.current);
  }, [wordA, wordB, pendingReview, sendCommand]);

  const handleSubmit = useCallback(async () => {
    if (!wordA.trim() || !wordB.trim()) {
      addToast("请输入两个词语", "error");
      return;
    }
    setSubmitting(true);
    try {
      await sendCommand("game.submitBlankGuess", { words: [wordA.trim(), wordB.trim()] });
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    } finally {
      setSubmitting(false);
    }
  }, [wordA, wordB, sendCommand, addToast]);

  if (pendingReview) {
    return (
      <div className="mx-auto max-w-md space-y-5">
        <PhaseHeader icon={Gavel} title="等待主持人裁定" iconClassName="text-amber-600" />
        <GuessReadout words={snapshot.status.blankGuessDraft} submitted />
        <p className="text-center text-sm text-muted-foreground">
          你的猜测与答案不完全一致，正在由主持人判断是否算作猜中。
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-5">
      <PhaseHeader icon={CircleHelp} title="白板猜词" iconClassName="text-amber-600" />
      <p className="text-center text-sm text-muted-foreground">
        猜出两个词，不分顺序。全场都能看到你的输入，机会只有一次。
      </p>
      <div className="space-y-2">
        <Input
          autoFocus
          value={wordA}
          onChange={(e) => setWordA(e.target.value)}
          placeholder="词语 A"
          maxLength={20}
          className="h-10"
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
        />
        <Input
          value={wordB}
          onChange={(e) => setWordB(e.target.value)}
          placeholder="词语 B"
          maxLength={20}
          className="h-10"
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
        />
      </div>
      <div className="flex justify-center">
        <Button
          size="lg"
          className="gap-2 px-6"
          onClick={handleSubmit}
          disabled={submitting || !wordA.trim() || !wordB.trim()}
        >
          <Send className="h-4 w-4" />
          {submitting ? "提交中…" : "提交猜测"}
        </Button>
      </div>
    </div>
  );
}

/** 猜词内容的实时读数。空格子留占位，读作「还在写」。 */
function GuessReadout({
  words,
  submitted,
}: {
  words?: [string, string];
  submitted?: boolean;
}) {
  const cells = [words?.[0] ?? "", words?.[1] ?? ""];

  return (
    <div className="grid grid-cols-2 gap-2">
      {cells.map((word, index) => (
        <div
          key={index}
          className="flex min-h-11 items-center justify-center rounded-md border bg-muted px-4 py-2 text-base font-semibold"
        >
          {/* 内容随输入替换，用 mode="wait" 让读数逐次落位而不是叠加 */}
          <AnimatePresence mode="wait" initial={false}>
            {word ? (
              <motion.span
                key={word}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0, transition: spring.swift }}
                exit={{ opacity: 0, transition: { duration: duration.instant, ease: ease.inOut } }}
              >
                {word}
              </motion.span>
            ) : (
              <motion.span
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: { duration: duration.instant } }}
              >
                {submitted ? (
                  <span className="text-sm font-normal text-muted-foreground">未填写</span>
                ) : (
                  <PendingSpeech label="正在输入" />
                )}
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      ))}
    </div>
  );
}

/**
 * 其他玩家看到的白板猜词阶段：谁在猜、为什么猜、猜到哪一步，
 * 以及猜错时由主持人做一次裁定。
 */
export function BlankGuessWaiting() {
  const snapshot = useGameStore((s) => s.snapshot)!;
  const privateState = useGameStore((s) => s.privateState);
  const sendCommand = useGameStore((s) => s.sendCommand);
  const addToast = useGameStore((s) => s.addToast);
  const [reviewing, setReviewing] = useState(false);

  const status = snapshot.status;
  const guesser = snapshot.players.find((player) => player.id === status.blankGuessPlayerId);
  const pendingReview = status.blankGuessPendingReview ?? false;
  const isQuestioner = privateState?.isQuestioner ?? false;
  const words = privateState?.globalWords;

  const handleReview = useCallback(
    async (approve: boolean) => {
      setReviewing(true);
      try {
        await sendCommand("game.reviewBlankGuess", { approve });
      } catch (e) {
        addToast((e as { message: string }).message, "error");
      } finally {
        setReviewing(false);
      }
    },
    [sendCommand, addToast],
  );

  return (
    <div className="mx-auto max-w-md space-y-5">
      <PhaseHeader
        icon={pendingReview ? Gavel : CircleHelp}
        title={pendingReview ? "白板猜词 · 待裁定" : "白板猜词"}
        iconClassName="text-amber-600"
      />

      <div className="space-y-1 text-center">
        <p className="text-sm font-medium text-foreground">
          {guesser ? `${guesser.name} 正在猜词` : "白板正在猜词"}
        </p>
        {status.blankGuessReason ? (
          <p className="text-xs text-muted-foreground">{REASON_TEXT[status.blankGuessReason]}</p>
        ) : null}
      </div>

      <GuessReadout words={status.blankGuessDraft} submitted={pendingReview} />

      {pendingReview ? (
        <div className="space-y-3">
          <p className="text-center text-sm text-muted-foreground">
            猜测与答案不完全一致，等待主持人裁定。
          </p>
          {/* 真实词对只发给主持人与旁观者，普通玩家看不到这块 */}
          {isQuestioner && words ? (
            <>
              <div className="rounded-md border bg-muted px-4 py-2.5 text-center text-sm">
                <span className="text-muted-foreground">真实词对：</span>
                <span className="font-semibold">
                  {words.civilianWord} / {words.undercoverWord}
                </span>
              </div>
              <div className="flex justify-center gap-3">
                <Button
                  variant="outline"
                  disabled={reviewing}
                  onClick={() => handleReview(false)}
                  className="gap-2"
                >
                  判定错误
                </Button>
                <Button disabled={reviewing} onClick={() => handleReview(true)} className="gap-2">
                  <Gavel className="h-4 w-4" />
                  算作正确
                </Button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 猜词阶段的分派：本人进输入界面，其余人看等待与裁定界面。 */
export function BlankGuessStage() {
  const myId = useGameStore((s) => s.privateState?.playerId);
  const guesserId = useGameStore((s) => s.snapshot?.status.blankGuessPlayerId);

  return myId && myId === guesserId ? <BlankGuessInput /> : <BlankGuessWaiting />;
}
