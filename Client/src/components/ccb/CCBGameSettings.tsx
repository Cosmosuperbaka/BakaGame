import { useId, useMemo, useRef, useState } from "react";
import { BookOpen, Download, Search, Swords, Upload, X } from "lucide-react";
import { parseCCBSettings, type CCBSettings } from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { SettingsAccordion } from "@/components/common/room/SettingsAccordion";
import { SettingSelect, SettingStepper, SettingSwitchRow } from "@/components/common/room/SettingFields";
import { useAutoSave } from "@/hooks/UseAutoSave";
import { useCCBAction } from "@/hooks/UseCCBAction";
import { ccbErrorMessage, useCCBStore } from "@/stores/UseCCBStore";
import { ccbPresets } from "./CCBPresets";
import { CCBSearch } from "./CCBSearch";

const CATEGORIES = ["", "全部", "游戏", "书籍", "三次元", "TV", "Galgame", "WEB", "OVA", "剧场版", "动态漫画", "其他"];
const SOURCES = ["", "原创", "漫画改", "游戏改", "小说改"];
const GENRES = ["", "科幻", "喜剧", "百合", "校园", "惊悚", "后宫", "机战", "悬疑", "恋爱", "奇幻", "推理", "运动", "耽美", "音乐", "战斗", "冒险", "萌系", "穿越", "玄幻", "乙女", "恐怖", "历史", "日常", "剧情", "武侠", "美食", "职场"];
const META_TAGS = [
  { label: "作品分类", values: CATEGORIES, all: "全部动画" },
  { label: "作品来源", values: SOURCES, all: "全部来源" },
  { label: "作品题材", values: GENRES, all: "全部题材" },
] as const;
/** 玩法配置文件的大小上限：正常配置只有几 KB，拒绝异常大的文件。 */
const SETTINGS_FILE_LIMIT = 100_000;
const MAX_ADDED_SUBJECTS = 500;

/**
 * 房主的题目与猜测设置。两个折叠面板共用一份草稿、一条防抖自动保存：
 * 分开保存会让后保存的一方用旧值覆盖另一方的修改。只在等待阶段保存，开局后丢弃未提交的草稿。
 * 使用 Bangumi 目录时，目录必须先同步入库才允许保存（服务端只从已落库的成员出题）。
 */
