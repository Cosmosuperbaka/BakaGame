import { useRef, useState } from "react";
import { Download, Upload, X } from "lucide-react";
import { parseCCBSettings, type CCBSettings } from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Switch } from "@/components/ui/Switch";
import { ccbErrorMessage, useCCBStore } from "@/stores/UseCCBStore";
import { useCCBAction } from "@/hooks/UseCCBAction";
import { CCBSelect } from "./CCBSelect";
import { ccbPresets } from "./CCBPresets";
import { CCBSearch } from "./CCBSearch";

const categories = ["", "全部", "游戏", "书籍", "三次元", "TV", "Galgame", "WEB", "OVA", "剧场版", "动态漫画", "其他"];
const sources = ["", "原创", "漫画改", "游戏改", "小说改"];
const genres = ["", "科幻", "喜剧", "百合", "校园", "惊悚", "后宫", "机战", "悬疑", "恋爱", "奇幻", "推理", "运动", "耽美", "音乐", "战斗", "冒险", "萌系", "穿越", "玄幻", "乙女", "恐怖", "历史", "日常", "剧情", "武侠", "美食", "职场"];
const numbers: Array<{ key: keyof Pick<CCBSettings, "startYear" | "endYear" | "topNSubjects" | "characterNum" | "maxAttempts" | "timeLimit" | "subjectTagNum" | "characterTagNum" | "useImageHint">; label: string; min: number; max: number }> = [
  { key: "startYear", label: "起始年份", min: 1900, max: 2200 }, { key: "endYear", label: "结束年份", min: 1900, max: 2200 },
  { key: "topNSubjects", label: "热度前几部", min: 1, max: 1000 }, { key: "characterNum", label: "每部候选角色数", min: 1, max: 100 },
  { key: "maxAttempts", label: "猜测次数", min: 1, max: 100 }, { key: "timeLimit", label: "行动限时（秒，0 不限）", min: 0, max: 120 },
  { key: "subjectTagNum", label: "作品标签数", min: 0, max: 10 }, { key: "characterTagNum", label: "角色标签数", min: 0, max: 10 },
  { key: "useImageHint", label: "图片提示（剩余次数，0 关闭）", min: 0, max: 100 },
];
const toggles: Array<{ key: keyof Pick<CCBSettings, "globalPick" | "tagBan" | "syncMode" | "nonstopMode" | "useSubjectPerYear" | "mainCharacterOnly" | "subjectSearch" | "commonTags" | "useIndex">; label: string }> = [
  { key: "globalPick", label: "角色全局 BP" }, { key: "tagBan", label: "标签全局 BP" },
  { key: "syncMode", label: "同步模式" }, { key: "nonstopMode", label: "血战模式" },
  { key: "useSubjectPerYear", label: "按年榜抽题" }, { key: "mainCharacterOnly", label: "仅主角" },
  { key: "subjectSearch", label: "允许搜索作品" }, { key: "commonTags", label: "显示常见标签" },
  { key: "useIndex", label: "使用 Bangumi 目录" },
];

