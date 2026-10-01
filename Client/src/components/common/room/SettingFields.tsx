import { useId, useState } from "react";
import { Minus, Plus, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/Utils";

// 等待页设置面板共用的字段行：标签与控件显式关联，说明经 aria-describedby 挂到控件上，读屏能读出每个开关与输入的名称和说明。
// 禁用时标签随控件一起变淡；说明保持原色，它往往就是禁用的原因（如「8 人开启」）。

/** 开关行：左侧标签与可选说明，右侧开关。图标只传组件，尺寸与颜色在这里统一。 */
export function SettingSwitchRow({
  label,
  description,
  icon: Icon,
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
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className={cn("flex items-center gap-2", disabled && "opacity-50")}>
          {Icon ? <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
          <Label htmlFor={id} className="text-xs">{label}</Label>
        </div>
        {description ? <p id={descriptionId} className="mt-1 text-2xs text-muted-foreground">{description}</p> : null}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled}
        aria-describedby={description ? descriptionId : undefined} />
    </div>
  );
}

/**
 * 数值步进：按钮立即生效；手动输入只在失焦或回车时提交并夹到范围内，
 * 输入 2026 这类多位数时不会在第一位就被夹成下限。
 * 单位跟在标签后面，不接在按钮组外：按钮组各行等宽，同一面板里的加减按钮才能上下对齐。
 * 手机上标签与按钮组一行放不下时，按钮组整组折到标签下方靠右，标签不被挤成逐字断行。
 */
export function SettingStepper({
  label,
  description,
  value,
  minimum,
  maximum,
  step = 1,
  unit,
  onChange,
  disabled = false,
}: {
  label: string;
  description?: string;
  value: number;
  minimum: number;
  maximum: number;
  step?: number;
  unit?: string;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const descriptionId = useId();
  const [draft, setDraft] = useState(String(value));
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    setDraft(String(value));
  }
  const commit = (next: number) => {
    const clamped = Math.max(minimum, Math.min(maximum, Math.round(next)));
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  };
  const commitDraft = () => {
    const parsed = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(parsed)) setDraft(String(value));
    else commit(parsed);
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <div className="min-w-0">
        <Label htmlFor={id} className={cn("text-xs", disabled && "opacity-50")}>
          {label}
          {unit ? <span className="font-normal text-muted-foreground">（{unit}）</span> : null}
        </Label>
        {description ? <p id={descriptionId} className="mt-1 text-2xs text-muted-foreground">{description}</p> : null}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Button variant="outline" size="icon" className="h-9 w-9" aria-label={`减少${label}`}
          disabled={disabled || value <= minimum} onClick={() => commit(value - step)}>
          <Minus className="h-3 w-3" />
        </Button>
        <Input
          id={id}
          type="text"
          inputMode="numeric"
          aria-describedby={description ? descriptionId : undefined}
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitDraft}
          onKeyDown={(event) => { if (event.key === "Enter") commitDraft(); }}
          className="h-9 w-16 bg-muted/40 px-1 text-center text-base font-medium tabular-nums shadow-inner"
        />
        <Button variant="outline" size="icon" className="h-9 w-9" aria-label={`增加${label}`}
          disabled={disabled || value >= maximum} onClick={() => commit(value + step)}>
          <Plus className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

/** 单行文本设置（房间名称、房间密码）：可见标签命名输入框，占位文案给出业务提示。 */
export function SettingTextField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  type?: "text" | "password";
  maxLength?: number;
}) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <Input id={id} type={type} value={value} maxLength={maxLength} placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

/** Radix Select 不接受空字符串作为选项值，「不限」用占位值往返。 */
const EMPTY_VALUE = "__all";

/** 带可见标签的下拉选择；空字符串表示「不限」。 */
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
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className={cn("text-xs", disabled && "opacity-50")}>{label}</Label>
      <Select value={value || EMPTY_VALUE} onValueChange={(next) => onChange(next === EMPTY_VALUE ? "" : next)} disabled={disabled}>
        <SelectTrigger id={id}><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value || EMPTY_VALUE} value={option.value || EMPTY_VALUE}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
