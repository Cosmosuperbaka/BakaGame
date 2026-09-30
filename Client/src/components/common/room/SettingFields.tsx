import { useId, useState, type ReactNode } from "react";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/Utils";

// 等待页设置面板共用的字段行：标签与控件显式关联，说明经 aria-describedby 挂到控件上，读屏能读出每个开关与输入的名称和说明。
// 禁用时标签随控件一起变淡；说明保持原色，它往往就是禁用的原因（如「8 人开启」）。

/** 开关行：左侧标签与可选说明，右侧开关。 */
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
  icon?: ReactNode;
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
          {icon}
          <Label htmlFor={id} className="text-xs">{label}</Label>
        </div>
        {description ? <p id={descriptionId} className="mt-1 text-[11px] text-muted-foreground">{description}</p> : null}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled}
        aria-describedby={description ? descriptionId : undefined} />
    </div>
  );
}

/**
 * 数值步进：按钮立即生效；手动输入只在失焦或回车时提交并夹到范围内，
 * 输入 2026 这类多位数时不会在第一位就被夹成下限。
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
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <Label htmlFor={id} className={cn("text-xs", disabled && "opacity-50")}>{label}</Label>
        {description ? <p id={descriptionId} className="mt-1 text-[11px] text-muted-foreground">{description}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
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
          className="h-9 w-16 bg-muted/30 px-1 text-center text-base font-medium tabular-nums shadow-inner"
        />
        <Button variant="outline" size="icon" className="h-9 w-9" aria-label={`增加${label}`}
          disabled={disabled || value >= maximum} onClick={() => commit(value + step)}>
          <Plus className="h-3 w-3" />
        </Button>
        {unit ? <span className="w-4 text-xs text-muted-foreground">{unit}</span> : null}
      </div>
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
