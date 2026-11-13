import type { CEESettings } from "@bakagame/shared";
import type { useCEEAction } from "@/hooks/UseCEEAction";
import { AnimatePresence, motion } from "framer-motion";
import { BookOpen, Filter, Users, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Hint } from "@/components/ui/Tooltip";
import { SettingsAccordion } from "@/components/common/room/SettingsAccordion";
import { SettingReveal, SettingValue, SettingsSection } from "@/components/common/room/settings/Layout";
import { SettingStepper, SettingYearRange } from "@/components/common/room/settings/NumberFields";
import { SettingSegmented, SettingSelect, SettingSwitchRow } from "@/components/common/room/settings/ChoiceFields";
import { SettingTextField } from "@/components/common/room/settings/TextFields";
import { listItem } from "@/lib/Motion";
import type { Dispatch, SetStateAction } from "react";
import type { useCEESubjectNames } from "./UseCEESubjectNames";
import { CEEPresetBar } from "./CEEPresetBar";
import { MAX_ADDED_SUBJECTS, META_TAGS, ANSWER_MODE_OPTIONS } from "./CEESettingOptions";
import { CEESubjectSearch } from "./CEESearch";

interface QuestionPanelProps {
  /** 展示值：房主看草稿，非房主看服务端当前设置。 */
  values: CEESettings;
  draft: CEESettings;
  setDraft: Dispatch<SetStateAction<CEESettings>>;
  change: <K extends keyof CEESettings>(key: K, value: CEESettings[K]) => void;
  readOnly: boolean;
  summary: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subjects: ReturnType<typeof useCEESubjectNames>;
  directoryNotice: string;
  syncDirectory: (indexId: number) => Promise<void>;
  pending: ReturnType<typeof useCEEAction>["pending"];
  presets: Record<string, CEESettings>;
  presetName: string;
  fileError: string;
  applyPreset: (name: string) => void;
  exportSettings: () => void;
  importSettings: (file?: File) => void;
}

