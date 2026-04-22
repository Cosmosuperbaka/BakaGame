import { useState, useCallback } from "react";
import { motion } from "framer-motion";
import { HelpCircle, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useGame } from "@/contexts/GameContext";

export function BlankGuessPhase() {
  const { state, sendCommand, addToast } = useGame();
  const snapshot = state.snapshot!;
  const privateState = state.privateState;
  const blankGuessPlayerId = snapshot.status.blankGuessPlayerId;
  const isBlankGuesser = privateState?.playerId === blankGuessPlayerId;

  const [wordA, setWordA] = useState("");
  const [wordB, setWordB] = useState("");

  const handleSubmit = useCallback(async () => {
    if (!wordA.trim() || !wordB.trim()) {
      addToast("请输入两个词语", "error");
      return;
    }
    try {
      await sendCommand("game.submitBlankGuess", { words: [wordA.trim(), wordB.trim()] });
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    }
  }, [wordA, wordB, sendCommand, addToast]);

  const guesserName = snapshot.players.find((p) => p.id === blankGuessPlayerId)?.name ?? "白板";

  return (
    <div className="space-y-6 max-w-md mx-auto">
      <div className="text-center">
        <HelpCircle className="h-16 w-16 mx-auto mb-3 text-muted-foreground/40" />
        <h2 className="text-2xl font-semibold">白板猜词</h2>
        <p className="text-base text-muted-foreground mt-1">
          {isBlankGuesser
            ? "请猜出好人阵营和卧底阵营的词语（不需要区分顺序）"
            : `等待 ${guesserName} 猜词...`}
        </p>
      </div>

      {isBlankGuesser && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="space-y-5"
        >
          <div className="space-y-2">
            <Label>词语 A</Label>
            <Input value={wordA} onChange={(e) => setWordA(e.target.value)} placeholder="输入第一个词语" maxLength={20} className="h-10" />
          </div>
          <div className="space-y-2">
            <Label>词语 B</Label>
            <Input value={wordB} onChange={(e) => setWordB(e.target.value)} placeholder="输入第二个词语" maxLength={20} className="h-10" />
          </div>
          <Button className="w-full gap-2 h-10" onClick={handleSubmit}>
            <Send className="h-4 w-4" /> 提交猜测
          </Button>
        </motion.div>
      )}
    </div>
  );
}
