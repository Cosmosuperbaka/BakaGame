import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { HelpCircle, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useGameStore } from "@/stores/useGameStore";

/**
 * 白板猜词浮动按钮：悬浮在游戏区右下角，随时可触发。
 * 只要白板角色还未猜词且游戏未结束，该按钮始终可见。
 */
export function BlankGuessButton() {
  const privateState = useGameStore((s) => s.privateState);
  const phase = useGameStore((s) => s.snapshot?.status.phase);
  const sendCommand = useGameStore((s) => s.sendCommand);
  const addToast = useGameStore((s) => s.addToast);

  const [open, setOpen] = useState(false);
  const [wordA, setWordA] = useState("");
  const [wordB, setWordB] = useState("");

  const canGuess =
    (privateState?.canSubmitBlankGuess ?? false) &&
    !(privateState?.blankGuessUsed ?? false) &&
    phase !== "gameOver";

  const handleSubmit = useCallback(async () => {
    if (!wordA.trim() || !wordB.trim()) {
      addToast("请输入两个词语", "error");
      return;
    }
    try {
      await sendCommand("game.submitBlankGuess", { words: [wordA.trim(), wordB.trim()] });
      setOpen(false);
      setWordA("");
      setWordB("");
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    }
  }, [wordA, wordB, sendCommand, addToast]);

  if (!canGuess) return null;

  return (
    <>
      {/* 浮动触发按钮，始终可见 */}
      <div className="absolute bottom-4 right-4 z-10">
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 border-amber-400/50 text-amber-600 bg-background hover:bg-amber-50 dark:hover:bg-amber-950/30 shadow-sm"
          onClick={() => setOpen(true)}
        >
          <HelpCircle className="h-3.5 w-3.5" />
          猜词
        </Button>
      </div>

      {/* 猜词弹层 */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="absolute inset-0 z-20 bg-background/90 backdrop-blur-sm flex items-center justify-center"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className="bg-card border rounded-xl p-6 shadow-lg max-w-sm w-full mx-4 space-y-4"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <HelpCircle className="h-4 w-4 text-amber-500" />
                  <h3 className="font-semibold text-base">白板猜词</h3>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setOpen(false)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                请猜出好人阵营和卧底阵营的词语，不需要区分顺序。
              </p>
              <div className="space-y-2">
                <Input
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
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  取消
                </Button>
                <Button onClick={handleSubmit} className="gap-2">
                  <Send className="h-4 w-4" />
                  提交猜测
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/** 白板猜词阶段等待提示（供非白板玩家看到） */
export function BlankGuessWaiting() {
  const snapshot = useGameStore((s) => s.snapshot)!;
  const blankGuessPlayerId = snapshot.status.blankGuessPlayerId;
  const guesserName =
    snapshot.players.find((p) => p.id === blankGuessPlayerId)?.name ?? "白板";

  return (
    <div className="text-center space-y-3 py-8 max-w-md mx-auto">
      <HelpCircle className="h-14 w-14 mx-auto text-amber-400/60" />
      <h2 className="text-xl font-semibold">白板猜词</h2>
      <p className="text-sm text-muted-foreground">
        等待 <span className="font-medium text-foreground">{guesserName}</span> 猜出两个词语...
      </p>
    </div>
  );
}