export function CCBSettingsForm({ settings, editable, onSaved }: { settings: CCBSettings; editable: boolean; onSaved?: () => void }) {
  const [draft, setDraft] = useState(() => structuredClone(settings));
  const [preset, setPreset] = useState("");
  const [error, setError] = useState("");
  const [directoryNotice, setDirectoryNotice] = useState("");
  const upload = useRef<HTMLInputElement>(null);
  const { run, busy } = useCCBAction();
  const change = <K extends keyof CCBSettings>(key: K, value: CCBSettings[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const canEdit = editable && !busy;
  const save = async () => {
    setError("");
    try {
      const validated = parseCCBSettings(draft);
      if (validated.startYear > validated.endYear) throw new Error("起始年份不能晚于结束年份");
      if (validated.useIndex && !validated.indexId) throw new Error("请填写并导入目录编号");
      if (validated.useIndex && validated.indexId) {
        const imported = await run("ccb.directory.import", { indexId: validated.indexId });
        if (!imported) return;
        setDirectoryNotice(`已导入 ${imported.subjectIds.length} 部作品，缺失 ${imported.missingSubjectIds.length} 部`);
      }
      if (await run("ccb.room.settings", { settings: validated })) { useCCBStore.getState().setNotice("设置已保存", "success"); onSaved?.(); }
    } catch (failure) { setError(ccbErrorMessage(failure)); }
  };
  const exportSettings = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "ccb-settings.json"; anchor.click(); URL.revokeObjectURL(url);
  };
  const importSettings = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > 100_000) throw new Error("配置文件过大");
      const next = parseCCBSettings(JSON.parse(await file.text()) as unknown);
      setDraft(next); setError(""); setPreset("");
    } catch (failure) { setError(ccbErrorMessage(failure)); }
  };
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-40 flex-1"><CCBSelect label="玩法预设" value={preset} onChange={(name) => { setPreset(name); if (name) setDraft(ccbPresets()[name]); }} options={[{ value: "", label: "选择预设" }, ...Object.keys(ccbPresets()).map((name) => ({ value: name, label: name }))]} disabled={!canEdit} /></div>
      <Button variant="outline" size="sm" onClick={exportSettings}><Download />导出</Button>
      <Button variant="outline" size="sm" disabled={!canEdit} onClick={() => upload.current?.click()}><Upload />导入</Button>
      <input ref={upload} type="file" accept="application/json,.json" aria-label="导入玩法配置" className="hidden" onChange={(event) => { void importSettings(event.target.files?.[0]); event.target.value = ""; }} />
    </div>
    <div className="grid gap-3 sm:grid-cols-2">{toggles.map(({ key, label }) => <Label key={key} className="flex items-center justify-between gap-2 rounded-md bg-muted/40 p-3 text-sm">{label}<Switch checked={draft[key]} disabled={!canEdit} onCheckedChange={(value) => change(key, value)} /></Label>)}</div>
    <div className="grid gap-3 sm:grid-cols-2">{numbers.map(({ key, label, min, max }) => <Label key={key} className="space-y-2 text-xs">{label}<Input type="number" min={min} max={max} value={draft[key]} disabled={!canEdit || (draft.useIndex && ["startYear", "endYear", "topNSubjects"].includes(key))} onChange={(event) => change(key, Number(event.target.value))} /></Label>)}</div>
    <div className="grid gap-3 sm:grid-cols-3">{[categories, sources, genres].map((values, index) => <CCBSelect key={index} label={["作品分类", "作品来源", "作品题材"][index]} value={draft.metaTags[index] || ""} options={values.map((value) => ({ value, label: value || ["全部动画", "全部来源", "全部题材"][index] }))} disabled={!canEdit} onChange={(value) => change("metaTags", [0, 1, 2].map((position) => position === index ? value : draft.metaTags[position] || ""))} />)}</div>
    <div className="space-y-2"><p className="text-xs text-muted-foreground">文本提示：剩余几次猜测时出现，0 关闭，按从大到小填写</p><div className="grid grid-cols-3 gap-2">{[0, 1, 2].map((index) => <Input key={index} type="number" aria-label={`第 ${index + 1} 条提示剩余次数`} min={0} max={100} value={draft.useHints[index] ?? 0} disabled={!canEdit} onChange={(event) => change("useHints", [0, 1, 2].map((position) => position === index ? Number(event.target.value) : draft.useHints[position] ?? 0))} />)}</div></div>
    {draft.useIndex ? <div className="space-y-2"><Label>目录编号<Input type="number" min={1} value={draft.indexId ?? ""} disabled={!canEdit} onChange={(event) => change("indexId", event.target.value ? Number(event.target.value) : null)} placeholder="Bangumi 目录编号" /></Label><Button variant="outline" size="sm" disabled={!canEdit || !draft.indexId} onClick={async () => { if (!draft.indexId) return; const result = await run("ccb.directory.import", { indexId: draft.indexId }); if (result) setDirectoryNotice(`已导入 ${result.subjectIds.length} 部作品，缺失 ${result.missingSubjectIds.length} 部`); }}>同步目录</Button>{directoryNotice ? <p role="status" className="text-xs text-muted-foreground">{directoryNotice}</p> : null}</div> : null}
    <div className="space-y-3"><h3 className="text-sm font-medium">追加作品（{draft.addedSubjects.length}）</h3><div className="flex flex-wrap gap-2">{draft.addedSubjects.map((id) => <Button key={id} variant="secondary" size="sm" disabled={!canEdit} aria-label={`移除作品 ${id}`} onClick={() => change("addedSubjects", draft.addedSubjects.filter((value) => value !== id))}>#{id}<X /></Button>)}</div>
      {editable ? <CCBSearch subjectsOnly allowSubjects disabled={!canEdit || draft.addedSubjects.length >= 500} onSelect={(subject) => change("addedSubjects", [...new Set([...draft.addedSubjects, subject.id])])} /> : null}
    </div>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {editable ? <Button className="w-full" loading={busy} onClick={() => void save()}>保存设置</Button> : <p className="text-xs text-muted-foreground">仅房主可在等待阶段修改设置</p>}
  </div>;
}
