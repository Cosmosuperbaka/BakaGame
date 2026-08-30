import { useState, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Send, PenLine, Dices } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Switch } from "@/components/ui/Switch";
import { collapsible, spring, tappable } from "@/lib/Motion";
import { useWhoIsFakerStore as useGameStore } from "@/stores/UseWhoIsFakerStore";
import { cn } from "@/lib/Utils";
import type { PlayerRole } from "@/types";

const ROLE_SHORT_LABELS: Record<PlayerRole, string> = {
  civilian: "民",
  undercover: "卧",
  angel: "天",
  blank: "白",
};

const ROLE_FULL_LABELS: Record<PlayerRole, string> = {
  civilian: "平民",
  undercover: "卧底",
  angel: "天使",
  blank: "白板",
};

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

  const availableRoles: PlayerRole[] = [
    "civilian",
    "undercover",
    ...(hasAngel ? (["angel"] as PlayerRole[]) : []),
    ...(hasBlank ? (["blank"] as PlayerRole[]) : []),
  ];
  const requiredRoleCounts: Record<PlayerRole, number> = {
    civilian:
      participants.length - roleConfig.undercoverCount - (hasAngel ? 1 : 0) - (hasBlank ? 1 : 0),
    undercover: roleConfig.undercoverCount,
    angel: hasAngel ? 1 : 0,
    blank: hasBlank ? 1 : 0,
  };
  const assignedRoleCounts = Object.values(manualRoles).reduce<Record<PlayerRole, number>>(
    (counts, assignedRole) => ({
      ...counts,
      [assignedRole]: counts[assignedRole] + 1,
    }),
    { civilian: 0, undercover: 0, angel: 0, blank: 0 },
  );
  const manualRoleCountsValid = availableRoles.every(
    (availableRole) => assignedRoleCounts[availableRole] === requiredRoleCounts[availableRole],
  );

  const handleRandomRoleChange = (randomRole: boolean) => {
    setIsRandomRole(randomRole);
    if (randomRole) return;

    const initialRoles: Record<string, PlayerRole> = {};
    participants.forEach((participant, index) => {
      if (index < roleConfig.undercoverCount) {
        initialRoles[participant.id] = "undercover";
      } else if (hasBlank && index === roleConfig.undercoverCount) {
        initialRoles[participant.id] = "blank";
      } else if (
        hasAngel &&
        index === roleConfig.undercoverCount + (hasBlank ? 1 : 0)
      ) {
        initialRoles[participant.id] = "angel";
      } else {
        initialRoles[participant.id] = "civilian";
      }
    });
    setManualRoles(initialRoles);
  };

  const handleSubmit = useCallback(async () => {
    if (!civilianWord.trim() || !undercoverWord.trim()) {
      addToast("请输入平民词和卧底词", "error");
      return;
    }
    if (hasBlank && !blankHint.trim()) {
      addToast("开启白板时需填写提示", "error");
      return;
    }
    if (!isRandomRole && !manualRoleCountsValid) {
      addToast("手动身份数量与房间配置不一致", "error");
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
  }, [civilianWord, undercoverWord, blankHint, hasBlank, isRandomRole, manualRoles, manualRoleCountsValid, sendCommand, addToast]);

  if (!isQuestioner) {
    return (
      <div className="flex flex-col items-center">
        <PhaseHeader
          icon={PenLine}
          title="等待出题"
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-6">
      <PhaseHeader
        icon={PenLine}
        title="提交词语"
      />

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
            <Switch checked={isRandomRole} onCheckedChange={handleRandomRoleChange} />
          </div>

          <AnimatePresence initial={false}>
          {!isRandomRole && (
            <motion.div
              variants={collapsible}
              initial="initial"
              animate="animate"
              exit="exit"
              className="overflow-hidden rounded-md border bg-background text-sm"
            >
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-b bg-muted/35 px-3 py-2.5 sm:grid-cols-4">
                {availableRoles.map((availableRole) => {
                  const valid =
                    assignedRoleCounts[availableRole] === requiredRoleCounts[availableRole];
                  return (
                    <div key={availableRole} className="flex items-center justify-between gap-2 text-xs">
                      <span className="text-muted-foreground">{ROLE_FULL_LABELS[availableRole]}</span>
                      <span className={cn("font-semibold tabular-nums", valid ? "text-foreground" : "text-destructive")}>
                        {assignedRoleCounts[availableRole]}/{requiredRoleCounts[availableRole]}
                      </span>
                    </div>
                  );
                })}
              </div>
              {participants.map((p) => (
                <div key={p.id} className="flex min-h-11 items-center justify-between gap-3 border-b px-3 py-2 last:border-b-0">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{p.name}</span>
                  <div className="inline-grid grid-flow-col gap-0.5 rounded-md border bg-muted/30 p-0.5" role="group" aria-label={`为 ${p.name} 分配身份`}>
                    {availableRoles.map((availableRole) => {
                      const selected = (manualRoles[p.id] ?? "civilian") === availableRole;
                      return (
                        <motion.button
                          key={availableRole}
                          type="button"
                          {...tappable}
                          title={ROLE_FULL_LABELS[availableRole]}
                          aria-label={ROLE_FULL_LABELS[availableRole]}
                          aria-pressed={selected}
                          onClick={() =>
                            setManualRoles((previousRoles) => ({
                              ...previousRoles,
                              [p.id]: availableRole,
                            }))
                          }
                          className={cn(
                            "relative flex h-7 w-8 cursor-pointer items-center justify-center rounded-md text-xs font-semibold transition-colors",
                            selected
                              ? "text-background"
                              : "text-muted-foreground hover:bg-background hover:text-foreground",
                          )}
                        >
                          {/* 选中底块在同组内滑动，读作同一个指示器在移动 */}
                          {selected ? (
                            <motion.span
                              layoutId={`manual-role-${p.id}`}
                              transition={spring.snap}
                              className="absolute inset-0 rounded-md bg-foreground shadow-sm"
                            />
                          ) : null}
                          <span className="relative">{ROLE_SHORT_LABELS[availableRole]}</span>
                        </motion.button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </motion.div>
          )}
          </AnimatePresence>
        </div>

        <Button
          className="w-full gap-2 h-10 mt-2"
          onClick={handleSubmit}
          disabled={!isRandomRole && !manualRoleCountsValid}
        >
          <Send className="h-4 w-4" />
          确认提交
        </Button>
      </div>
    </div>
  );
}