/** 题目设置面板：出题方式、预设与导入导出、抽题范围、角色范围与追加作品。草稿由 CEEGameSettings 持有，这里只渲染与编辑。 */
export function CEEQuestionPanel({
  values,
  draft,
  setDraft,
  change,
  readOnly,
  summary,
  open,
  onOpenChange,
  subjects,
  directoryNotice,
  syncDirectory,
  pending,
  presets,
  presetName,
  fileError,
  applyPreset,
  exportSettings,
  importSettings,
}: QuestionPanelProps) {
  const scopedByDirectory = values.useIndex;
  const setMetaTag = (index: number, value: string) =>
    change(
      "metaTags",
      [0, 1, 2].map((position) => (position === index ? value : (draft.metaTags[position] ?? "")))
    );
  return (
    <SettingsAccordion
      icon={BookOpen}
      title="题目设置"
      summary={summary}
      readOnly={readOnly}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div>
        <SettingsSection>
          <SettingSegmented
            label="出题方式"
            value={values.answerMode}
            options={ANSWER_MODE_OPTIONS}
            onValueChange={(value) => change("answerMode", value)}
            description={
              values.answerMode === "manual"
                ? "开始后由房主指定一位出题人，出题人与队友本局观战。"
                : "开始后从下面的范围里随机抽一位角色。"
            }
          />
          <CEEPresetBar
            readOnly={readOnly}
            presets={presets}
            presetName={presetName}
            fileError={fileError}
            onApplyPreset={applyPreset}
            onExport={exportSettings}
            onImport={importSettings}
          />
        </SettingsSection>

        <SettingsSection title="抽题范围" icon={Filter}>
          <SettingSwitchRow
            label="使用 Bangumi 目录"
            description="开启后只从目录中的作品出题，年份与热度范围不再生效。"
            checked={values.useIndex}
            onCheckedChange={(value) => change("useIndex", value)}
          />
          <SettingReveal open={values.useIndex}>
            <SettingTextField
              label="目录编号"
              inputMode="numeric"
              value={values.indexId ? String(values.indexId) : ""}
              placeholder="Bangumi 目录编号"
              description={directoryNotice || undefined}
              onChange={(text) => {
                const value = Number(text);
                change("indexId", text && Number.isInteger(value) && value > 0 ? value : null);
              }}
              action={
                <Button
                  variant="outline"
                  className="h-10 shrink-0"
                  loading={pending.has("cee.directory.import")}
                  disabled={!draft.indexId}
                  onClick={() => {
                    if (draft.indexId) void syncDirectory(draft.indexId);
                  }}
                >
                  同步目录
                </Button>
              }
            />
          </SettingReveal>
          <SettingYearRange
            label="年份范围"
            start={values.startYear}
            end={values.endYear}
            disabled={scopedByDirectory}
            onChange={(start, end) =>
              setDraft((current) => ({
                ...current,
                startYear: start ?? current.startYear,
                endYear: end ?? current.endYear,
              }))
            }
          />
          <SettingStepper
            label="热度前几部"
            value={values.topNSubjects}
            minimum={1}
            maximum={1000}
            step={5}
            disabled={scopedByDirectory}
            format={(value) => `前 ${value} 部`}
            onChange={(value) => change("topNSubjects", value)}
          />
          <SettingSwitchRow
            label="按年榜抽题"
            description="每年各取热度前几部，而不是整段年份合并排名。"
            checked={values.useSubjectPerYear}
            onCheckedChange={(value) => change("useSubjectPerYear", value)}
          />
          <div className={readOnly ? "space-y-4" : "grid gap-3 sm:grid-cols-3"}>
            {META_TAGS.map((tag, index) => (
              <SettingSelect
                key={tag.label}
                label={tag.label}
                value={values.metaTags[index] ?? ""}
                onChange={(value) => setMetaTag(index, value)}
                options={tag.values.map((value) => ({ value, label: value || tag.all }))}
              />
            ))}
          </div>
        </SettingsSection>

        <SettingsSection title="角色范围" icon={Users}>
          <SettingSwitchRow
            label="仅主角"
            checked={values.mainCharacterOnly}
            onCheckedChange={(value) => change("mainCharacterOnly", value)}
          />
          <SettingStepper
            label="每部候选角色数"
            unit="人"
            value={values.characterNum}
            minimum={1}
            maximum={100}
            onChange={(value) => change("characterNum", value)}
          />
        </SettingsSection>

        <SettingsSection title={`追加作品（${values.addedSubjects.length}）`} icon={BookOpen}>
          {readOnly ? (
            <SettingValue
              label="作品"
              value={values.addedSubjects.map(subjects.nameOf).join("、") || "无"}
            />
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5 empty:hidden">
                <AnimatePresence initial={false}>
                  {draft.addedSubjects.map((id) => (
                    <motion.span
                      key={id}
                      variants={listItem}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      layout="position"
                      className="inline-flex max-w-full items-center gap-1 rounded-md border bg-secondary py-0.5 pr-0.5 pl-2 text-xs text-secondary-foreground"
                    >
                      <Hint label={subjects.nameOf(id)}>
                        <span className="min-w-0 truncate">{subjects.nameOf(id)}</span>
                      </Hint>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5 shrink-0 rounded-sm text-muted-foreground hover:text-destructive"
                        aria-label={`移除作品 ${subjects.nameOf(id)}`}
                        onClick={() =>
                          change(
                            "addedSubjects",
                            draft.addedSubjects.filter((value) => value !== id)
                          )
                        }
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </motion.span>
                  ))}
                </AnimatePresence>
              </div>
              <CEESubjectSearch
                addedIds={draft.addedSubjects}
                disabled={draft.addedSubjects.length >= MAX_ADDED_SUBJECTS}
                onAdd={(subject) => {
                  subjects.remember(subject.id, subject.nameCn || subject.name);
                  change("addedSubjects", [...new Set([...draft.addedSubjects, subject.id])]);
                }}
              />
            </>
          )}
        </SettingsSection>
      </div>
    </SettingsAccordion>
  );
}
