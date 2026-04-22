import { useState, useCallback } from "react";
import { Send, PenTool } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useGame } from "@/contexts/GameContext";

export function WordSubmissionPhase() {
  const { state, sendCommand, addToast } = useGame();
  const snapshot = state.snapshot!;
  const privateState = state.privateState;
  const isQuestioner = privateState?.isQuestioner ?? false;

  const [wordA, setWordA] = useState("");
  const [wordB, setWordB] = useState("");
  const [blankHint, setBlankHint] = useState("");

  const hasBlank = snapshot.settings.roleConfig.hasBlank;

  const handleSubmit = useCallback(async () => {
    if (!wordA.trim() || !wordB.trim()) {
      addToast("请输入两个词语", "error");
      return;
    }
    if (hasBlank && !blankHint.trim()) {
      addToast("有白板时需要提供提示", "error");
      return;
    }
    try {
      await sendCommand("game.submitWords", {
        words: [wordA.trim(), wordB.trim()],
        blankHint: hasBlank ? blankHint.trim() : undefined,
      });
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    }
  }, [wordA, wordB, blankHint, hasBlank, sendCommand, addToast]);

  if (!isQuestioner) {
    return (
      <div className="flex flex-col items-center gap-6 py-16">
        <PenTool className="h-16 w-16 text-muted-foreground/40" />
        <h2 className="text-2xl font-semibold">等待出题</h2>
        <p className="text-base text-muted-foreground">出题人正在提交词语...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-8 py-10 max-w-md mx-auto">
      <div className="text-center">
        <h2 className="text-2xl font-semibold mb-2">提交词语</h2>
        <p className="text-base text-muted-foreground">
          请输入两个相近的词语（不需要区分哪个是平民词/卧底词）
        </p>
      </div>

      <div className="w-full space-y-5">
        <div className="space-y-2">
          <Label>词语 A</Label>
          <Input value={wordA} onChange={(e) => setWordA(e.target.value)} placeholder="输入第一个词语" maxLength={20} className="h-10" />
        </div>
        <div className="space-y-2">
          <Label>词语 B</Label>
          <Input value={wordB} onChange={(e) => setWordB(e.target.value)} placeholder="输入第二个词语" maxLength={20} className="h-10" />
        </div>
        {hasBlank && (
          <div className="space-y-2">
            <Label>白板提示</Label>
            <Input value={blankHint} onChange={(e) => setBlankHint(e.target.value)} placeholder="给白板的提示（如：水果）" maxLength={20} className="h-10" />
          </div>
        )}
        <Button className="w-full gap-2 h-10" onClick={handleSubmit}>
          <Send className="h-4 w-4" />
          提交
        </Button>
      </div>
    </div>
  );
}
