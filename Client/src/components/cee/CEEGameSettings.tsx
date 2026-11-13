import { useMemo, useState } from "react";
import equal from "fast-deep-equal";
import { ShieldCheck } from "lucide-react";
import type { CEESettings, CEESource } from "@bakagame/shared";
import { SettingsAccordion } from "@/components/common/room/SettingsAccordion";
import { SettingValue, SettingsSection } from "@/components/common/room/settings/Layout";
import { useAutoSave } from "@/hooks/UseAutoSave";
import { useCEEAction } from "@/hooks/UseCEEAction";
import { saveRoomSettingsMemory } from "@/lib/RoomSettingsMemory";
import { ceeErrorMessage, useCEEStore } from "@/stores/UseCEEStore";
import { ceePresets } from "./CEEPresets";
import { waitingSnapshotOf } from "./CEEWaitingSave";
import { CEEGuessPanel } from "./CEEGuessPanel";
import { CEEQuestionPanel } from "./CEEQuestionPanel";
import { SETTINGS_FILE_LIMIT } from "./CEESettingOptions";
import { settingsValidationMessage, summaries } from "./CEESettingsRules";
import { useCEEDraft } from "./UseCEEDraft";
import { useCEESubjectNames } from "./UseCEESubjectNames";

/**
 * 题目与猜测设置。两个折叠面板共用一份草稿、一条防抖自动保存：分开保存会让后保存的一方用旧值覆盖另一方的修改。
 * 只在等待阶段保存，开局后丢弃未提交的草稿。使用 Bangumi 目录时，目录必须先同步入库才允许保存（服务端只从已落库的成员出题）。
 * 非房主看到同一份结构（`readOnly`），读的是当前设置；预设、导入导出与目录同步这些房主工具不出现。
 */
export function CEEGameSettings({
  roomId,
  settings,
  source,
  waiting,
  readOnly = false,
}: {
  /** 草稿所属的房间：保存时核对它仍是当前房间。 */
  roomId: string;
  settings: CEESettings;
  source: CEESource;
  waiting: boolean;
  readOnly?: boolean;
}) {
  const { draft, setDraft, epoch } = useCEEDraft(settings, !readOnly);
  const [presetName, setPresetName] = useState("");
  const [antiCheatOpen, setAntiCheatOpen] = useState(false);
  const [questionOpen, setQuestionOpen] = useState(false);
  const [guessOpen, setGuessOpen] = useState(false);
  // 目录同步是本机动作；草稿重置为服务端值后，已同步的目录也回到服务端当前的那一个。
  const [syncedIndex, setSyncedIndex] = useState<{ epoch: number; id: number } | null>(null);
  const serverIndexId = settings.useIndex ? settings.indexId : null;
  const syncedIndexId = syncedIndex?.epoch === epoch ? syncedIndex.id : serverIndexId;
  const [directoryNotice, setDirectoryNotice] = useState("");
  const [fileError, setFileError] = useState("");
  const { run, pending } = useCEEAction();
  const presets = useMemo(() => ceePresets(), []);
  const values = readOnly ? settings : draft;
  const subjects = useCEESubjectNames(values.addedSubjects);
  const change = <K extends keyof CEESettings>(key: K, value: CEESettings[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const validation = readOnly ? "" : settingsValidationMessage(draft, syncedIndexId);

  useAutoSave(
    draft,
    (value) => {
      // MCP 是独立设置项，不随玩法设置记忆；保存时保留服务端当前的开关，避免旧草稿把它改回去。
      const room = waitingSnapshotOf(roomId);
      if (!room) return Promise.resolve();
      const live = room.settings;
      const next = { ...value, allowAgents: live.allowAgents === true };
      // 草稿被重置为服务端当前值后与之相同，没有要保存的内容，不再原样写一遍。
      if (equal(next, live)) return Promise.resolve();
      saveRoomSettingsMemory("cee", { settings: { ...value, allowAgents: false } });
      return useCEEStore.getState().sendCommand("cee.room.settings", { settings: next });
    },
    {
      enabled: !readOnly && waiting && !validation,
      onError: (error) => useCEEStore.getState().reportError(error),
    }
  );

  const syncDirectory = async (indexId: number) => {
    const result = await run("cee.directory.import", { indexId });
    if (!result) return;
    setSyncedIndex({ epoch, id: indexId });
    setDirectoryNotice(
      `已同步 ${result.subjectIds.length} 部作品${result.missingSubjectIds.length ? `，缺失 ${result.missingSubjectIds.length} 部` : ""}`
    );
  };
  const applyPreset = (name: string) => {
    // 预设只换玩法规则，出题方式是房主对这间房的选择，原样保留。
    const next = { ...structuredClone(presets[name]), answerMode: draft.answerMode };
    setDraft(next);
    setPresetName(name);
    setFileError("");
    setDirectoryNotice("");
    if (next.useIndex && next.indexId) void syncDirectory(next.indexId);
  };
  const exportSettings = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" })
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "cee-settings.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const importSettings = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > SETTINGS_FILE_LIMIT) throw new Error("配置文件过大");
      // 设置文件按 schema 校验，校验库只在真正导入文件时才加载，不进首屏包。
      const { parseCEESettings } = await import("@bakagame/shared");
      setDraft(parseCEESettings(JSON.parse(await file.text()) as unknown));
      setPresetName("");
      setFileError("");
    } catch (failure) {
      setFileError(ceeErrorMessage(failure));
    }
  };
  const summary = summaries(values);
  /**
   * 反作弊由**建房那一刻**决定：面板只显示结果，不给开关。中途开关会让同一间房里的人
   * 按不同口径准入（旁观审批、断线重连的规则都会错位），服务端也把这四位锁在房里的现值上
   * （`CEERooms.applySettings`），这里根本没有可改的入口。
   */
  const antiCheatOn = settings.bakaAntiCheat === true;

  return (
    <>
      {source === "native" && antiCheatOn ? (
        <SettingsAccordion
          icon={ShieldCheck}
          title="反作弊"
          summary={summary.antiCheat}
          readOnly
          open={antiCheatOpen}
          onOpenChange={setAntiCheatOpen}
        >
          <div>
            <SettingsSection>
              <SettingValue
                label="BakaAntiCheat"
                value="已开启"
                description="建房时决定，之后不可修改：只接受 BakaGame 客户端接入、全员需登录、旁观要房主批准。"
              />
            </SettingsSection>
          </div>
        </SettingsAccordion>
      ) : null}

      <CEEQuestionPanel
        values={values}
        draft={draft}
        setDraft={setDraft}
        change={change}
        readOnly={readOnly}
        summary={summary.question}
        open={questionOpen}
        onOpenChange={setQuestionOpen}
        subjects={subjects}
        directoryNotice={directoryNotice}
        syncDirectory={syncDirectory}
        pending={pending}
        presets={presets}
        presetName={presetName}
        fileError={fileError}
        applyPreset={applyPreset}
        exportSettings={exportSettings}
        importSettings={(file) => void importSettings(file)}
      />

      <CEEGuessPanel
        values={values}
        draft={draft}
        change={change}
        readOnly={readOnly}
        summary={summary.guess}
        open={guessOpen}
        onOpenChange={setGuessOpen}
      />

      {validation ? (
        <p role="alert" className="text-xs text-destructive">
          {validation}
        </p>
      ) : null}
    </>
  );
}