export function CCBGameSettings({ settings, waiting }: { settings: CCBSettings; waiting: boolean }) {
  const [draft, setDraft] = useState(() => structuredClone(settings));
  const [presetName, setPresetName] = useState("");
  const indexFieldId = useId();
  const [questionOpen, setQuestionOpen] = useState(false);
  const [guessOpen, setGuessOpen] = useState(false);
  const [syncedIndexId, setSyncedIndexId] = useState(settings.useIndex ? settings.indexId : null);
  const [directoryNotice, setDirectoryNotice] = useState("");
  const [fileError, setFileError] = useState("");
  const upload = useRef<HTMLInputElement>(null);
  const { run, pending } = useCCBAction();
  const presets = useMemo(() => ccbPresets(), []);
  const change = <K extends keyof CCBSettings>(key: K, value: CCBSettings[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const validation =
    draft.startYear > draft.endYear ? "起始年份不能晚于结束年份"
      : draft.useIndex && !draft.indexId ? "请填写 Bangumi 目录编号"
        : draft.useIndex && draft.indexId !== syncedIndexId ? "目录需要先同步，同步后自动保存"
          : "";

  useAutoSave(draft, (value) => useCCBStore.getState().sendCommand("ccb.room.settings", { settings: value }), {
    enabled: waiting && !validation,
    onError: (error) => useCCBStore.getState().setNotice(ccbErrorMessage(error)),
  });

  const syncDirectory = async (indexId: number) => {
    const result = await run("ccb.directory.import", { indexId });
    if (!result) return;
    setSyncedIndexId(indexId);
    setDirectoryNotice(`已同步 ${result.subjectIds.length} 部作品${result.missingSubjectIds.length ? `，缺失 ${result.missingSubjectIds.length} 部` : ""}`);
  };
  const applyPreset = (name: string) => {
    const next = structuredClone(presets[name]);
    setDraft(next); setPresetName(name); setFileError(""); setDirectoryNotice("");
    if (next.useIndex && next.indexId) void syncDirectory(next.indexId);
  };
  const exportSettings = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "ccb-settings.json"; anchor.click();
    URL.revokeObjectURL(url);
  };
  const importSettings = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > SETTINGS_FILE_LIMIT) throw new Error("配置文件过大");
      setDraft(parseCCBSettings(JSON.parse(await file.text()) as unknown));
      setPresetName(""); setFileError("");
    } catch (failure) { setFileError(ccbErrorMessage(failure)); }
  };
  const setMetaTag = (index: number, value: string) =>
    change("metaTags", [0, 1, 2].map((position) => (position === index ? value : draft.metaTags[position] ?? "")));
  const setHint = (index: number, value: number) =>
    change("useHints", [0, 1, 2].map((position) => (position === index ? value : draft.useHints[position] ?? 0)));
  const scopedByDirectory = draft.useIndex;

  return (
    <div className="space-y-5">
      <SettingsAccordion icon={BookOpen} title="题目设置" open={questionOpen} onOpenChange={setQuestionOpen}>
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-40 flex-1">
              <SettingSelect label="玩法预设" value={presetName} onChange={(name) => { if (name) applyPreset(name); }}
                options={[{ value: "", label: "选择预设" }, ...Object.keys(presets).map((name) => ({ value: name, label: name }))]} />
            </div>
            <Button variant="outline" size="sm" onClick={exportSettings}><Download />导出</Button>
            <Button variant="outline" size="sm" onClick={() => upload.current?.click()}><Upload />导入</Button>
            <input ref={upload} type="file" accept="application/json,.json" aria-label="导入玩法配置" className="hidden"
              onChange={(event) => { void importSettings(event.target.files?.[0]); event.target.value = ""; }} />
          </div>
          {fileError ? <p role="alert" className="text-xs text-destructive">{fileError}</p> : null}
          <SettingStepper label="起始年份" value={draft.startYear} minimum={1900} maximum={2200} disabled={scopedByDirectory} onChange={(value) => change("startYear", value)} />
          <SettingStepper label="结束年份" value={draft.endYear} minimum={1900} maximum={2200} disabled={scopedByDirectory} onChange={(value) => change("endYear", value)} />
          <SettingStepper label="热度前几部" value={draft.topNSubjects} minimum={1} maximum={1000} step={5} disabled={scopedByDirectory} onChange={(value) => change("topNSubjects", value)} />
          <SettingSwitchRow label="按年榜抽题" description="每年各取热度前几部，而不是整段年份合并排名。" checked={draft.useSubjectPerYear} onCheckedChange={(value) => change("useSubjectPerYear", value)} />
          <SettingSwitchRow label="仅主角" checked={draft.mainCharacterOnly} onCheckedChange={(value) => change("mainCharacterOnly", value)} />
          <SettingStepper label="每部候选角色数" value={draft.characterNum} minimum={1} maximum={100} onChange={(value) => change("characterNum", value)} />
          <div className="grid gap-3 sm:grid-cols-3">
            {META_TAGS.map((tag, index) => (
              <SettingSelect key={tag.label} label={tag.label} value={draft.metaTags[index] ?? ""} onChange={(value) => setMetaTag(index, value)}
                options={tag.values.map((value) => ({ value, label: value || tag.all }))} />
            ))}
          </div>
          <SettingSwitchRow label="使用 Bangumi 目录" description="开启后只从目录中的作品出题，年份与热度范围不再生效。" checked={draft.useIndex} onCheckedChange={(value) => change("useIndex", value)} />
          {draft.useIndex ? (
            <div className="grid gap-1.5">
              <Label htmlFor={indexFieldId} className="text-xs">目录编号</Label>
              <div className="flex gap-2">
                <Input id={indexFieldId} inputMode="numeric" value={draft.indexId ?? ""} placeholder="Bangumi 目录编号"
                  onChange={(event) => { const value = Number(event.target.value); change("indexId", event.target.value && Number.isInteger(value) && value > 0 ? value : null); }} />
                <Button variant="outline" loading={pending.has("ccb.directory.import")} disabled={!draft.indexId}
                  onClick={() => { if (draft.indexId) void syncDirectory(draft.indexId); }}>同步目录</Button>
              </div>
              {directoryNotice ? <p role="status" className="text-xs text-muted-foreground">{directoryNotice}</p> : null}
            </div>
          ) : null}
          <div className="space-y-2">
            <p className="text-xs font-medium">追加作品（{draft.addedSubjects.length}）</p>
            {draft.addedSubjects.length ? (
              <div className="flex flex-wrap gap-2">
                {draft.addedSubjects.map((id) => (
                  <Button key={id} variant="secondary" size="sm" aria-label={`移除作品 ${id}`}
                    onClick={() => change("addedSubjects", draft.addedSubjects.filter((value) => value !== id))}>#{id}<X /></Button>
                ))}
              </div>
            ) : null}
            <CCBSearch subjectsOnly allowSubjects disabled={draft.addedSubjects.length >= MAX_ADDED_SUBJECTS}
              onSelect={(subject) => change("addedSubjects", [...new Set([...draft.addedSubjects, subject.id])])} />
          </div>
        </div>
      </SettingsAccordion>

      <SettingsAccordion icon={Search} title="猜测设置" open={guessOpen} onOpenChange={setGuessOpen}>
        <div className="space-y-4">
          <SettingStepper label="猜测次数" value={draft.maxAttempts} minimum={1} maximum={100} onChange={(value) => change("maxAttempts", value)} />
          <SettingStepper label="每次行动限时" description="设为 0 表示不限行动时间。" unit="秒" value={draft.timeLimit} minimum={0} maximum={120} step={10}
            onChange={(value) => change("timeLimit", value)} />
          <SettingSwitchRow label="允许搜索作品" description="关闭后猜题者只能按角色名搜索。" checked={draft.subjectSearch} onCheckedChange={(value) => change("subjectSearch", value)} />
          <SettingStepper label="作品标签数" value={draft.subjectTagNum} minimum={0} maximum={10} onChange={(value) => change("subjectTagNum", value)} />
          <SettingStepper label="角色标签数" value={draft.characterTagNum} minimum={0} maximum={10} onChange={(value) => change("characterTagNum", value)} />
          <SettingSwitchRow label="显示常见标签" checked={draft.commonTags} onCheckedChange={(value) => change("commonTags", value)} />
          <div className="space-y-3">
            <p className="text-2xs text-muted-foreground">文本提示在剩余次数降到设定值时出现，0 为关闭，按从大到小填写。</p>
            {[0, 1, 2].map((index) => (
              <SettingStepper key={index} label={`第 ${index + 1} 条提示`} value={draft.useHints[index] ?? 0} minimum={0} maximum={draft.maxAttempts}
                onChange={(value) => setHint(index, value)} />
            ))}
            <SettingStepper label="图片提示" value={draft.useImageHint} minimum={0} maximum={draft.maxAttempts} onChange={(value) => change("useImageHint", value)} />
          </div>
          <div className="space-y-3 border-t pt-4">
            <p className="flex items-center gap-2 text-xs font-medium"><Swords className="h-3.5 w-3.5 text-muted-foreground" />玩法规则</p>
            <SettingSwitchRow label="同步模式" description="每轮所有人都提交后再统一判定。" checked={draft.syncMode} onCheckedChange={(value) => change("syncMode", value)} />
            <SettingSwitchRow label="血战模式" description="有人猜中后继续，直到所有人结束。" checked={draft.nonstopMode} onCheckedChange={(value) => change("nonstopMode", value)} />
            <SettingSwitchRow label="角色全局 BP" description="别人猜过的角色不能再猜。" checked={draft.globalPick} onCheckedChange={(value) => change("globalPick", value)} />
            <SettingSwitchRow label="标签全局 BP" description="已被发现的标签对其他人隐藏。" checked={draft.tagBan} onCheckedChange={(value) => change("tagBan", value)} />
          </div>
        </div>
      </SettingsAccordion>

      {validation ? <p role="alert" className="text-xs text-destructive">{validation}</p> : null}
    </div>
  );
}
