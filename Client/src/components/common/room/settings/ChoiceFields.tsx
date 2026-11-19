import { useId } from "react";
import { Button } from "@/components/ui/Button";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/SegmentedControl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { ToggleChip } from "@/components/ui/ToggleChip";
import { type LucideIcon } from "lucide-react";
import {
  ReadOnlyValue,
  SettingRow,
  StackedField,
  useSettingsReadOnly,
} from "@/components/common/room/settings/Layout";

/** 开关行：左侧标签与可选说明，右侧开关。图标只传组件，尺寸与颜色在这里统一。 */
export function SettingSwitchRow({
  label,
  description,
  icon,
  checked,
  onCheckedChange,
  disabled = false,
}: {
  label: string;
  description?: string;
  icon?: LucideIcon;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const descriptionId = useId();
  const readOnly = useSettingsReadOnly();
  return (
    <SettingRow
      label={label}
      description={description}
      icon={icon}
      htmlFor={readOnly ? undefined : id}
      descriptionId={descriptionId}
      disabled={disabled && !readOnly}
    >
      {readOnly ? (
        <ReadOnlyValue muted={!checked}>{checked ? "开启" : "关闭"}</ReadOnlyValue>
      ) : (
        <Switch
          id={id}
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
          aria-describedby={description ? descriptionId : undefined}
        />
      )}
    </SettingRow>
  );
}

/** Radix Select 不接受空字符串作为选项值，「不限」用占位值往返。 */
const EMPTY_VALUE = "__all";

/** 带可见标签的下拉选择；空字符串表示「不限」。只读时显示所选项的文字。 */
export function SettingSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const readOnly = useSettingsReadOnly();
  if (readOnly) {
    return (
      <SettingRow label={label}>
        <ReadOnlyValue>
          {options.find((option) => option.value === value)?.label ?? value}
        </ReadOnlyValue>
      </SettingRow>
    );
  }
  return (
    <StackedField label={label} htmlFor={id} disabled={disabled}>
      <Select
        value={value || EMPTY_VALUE}
        onValueChange={(next) => onChange(next === EMPTY_VALUE ? "" : next)}
        disabled={disabled}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value || EMPTY_VALUE} value={option.value || EMPTY_VALUE}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </StackedField>
  );
}

/**
 * 两三个互斥选项（出题方式、热度档位）：可见标签在上，分段控件占满整行；说明在下，可随选项变化。
 * 只读时显示所选项的文字。分段控件经 `aria-labelledby` 由标签命名。
 */
export function SettingSegmented<T extends string>({
  label,
  value,
  options,
  onValueChange,
  description,
}: {
  label: string;
  value: T;
  options: SegmentedOption<T>[];
  onValueChange: (value: T) => void;
  description?: string;
}) {
  const labelId = useId();
  const readOnly = useSettingsReadOnly();
  // 与步进器、开关同一种行：标签在左，贴合选项宽度的胶囊凹槽在右；窄屏放不下时整组折到下一行靠右。
  return (
    <SettingRow label={label} description={description} labelId={readOnly ? undefined : labelId}>
      {readOnly ? (
        <ReadOnlyValue>
          {options.find((option) => option.value === value)?.label ?? value}
        </ReadOnlyValue>
      ) : (
        <SegmentedControl
          aria-labelledby={labelId}
          value={value}
          options={options}
          onValueChange={onValueChange}
        />
      )}
    </SettingRow>
  );
}

/**
 * 多选标签（歌曲类型）：每项是一枚可按下的胶囊，`aria-pressed` 表达选中；至少保留一项，全部取消时回到全选。
 * 标签行右侧的「全选」只在没全选时出现。只读时列出所选项，全选写作「全部」。
 */
export function SettingToggleChips<T extends string>({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: Array<{ value: T; label: string }>;
  selected: readonly T[];
  onChange: (selected: T[]) => void;
}) {
  const labelId = useId();
  const readOnly = useSettingsReadOnly();
  const chosen = new Set(selected);
  const all = options.every((option) => chosen.has(option.value));
  if (readOnly) {
    // 与其它只读字段同一种行：标签在左、取值在右，选项多时取值在右列内折行。
    return (
      <SettingRow label={label}>
        <ReadOnlyValue>
          {all
            ? "全部"
            : options
                .filter((option) => chosen.has(option.value))
                .map((option) => option.label)
                .join("、")}
        </ReadOnlyValue>
      </SettingRow>
    );
  }
  const toggle = (value: T) => {
    const next = chosen.has(value)
      ? selected.filter((item) => item !== value)
      : [...selected, value];
    onChange(next.length ? next : options.map((option) => option.value));
  };
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <span id={labelId} className="font-serif text-sm leading-snug">
          {label}
        </span>
        {!all ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange(options.map((option) => option.value))}
            className="-my-1 h-6 px-1.5 text-xs text-muted-foreground"
          >
            全选
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby={labelId}>
        {options.map((option) => (
          <ToggleChip
            key={option.value}
            pressed={chosen.has(option.value)}
            onPressedChange={() => toggle(option.value)}
          >
            {option.label}
          </ToggleChip>
        ))}
      </div>
    </div>
  );
}
