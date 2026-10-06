import { usePhaseAction } from "./UsePhaseAction";
import { useState, useCallback, useId } from "react";
import { Send, PenLine, Dices } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { CollapsibleRegion } from "@/components/ui/Collapsible";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/SegmentedControl";
import { SettingSwitchRow, SettingTextField } from "@/components/common/room/SettingFields";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { cn } from "@/lib/Utils";
import type { WhoIsFakerRole } from "@/types";

const ROLE_FULL_LABELS: Record<WhoIsFakerRole, string> = {
  civilian: "平民",
  undercover: "卧底",
  angel: "天使",
  blank: "白板",
};

type WordDraft = { civilianWord: string; undercoverWord: string; blankHint: string };

export function WordSubmissionPhase({ wordDraft, onWordDraftChange }: { wordDraft: WordDraft; onWordDraftChange: (draft: WordDraft) => void }) {
  const snapshot = useWhoIsFakerStore((s) => s.snapshot)!;
  const privateState = useWhoIsFakerStore((s) => s.privateState);
  const sendCommand = useWhoIsFakerStore((s) => s.sendCommand);
  const addToast = useWhoIsFakerStore((s) => s.addToast);
  const action = usePhaseAction();
  const { run, busy } = action;
  const isQuestioner = privateState?.isQuestioner ?? false;

  const { civilianWord, undercoverWord, blankHint } = wordDraft;
  const setCivilianWord = (value: string) => onWordDraftChange({ ...wordDraft, civilianWord: value });
  const setUndercoverWord = (value: string) => onWordDraftChange({ ...wordDraft, undercoverWord: value });
  const setBlankHint = (value: string) => onWordDraftChange({ ...wordDraft, blankHint: value });

  // 默认启用随机分配身份
  const [isRandomRole, setIsRandomRole] = useState(true);
  const roleCountId = useId();

  const roleConfig = snapshot.settings.roleConfig;
  const hasBlank = roleConfig.hasBlank;
  const hasAngel = roleConfig.hasAngel;

  const participants = snapshot.players.filter(
    (p) => p.membership === "active" && p.id !== snapshot.status.questionerPlayerId
  );

  const [manualRoles, setManualRoles] = useState<Record<string, WhoIsFakerRole>>({});

  const availableRoles: WhoIsFakerRole[] = [
    "civilian",
    "undercover",
    ...(hasAngel ? (["angel"] as WhoIsFakerRole[]) : []),
    ...(hasBlank ? (["blank"] as WhoIsFakerRole[]) : []),
  ];
  const requiredRoleCounts: Record<WhoIsFakerRole, number> = {
    civilian:
      participants.length - roleConfig.undercoverCount - (hasAngel ? 1 : 0) - (hasBlank ? 1 : 0),
    undercover: roleConfig.undercoverCount,
    angel: hasAngel ? 1 : 0,
    blank: hasBlank ? 1 : 0,
  };
  const assignedRoleCounts = Object.values(manualRoles).reduce<Record<WhoIsFakerRole, number>>(
    (counts, assignedRole) => ({
      ...counts,
      [assignedRole]: counts[assignedRole] + 1,
    }),
    { civilian: 0, undercover: 0, angel: 0, blank: 0 },
  );
  const manualRoleCountsValid = availableRoles.every(
    (availableRole) => assignedRoleCounts[availableRole] === requiredRoleCounts[availableRole],
  );
  const roleOptions: SegmentedOption<WhoIsFakerRole>[] = availableRoles.map((availableRole) => ({
    value: availableRole,
    label: ROLE_FULL_LABELS[availableRole],
  }));

  const handleRandomRoleChange = (randomRole: boolean) => {
    setIsRandomRole(randomRole);
    if (randomRole) return;

    const initialRoles: Record<string, WhoIsFakerRole> = {};
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

  // 能落到字段的校验写在该字段下（aria-invalid + 错误文案），点过一次提交后才显示，填上即消失。
  const [attempted, setAttempted] = useState(false);
  const fieldErrors = {
    civilian: attempted && !civilianWord.trim() ? "请输入平民词" : null,
    undercover: attempted && !undercoverWord.trim() ? "请输入卧底词" : null,
    blank: attempted && hasBlank && !blankHint.trim() ? "开启白板时需填写提示" : null,
  };

  const handleSubmit = useCallback(async () => {
    if (!civilianWord.trim() || !undercoverWord.trim() || (hasBlank && !blankHint.trim())) {
      setAttempted(true);
      return;
    }
    if (!isRandomRole && !manualRoleCountsValid) {
      addToast("手动身份数量与房间配置不一致", "error");
      return;
    }
    await run(async () => {
    try {
      await sendCommand("game.submitWords", {
        words: [civilianWord.trim(), undercoverWord.trim()],
        blankHint: hasBlank ? blankHint.trim() : undefined,
        manualRoles: isRandomRole ? undefined : manualRoles,
      });
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    }
    });
  }, [run, civilianWord, undercoverWord, blankHint, hasBlank, isRandomRole, manualRoles, manualRoleCountsValid, sendCommand, addToast]);

  if (!isQuestioner) {
    const questioner = snapshot.players.find((p) => p.id === snapshot.status.questionerPlayerId);
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-2">
        <PhaseHeader icon={PenLine} title="等待出题" />
        <p className="text-center text-sm text-muted-foreground">
          {questioner ? `${questioner.name} 正在出题` : "主持人正在出题"}
        </p>
      </div>
    );
  }

  const manualRolesInvalid = !isRandomRole && !manualRoleCountsValid;

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-6">
      <PhaseHeader icon={PenLine} title="提交词语" />

      <div className="w-full space-y-4">
        <SettingTextField
          label="平民词"
          value={civilianWord}
          onChange={setCivilianWord}
          placeholder="输入平民获得的词语"
          maxLength={20}
          error={fieldErrors.civilian}
        />
        <SettingTextField
          label="卧底词"
          value={undercoverWord}
          onChange={setUndercoverWord}
          placeholder="输入卧底获得的词语"
          maxLength={20}
          error={fieldErrors.undercover}
        />
        {hasBlank ? (
          <SettingTextField
            label="白板提示"
            value={blankHint}
            onChange={setBlankHint}
            placeholder="给白板玩家的分类提示"
            maxLength={20}
            error={fieldErrors.blank}
          />
        ) : null}

        {/* 随机/自定义分配身份 */}
        <div className="space-y-3 border-t pt-4">
          <SettingSwitchRow
            label="随机分配身份"
            icon={Dices}
            checked={isRandomRole}
            onCheckedChange={handleRandomRoleChange}
          />

          <CollapsibleRegion open={!isRandomRole}>
            <div className="overflow-hidden rounded-md border bg-background text-sm">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-b bg-muted/40 px-3 py-2.5 sm:grid-cols-4">
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
              {/* 数量不符时提交按钮禁用，原因就写在这里，并经 aria-describedby 挂到按钮上 */}
              {manualRolesInvalid ? (
                <p id={roleCountId} className="border-b px-3 py-2 text-xs text-destructive">
                  各身份数量需与房间配置一致
                </p>
              ) : null}
              {participants.map((p) => (
                <div key={p.id} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2 last:border-b-0">
                  <span title={p.name} className="min-w-0 flex-1 basis-20 truncate text-xs font-medium">{p.name}</span>
                  <SegmentedControl
                    size="sm"
                    aria-label={`为 ${p.name} 分配身份`}
                    className="ml-auto w-auto"
                    value={manualRoles[p.id] ?? "civilian"}
                    options={roleOptions}
                    onValueChange={(availableRole) =>
                      setManualRoles((previousRoles) => ({ ...previousRoles, [p.id]: availableRole }))
                    }
                  />
                </div>
              ))}
            </div>
          </CollapsibleRegion>
        </div>

        <Button
          size="lg"
          className="w-full"
          onClick={() => void handleSubmit()}
          loading={busy}
          disabled={manualRolesInvalid}
          aria-describedby={manualRolesInvalid ? roleCountId : undefined}
        >
          {busy ? null : <Send className="h-4 w-4" />}
          确认提交
        </Button>
      </div>
    </div>
  );
}
