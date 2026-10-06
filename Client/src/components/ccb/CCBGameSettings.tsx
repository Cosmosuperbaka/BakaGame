import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { BookOpen, Download, Filter, Lightbulb, Search, Swords, Tags, Upload, Users, X } from "lucide-react";
import { parseCCBSettings, type CCBAnswerMode, type CCBSettings } from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import type { SegmentedOption } from "@/components/ui/SegmentedControl";
import { SettingsAccordion } from "@/components/common/room/SettingsAccordion";
import {
  SettingReveal, SettingSegmented, SettingSelect, SettingStepper, SettingSwitchRow, SettingTextField, SettingValue,
  SettingYearRange, SettingsSection,
} from "@/components/common/room/SettingFields";
import { useAutoSave } from "@/hooks/UseAutoSave";
import { useCCBAction } from "@/hooks/UseCCBAction";
import { listItem } from "@/lib/Motion";
import { ccbErrorMessage, useCCBStore } from "@/stores/UseCCBStore";
import { ccbPresets } from "./CCBPresets";
import { CCBSubjectSearch } from "./CCBSearch";

const CATEGORIES = ["", "全部", "游戏", "书籍", "三次元", "TV", "Galgame", "WEB", "OVA", "剧场版", "动态漫画", "其他"];
const SOURCES = ["", "原创", "漫画改", "游戏改", "小说改"];
const GENRES = ["", "科幻", "喜剧", "百合", "校园", "惊悚", "后宫", "机战", "悬疑", "恋爱", "奇幻", "推理", "运动", "耽美", "音乐", "战斗", "冒险", "萌系", "穿越", "玄幻", "乙女", "恐怖", "历史", "日常", "剧情", "武侠", "美食", "职场"];
const META_TAGS = [
  { label: "作品分类", values: CATEGORIES, all: "全部动画" },
  { label: "作品来源", values: SOURCES, all: "全部来源" },
  { label: "作品题材", values: GENRES, all: "全部题材" },
] as const;
const ANSWER_MODE_OPTIONS: SegmentedOption<CCBAnswerMode>[] = [
  { value: "random", label: "随机出题" },
  { value: "manual", label: "指定出题人" },
];
/** 玩法配置文件的大小上限：正常配置只有几 KB，拒绝异常大的文件。 */
const SETTINGS_FILE_LIMIT = 100_000;
const MAX_ADDED_SUBJECTS = 500;
const offOr = (value: number, text: string) => (value === 0 ? "关闭" : text);

/** 两个折叠组收起时的摘要。 */
function summaries(settings: CCBSettings) {
  return {
    question: [
      settings.answerMode === "manual" ? "指定出题人" : "随机出题",
      settings.useIndex ? `目录 ${settings.indexId ?? "未填"}` : `${settings.startYear}–${settings.endYear} 前 ${settings.topNSubjects} 部`,
      settings.mainCharacterOnly ? "仅主角" : `每部 ${settings.characterNum} 人`,
      settings.addedSubjects.length ? `追加 ${settings.addedSubjects.length} 部` : "",
    ],
    guess: [
      `${settings.maxAttempts} 次机会`,
      settings.timeLimit ? `每次 ${settings.timeLimit} 秒` : "不限行动时间",
      settings.syncMode ? "同步模式" : "",
      settings.nonstopMode ? "血战模式" : "",
      settings.globalPick ? "角色 BP" : "",
      settings.tagBan ? "标签 BP" : "",
    ],
  };
}
/**
 * 追加作品的名称：设置里只存编号，搜索添加时顺手记下名字；导入、预设或非房主看到的编号经 `ccb.subject.lookup` 补齐。
 * 每个编号只查一次，查不到的保持「作品 #编号」。
 */
