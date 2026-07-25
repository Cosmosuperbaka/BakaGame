import { useState, useCallback, useEffect } from "react";
import { Send, PenTool, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useGame } from "@/contexts/GameContext";
import type { PlayerRole } from "@/types";

export function WordSubmissionPhase() {
  const { state, sendCommand, addToast } = useGame();
  const snapshot = state.snapshot!;
  const privateState = state.privateState;
  const isQuestioner = privateState?.isQuestioner ?? false;

  const [wordA, setWordA] = useState("");
  const [wordB, setWordB] = useState("");
  const [blankHint, setBlankHint] = useState("");
  const [useManualRoles, setUseManualRoles] = useState(false);

  const roleConfig = snapshot.settings.roleConfig;
  const hasBlank = roleConfig.hasBlank;
  const hasAngel = roleConfig.hasAngel;

  const participants = snapshot.players.filter(
    (p) => p.membership === "active" && p.id !== snapshot.status.questionerPlayerId
  );

  const [manualRoles, setManualRoles] = useState<Record<string, PlayerRole>>({});

  useEffect(() => {
    if (useManualRoles && participants.length > 0) {
      const initial: Record<string, PlayerRole> = {};
      participants.forEach((p, idx) => {
        if (idx < roleConfig.undercoverCount) {
          initial[p.id] = "undercover";
        } else if (hasBlank && idx === roleConfig.undercoverCount) {
          initial[p.id] = "blank";
        } else if (hasAngel && idx === roleConfig.undercoverCount + (hasBlank ? 1 : 0)) {
          initial[p.id] = "angel";
        } else {
          initial[p.id] = "civilian";
        }
      });
      setManualRoles(initial);
    }
  }, [useManualRoles, participants.length, roleConfig.undercoverCount, hasBlank, hasAngel]);

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
        manualRoles: useManualRoles ? manualRoles : undefined,
      });
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    }
  }, [wordA, wordB, blankHint, hasBlank, useManualRoles, manualRoles, sendCommand, addToast]);

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
    <div className="flex flex-col items-center gap-8 py-8 max-w-md mx-auto">
      <div className="text-center">
        <h2 className="text-2xl font-semibold mb-2">提交词语</h2>
        <p className="text-base text-muted-foreground">
          请输入两个相近的词语（不需要区分哪个是平民词/卧底词）
        </p>
      </div>

      <div className="w-full space-y-5">
        <div className="space-y-2">
          <Label>词语 A</Label>
          <Input
            value={wordA}
            onChange={(e) => setWordA(e.target.value)}
            placeholder="输入第一个词语"
            maxLength={20}
            className="h-10"
          />
        </div>
        <div className="space-y-2">
          <Label>词语 B</Label>
          <Input
            value={wordB}
            onChange={(e) => setWordB(e.target.value)}
            placeholder="输入第二个词语"
            maxLength={20}
            className="h-10"
          />
        </div>
        {hasBlank && (
          <div className="space-y-2">
            <Label>白板提示</Label>
            <Input
              value={blankHint}
              onChange={(e) => setBlankHint(e.target.value)}
              placeholder="给白板的提示（如：水果）"
              maxLength={20}
              className="h-10"
            />
          </div>
        )}

        {/* 自定义角色分配 */}
        <div className="pt-2 border-t space-y-3">
          <div className="flex items-center justify-between py-1">
            <div className="flex items-center gap-2">
              <UserCheck className="h-4 w-4 text-primary" />
              <Label className="text-sm font-medium cursor-pointer">自定义指定每人身份</Label>
            </div>
            <Switch checked={useManualRoles} onCheckedChange={setUseManualRoles} />
          </div>

          {useManualRoles && (
            <div className="space-y-2 bg-muted/30 p-3 rounded-lg border text-sm">
              <p className="text-xs text-muted-foreground mb-2">
                需设置：{roleConfig.undercoverCount} 卧底
                {hasAngel ? "、1 天使" : ""}
                {hasBlank ? "、1 白板" : ""}
              </p>
              {participants.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-2 py-1">
                  <span className="font-medium truncate max-w-[120px]">{p.name}</span>
                  <select
                    value={manualRoles[p.id] ?? "civilian"}
                    onChange={(e) =>
                      setManualRoles((prev) => ({
                        ...prev,
                        [p.id]: e.target.value as PlayerRole,
                      }))
                    }
                    className="h-8 rounded-md border bg-background px-2 text-xs"
                  >
                    <option value="civilian">平民</option>
                    <option value="undercover">卧底</option>
                    {hasAngel && <option value="angel">天使</option>}
                    {hasBlank && <option value="blank">白板</option>}
                  </select>
                </div>
              ))}
            </div>
          )}
        </div>

        <Button className="w-full gap-2 h-10" onClick={handleSubmit}>
          <Send className="h-4 w-4" />
          提交并开始
        </Button>
      </div>
    </div>
  );
}
