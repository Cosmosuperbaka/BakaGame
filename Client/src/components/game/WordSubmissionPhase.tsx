import { useState, useCallback, useEffect } from "react";
import { Send, PenTool, Dices } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useGameStore } from "@/stores/useGameStore";
import type { PlayerRole } from "@/types";

export function WordSubmissionPhase() {
  const snapshot = useGameStore((s) => s.snapshot)!;
  const privateState = useGameStore((s) => s.privateState);
  const sendCommand = useGameStore((s) => s.sendCommand);
  const addToast = useGameStore((s) => s.addToast);
  const isQuestioner = privateState?.isQuestioner ?? false;

  const [civilianWord, setCivilianWord] = useState("");
  const [undercoverWord, setUndercoverWord] = useState("");
  const [blankHint, setBlankHint] = useState("");

  // 默认启用随机分配身份
  const [isRandomRole, setIsRandomRole] = useState(true);

  const roleConfig = snapshot.settings.roleConfig;
  const hasBlank = roleConfig.hasBlank;
  const hasAngel = roleConfig.hasAngel;

  const participants = snapshot.players.filter(
    (p) => p.membership === "active" && p.id !== snapshot.status.questionerPlayerId
  );

  const [manualRoles, setManualRoles] = useState<Record<string, PlayerRole>>({});

  useEffect(() => {
    if (!isRandomRole && participants.length > 0) {
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
  }, [isRandomRole, participants.length, roleConfig.undercoverCount, hasBlank, hasAngel]);

  const handleSubmit = useCallback(async () => {
    if (!civilianWord.trim() || !undercoverWord.trim()) {
      addToast("请输入平民词和卧底词", "error");
      return;
    }
    if (hasBlank && !blankHint.trim()) {
      addToast("开启白板时需填写提示", "error");
      return;
    }
    try {
      await sendCommand("game.submitWords", {
        words: [civilianWord.trim(), undercoverWord.trim()],
        blankHint: hasBlank ? blankHint.trim() : undefined,
        manualRoles: isRandomRole ? undefined : manualRoles,
      });
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    }
  }, [civilianWord, undercoverWord, blankHint, hasBlank, isRandomRole, manualRoles, sendCommand, addToast]);

  if (!isQuestioner) {
    return (
      <div className="flex flex-col items-center gap-5 py-16 text-center">
        <PenTool className="h-14 w-14 text-muted-foreground/30" />
        <div>
          <h2 className="text-xl font-semibold">等待出题</h2>
          <p className="text-sm text-muted-foreground mt-1">出题人正在提交本局词语...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-6 py-6 max-w-md mx-auto">
      <div className="text-center">
        <h2 className="text-xl font-semibold">提交词语</h2>
        <p className="text-sm text-muted-foreground mt-1">
          请分别指定【平民词】与【卧底词】
        </p>
      </div>

      <div className="w-full space-y-4">
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold text-emerald-600 dark:text-emerald-500">平民词</Label>
          <Input
            value={civilianWord}
            onChange={(e) => setCivilianWord(e.target.value)}
            placeholder="输入平民获得的词语"
            maxLength={20}
            className="h-10"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold text-rose-600 dark:text-rose-500">卧底词</Label>
          <Input
            value={undercoverWord}
            onChange={(e) => setUndercoverWord(e.target.value)}
            placeholder="输入卧底获得的词语"
            maxLength={20}
            className="h-10"
          />
        </div>
        {hasBlank && (
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-slate-600 dark:text-slate-400">白板提示</Label>
            <Input
              value={blankHint}
              onChange={(e) => setBlankHint(e.target.value)}
              placeholder="给白板玩家的分类提示"
              maxLength={20}
              className="h-10"
            />
          </div>
        )}

        {/* 随机/自定义分配身份 */}
        <div className="pt-3 border-t space-y-3">
          <div className="flex items-center justify-between py-1">
            <div className="flex items-center gap-2">
              <Dices className="h-4 w-4 text-primary" />
              <Label className="text-sm font-medium cursor-pointer">随机分配身份</Label>
            </div>
            <Switch checked={isRandomRole} onCheckedChange={setIsRandomRole} />
          </div>

          {!isRandomRole && (
            <div className="space-y-2 bg-card p-3 rounded-lg border text-sm shadow-2xs">
              <div className="text-xs text-muted-foreground font-medium mb-1">
                指定身份（{roleConfig.undercoverCount} 卧底{hasAngel ? "、1 天使" : ""}{hasBlank ? "、1 白板" : ""}）
              </div>
              {participants.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-2 py-1">
                  <span className="font-medium text-xs truncate max-w-[130px]">{p.name}</span>
                  <select
                    value={manualRoles[p.id] ?? "civilian"}
                    onChange={(e) =>
                      setManualRoles((prev) => ({
                        ...prev,
                        [p.id]: e.target.value as PlayerRole,
                      }))
                    }
                    className="h-7 rounded border bg-background px-2 text-xs"
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

        <Button className="w-full gap-2 h-10 mt-2" onClick={handleSubmit}>
          <Send className="h-4 w-4" />
          确认提交
        </Button>
      </div>
    </div>
  );
}