function useSubjectNames(ids: number[]) {
  const [names, setNames] = useState<Record<number, string>>({});
  const requested = useRef(new Set<number>());
  const key = ids.filter((id) => !(id in names)).join(",");
  useEffect(() => {
    // 已经发出过的编号不再查；查不到的不会进 names，靠这里挡住重复请求。
    const subjectIds = key ? key.split(",").map(Number).filter((id) => !requested.current.has(id)) : [];
    if (!subjectIds.length) return;
    subjectIds.forEach((id) => requested.current.add(id));
    let alive = true;
    void useCCBStore.getState().sendCommand("ccb.subject.lookup", { subjectIds })
      .then(({ results }) => {
        if (alive) setNames((current) => ({ ...current, ...Object.fromEntries(results.map((subject) => [subject.id, subject.nameCn || subject.name])) }));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [key]);
  const remember = (id: number, name: string) => setNames((current) => ({ ...current, [id]: name }));
  return { nameOf: (id: number) => names[id] ?? `作品 #${id}`, remember };
}

/**
 * 题目与猜测设置。两个折叠面板共用一份草稿、一条防抖自动保存：分开保存会让后保存的一方用旧值覆盖另一方的修改。
 * 只在等待阶段保存，开局后丢弃未提交的草稿。使用 Bangumi 目录时，目录必须先同步入库才允许保存（服务端只从已落库的成员出题）。
 * 非房主看到同一份结构（`readOnly`），读的是当前设置；预设、导入导出与目录同步这些房主工具不出现。
 */
export function CCBGameSettings({ settings, waiting, readOnly = false }: { settings: CCBSettings; waiting: boolean; readOnly?: boolean }) {
  const [draft, setDraft] = useState(() => structuredClone(settings));
  const [presetName, setPresetName] = useState("");
  const [questionOpen, setQuestionOpen] = useState(false);
  const [guessOpen, setGuessOpen] = useState(false);
  const [syncedIndexId, setSyncedIndexId] = useState(settings.useIndex ? settings.indexId : null);
  const [directoryNotice, setDirectoryNotice] = useState("");
  const [fileError, setFileError] = useState("");
  const upload = useRef<HTMLInputElement>(null);
  const { run, pending } = useCCBAction();
  const presets = useMemo(() => ccbPresets(), []);
  const values = readOnly ? settings : draft;
  const subjects = useSubjectNames(values.addedSubjects);
  const change = <K extends keyof CCBSettings>(key: K, value: CCBSettings[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const validation = readOnly ? ""
    : draft.startYear > draft.endYear ? "起始年份不能晚于结束年份"
      : draft.useIndex && !draft.indexId ? "请填写 Bangumi 目录编号"
        : draft.useIndex && draft.indexId !== syncedIndexId ? "目录需要先同步，同步后自动保存"
          : "";

  useAutoSave(draft, (value) => useCCBStore.getState().sendCommand("ccb.room.settings", { settings: value }), {
    enabled: !readOnly && waiting && !validation,
    onError: (error) => useCCBStore.getState().setNotice(ccbErrorMessage(error)),
  });

  const syncDirectory = async (indexId: number) => {
    const result = await run("ccb.directory.import", { indexId });
    if (!result) return;
    setSyncedIndexId(indexId);
    setDirectoryNotice(`已同步 ${result.subjectIds.length} 部作品${result.missingSubjectIds.length ? `，缺失 ${result.missingSubjectIds.length} 部` : ""}`);
  };
  const applyPreset = (name: string) => {
    // 预设只换玩法规则，出题方式是房主对这间房的选择，原样保留。
    const next = { ...structuredClone(presets[name]), answerMode: draft.answerMode };
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
  const scopedByDirectory = values.useIndex;
  const summary = summaries(values);

  return (
    <>
      <SettingsAccordion icon={BookOpen} title="题目设置" summary={summary.question} readOnly={readOnly} open={questionOpen} onOpenChange={setQuestionOpen}>
        <div>
          <SettingsSection>
            <SettingSegmented label="出题方式" value={values.answerMode} options={ANSWER_MODE_OPTIONS} onValueChange={(value) => change("answerMode", value)}
              description={values.answerMode === "manual" ? "开始后由房主指定一位出题人，出题人与队友本局观战。" : "开始后从下面的范围里随机抽一位角色。"} />
            {!readOnly ? (
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-40 flex-1">
                  <SettingSelect label="玩法预设" value={presetName} onChange={(name) => { if (name) applyPreset(name); }}
                    options={[{ value: "", label: "选择预设" }, ...Object.keys(presets).map((name) => ({ value: name, label: name }))]} />
                </div>
                <Button variant="outline" onClick={exportSettings}><Download />导出</Button>
                <Button variant="outline" onClick={() => upload.current?.click()}><Upload />导入</Button>
                <input ref={upload} type="file" accept="application/json,.json" aria-label="导入玩法配置" className="hidden"
                  onChange={(event) => { void importSettings(event.target.files?.[0]); event.target.value = ""; }} />
              </div>
            ) : null}
            {fileError ? <p role="alert" className="text-xs text-destructive">{fileError}</p> : null}
          </SettingsSection>

          <SettingsSection title="抽题范围" icon={Filter}>
            <SettingSwitchRow label="使用 Bangumi 目录" description="开启后只从目录中的作品出题，年份与热度范围不再生效。" checked={values.useIndex} onCheckedChange={(value) => change("useIndex", value)} />
            <SettingReveal open={values.useIndex}>
              <SettingTextField label="目录编号" inputMode="numeric" value={values.indexId ? String(values.indexId) : ""} placeholder="Bangumi 目录编号"
                description={directoryNotice || undefined}
                onChange={(text) => { const value = Number(text); change("indexId", text && Number.isInteger(value) && value > 0 ? value : null); }}
                action={(
                  <Button variant="outline" className="h-10 shrink-0" loading={pending.has("ccb.directory.import")} disabled={!draft.indexId}
                    onClick={() => { if (draft.indexId) void syncDirectory(draft.indexId); }}>同步目录</Button>
                )} />
            </SettingReveal>
            <SettingYearRange label="年份范围" start={values.startYear} end={values.endYear} disabled={scopedByDirectory}
              onChange={(start, end) => setDraft((current) => ({ ...current, startYear: start ?? current.startYear, endYear: end ?? current.endYear }))} />
            <SettingStepper label="热度前几部" value={values.topNSubjects} minimum={1} maximum={1000} step={5} disabled={scopedByDirectory}
              format={(value) => `前 ${value} 部`} onChange={(value) => change("topNSubjects", value)} />
            <SettingSwitchRow label="按年榜抽题" description="每年各取热度前几部，而不是整段年份合并排名。" checked={values.useSubjectPerYear} onCheckedChange={(value) => change("useSubjectPerYear", value)} />
            <div className={readOnly ? "space-y-4" : "grid gap-3 sm:grid-cols-3"}>
              {META_TAGS.map((tag, index) => (
                <SettingSelect key={tag.label} label={tag.label} value={values.metaTags[index] ?? ""} onChange={(value) => setMetaTag(index, value)}
                  options={tag.values.map((value) => ({ value, label: value || tag.all }))} />
              ))}
            </div>
          </SettingsSection>

          <SettingsSection title="角色范围" icon={Users}>
            <SettingSwitchRow label="仅主角" checked={values.mainCharacterOnly} onCheckedChange={(value) => change("mainCharacterOnly", value)} />
            <SettingStepper label="每部候选角色数" unit="人" value={values.characterNum} minimum={1} maximum={100} onChange={(value) => change("characterNum", value)} />
          </SettingsSection>

          <SettingsSection title={`追加作品（${values.addedSubjects.length}）`} icon={BookOpen}>
            {readOnly ? (
              <SettingValue label="作品" value={values.addedSubjects.map(subjects.nameOf).join("、") || "无"} />
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5 empty:hidden">
                  <AnimatePresence initial={false}>
                    {draft.addedSubjects.map((id) => (
                      <motion.span key={id} variants={listItem} initial="initial" animate="animate" exit="exit" layout="position"
                        className="inline-flex max-w-full items-center gap-1 rounded-full bg-secondary py-1 pr-1 pl-3 text-xs text-secondary-foreground">
                        <span className="min-w-0 truncate" title={subjects.nameOf(id)}>{subjects.nameOf(id)}</span>
                        <Button variant="ghost" size="icon" className="h-5 w-5 shrink-0 rounded-full text-muted-foreground hover:text-destructive"
                          aria-label={`移除作品 ${subjects.nameOf(id)}`}
                          onClick={() => change("addedSubjects", draft.addedSubjects.filter((value) => value !== id))}>
                          <X className="h-3 w-3" />
                        </Button>
                      </motion.span>
                    ))}
                  </AnimatePresence>
                </div>
                <CCBSubjectSearch addedIds={draft.addedSubjects} disabled={draft.addedSubjects.length >= MAX_ADDED_SUBJECTS}
                  onAdd={(subject) => {
                    subjects.remember(subject.id, subject.nameCn || subject.name);
                    change("addedSubjects", [...new Set([...draft.addedSubjects, subject.id])]);
                  }} />
              </>
            )}
          </SettingsSection>
        </div>
      </SettingsAccordion>

      <SettingsAccordion icon={Search} title="猜测设置" summary={summary.guess} readOnly={readOnly} open={guessOpen} onOpenChange={setGuessOpen}>
        <div>
          <SettingsSection>
            <SettingStepper label="猜测次数" unit="次" value={values.maxAttempts} minimum={1} maximum={100} onChange={(value) => change("maxAttempts", value)} />
            <SettingStepper label="每次行动限时" description="设为 0 表示不限行动时间。" unit="秒" value={values.timeLimit} minimum={0} maximum={120} step={10}
              format={(value) => (value ? `${value} 秒` : "不限")} onChange={(value) => change("timeLimit", value)} />
            <SettingSwitchRow label="允许搜索作品" description="关闭后猜题者只能按角色名搜索。" checked={values.subjectSearch} onCheckedChange={(value) => change("subjectSearch", value)} />
          </SettingsSection>

          <SettingsSection title="标签" icon={Tags}>
            <SettingStepper label="作品标签数" value={values.subjectTagNum} minimum={0} maximum={10} onChange={(value) => change("subjectTagNum", value)} />
            <SettingStepper label="角色标签数" value={values.characterTagNum} minimum={0} maximum={10} onChange={(value) => change("characterTagNum", value)} />
            <SettingSwitchRow label="显示常见标签" checked={values.commonTags} onCheckedChange={(value) => change("commonTags", value)} />
          </SettingsSection>

          <SettingsSection title="提示" icon={Lightbulb}>
            <p className="text-xs leading-relaxed text-muted-foreground">提示在剩余次数降到设定值时出现，0 为关闭，按从大到小填写。</p>
            {[0, 1, 2].map((index) => (
              <SettingStepper key={index} label={`第 ${index + 1} 条文本提示`} value={values.useHints[index] ?? 0} minimum={0} maximum={values.maxAttempts}
                format={(value) => offOr(value, `剩 ${value} 次时`)} onChange={(value) => setHint(index, value)} />
            ))}
            <SettingStepper label="图片提示" value={values.useImageHint} minimum={0} maximum={values.maxAttempts}
              format={(value) => offOr(value, `剩 ${value} 次时`)} onChange={(value) => change("useImageHint", value)} />
          </SettingsSection>

          <SettingsSection title="玩法规则" icon={Swords}>
            <SettingSwitchRow label="同步模式" description="每轮所有人都提交后再统一判定。" checked={values.syncMode} onCheckedChange={(value) => change("syncMode", value)} />
            <SettingSwitchRow label="血战模式" description="有人猜中后继续，直到所有人结束。" checked={values.nonstopMode} onCheckedChange={(value) => change("nonstopMode", value)} />
            <SettingSwitchRow label="角色全局 BP" description="别人猜过的角色不能再猜。" checked={values.globalPick} onCheckedChange={(value) => change("globalPick", value)} />
            <SettingSwitchRow label="标签全局 BP" description="已被发现的标签对其他人隐藏。" checked={values.tagBan} onCheckedChange={(value) => change("tagBan", value)} />
          </SettingsSection>
        </div>
      </SettingsAccordion>

      {validation ? <p role="alert" className="text-xs text-destructive">{validation}</p> : null}
    </>
  );
}
