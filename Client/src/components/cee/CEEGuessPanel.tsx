import type { CEESettings } from "@bakagame/shared";
import { Lightbulb, Search, Swords, Tags } from "lucide-react";
import { SettingsAccordion } from "@/components/common/room/SettingsAccordion";
import {
  SettingStepper,
  SettingSwitchRow,
  SettingsSection,
} from "@/components/common/room/SettingFields";
import { offOr } from "./CEESettingsRules";

interface GuessPanelProps {
  values: CEESettings;
  draft: CEESettings;
  change: <K extends keyof CEESettings>(key: K, value: CEESettings[K]) => void;
  readOnly: boolean;
  summary: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 猜测设置面板：次数与限时、标签、提示与玩法规则。草稿由 CEEGameSettings 持有，这里只渲染与编辑。 */
export function CEEGuessPanel({
  values,
  draft,
  change,
  readOnly,
  summary,
  open,
  onOpenChange,
}: GuessPanelProps) {
  const setHint = (index: number, value: number) =>
    change(
      "useHints",
      [0, 1, 2].map((position) => (position === index ? value : (draft.useHints[position] ?? 0)))
    );
  return (
    <SettingsAccordion
      icon={Search}
      title="猜测设置"
      summary={summary}
      readOnly={readOnly}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div>
        <SettingsSection>
          <SettingStepper
            label="猜测次数"
            unit="次"
            value={values.maxAttempts}
            minimum={1}
            maximum={100}
            onChange={(value) => change("maxAttempts", value)}
          />
          <SettingStepper
            label="每次行动限时"
            // 「设为 0」是给房主的操作说明，只读视角的取值已写成「不限」
            description={readOnly ? undefined : "设为 0 表示不限行动时间。"}
            unit="秒"
            value={values.timeLimit}
            minimum={0}
            maximum={120}
            step={10}
            format={(value) => (value ? `${value} 秒` : "不限")}
            onChange={(value) => change("timeLimit", value)}
          />
          <SettingSwitchRow
            label="允许搜索作品"
            description="关闭后猜题者只能按角色名搜索。"
            checked={values.subjectSearch}
            onCheckedChange={(value) => change("subjectSearch", value)}
          />
        </SettingsSection>

        <SettingsSection title="标签" icon={Tags}>
          <SettingStepper
            label="作品标签数"
            value={values.subjectTagNum}
            minimum={0}
            maximum={10}
            onChange={(value) => change("subjectTagNum", value)}
          />
          <SettingStepper
            label="角色标签数"
            value={values.characterTagNum}
            minimum={0}
            maximum={10}
            onChange={(value) => change("characterTagNum", value)}
          />
        </SettingsSection>

        <SettingsSection title="提示" icon={Lightbulb}>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {readOnly
              ? "提示在剩余次数降到设定值时出现。"
              : "提示在剩余次数降到设定值时出现，0 为关闭，按从大到小填写。"}
          </p>
          {[0, 1, 2].map((index) => (
            <SettingStepper
              key={index}
              label={`第 ${index + 1} 条文本提示`}
              value={values.useHints[index] ?? 0}
              minimum={0}
              maximum={values.maxAttempts}
              format={(value) => offOr(value, `剩 ${value} 次时`)}
              onChange={(value) => setHint(index, value)}
            />
          ))}
          <SettingStepper
            label="图片提示"
            value={values.useImageHint}
            minimum={0}
            maximum={values.maxAttempts}
            format={(value) => offOr(value, `剩 ${value} 次时`)}
            onChange={(value) => change("useImageHint", value)}
          />
        </SettingsSection>

        <SettingsSection title="玩法规则" icon={Swords}>
          <SettingSwitchRow
            label="同步模式"
            description="每轮所有人都提交后再统一判定。"
            checked={values.syncMode}
            onCheckedChange={(value) => change("syncMode", value)}
          />
          <SettingSwitchRow
            label="血战模式"
            description="有人猜中后继续，直到所有人结束。"
            checked={values.nonstopMode}
            onCheckedChange={(value) => change("nonstopMode", value)}
          />
          <SettingSwitchRow
            label="角色全局 BP"
            description="别人猜过的角色不能再猜。"
            checked={values.globalPick}
            onCheckedChange={(value) => change("globalPick", value)}
          />
          <SettingSwitchRow
            label="标签全局 BP"
            description="已被发现的标签对其他人隐藏。"
            checked={values.tagBan}
            onCheckedChange={(value) => change("tagBan", value)}
          />
        </SettingsSection>
      </div>
    </SettingsAccordion>
  );
}
