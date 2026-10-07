/* eslint-disable react-refresh/only-export-components -- 只读上下文与字段组件同属一套设置表单，拆文件只会让每个字段多一处导入。 */
import { createContext, useContext, useEffect, useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { AnimatePresence, motion, useAnimationControls } from "framer-motion";
import { Minus, Plus, type LucideIcon } from "lucide-react";
import { CollapsibleRegion } from "@/components/ui/Collapsible";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/SegmentedControl";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { useValueChange } from "@/hooks/UseValueChange";
import { collapsible, iconTappable, readoutTick, tappable } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

// 等待页设置面板共用的字段：标签与控件显式关联，说明经 aria-describedby 挂到控件上，读屏能读出每个开关与输入的名称和说明。
// 禁用时标签随控件一起变淡；说明保持原色，它往往就是禁用的原因（如「8 人开启」）。
// 非房主看到同一份结构：外层包 `SettingsReadOnly`，每个字段把控件换成右侧的取值文字，标签与说明原样保留。

const ReadOnlyContext = createContext(false);

/** 包住一组设置，里面的字段都只显示取值、不渲染控件。 */
export function SettingsReadOnly({ readOnly, children }: { readOnly: boolean; children: ReactNode }) {
  return <ReadOnlyContext.Provider value={readOnly}>{children}</ReadOnlyContext.Provider>;
}

/** 当前字段是否只读；游戏自有的控件（歌单读取、目录同步）也据此收起操作。 */
export function useSettingsReadOnly() {
  return useContext(ReadOnlyContext);
}

/** 只读时右侧的取值：常规字重、前景色，数字等宽，读起来像一张清单。 */
function ReadOnlyValue({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return (
    <span className={cn("shrink-0 text-right text-sm tabular-nums", muted ? "text-muted-foreground" : "text-foreground")}>
      {children}
    </span>
  );
}

/**
 * 一行设置：左侧标签（可带图标与单位）与说明，右侧控件。手机上两边放不下时控件整组折到下方靠右，
 * 标签列不被挤成逐字断行。标签统一 `text-sm`，说明 `text-xs` 弱化色。
 */
function SettingRow({
  label, unit, description, icon: Icon, htmlFor, descriptionId, disabled = false, children,
}: {
  label: string;
  unit?: string;
  description?: string;
  icon?: LucideIcon;
  /** 控件的 id；只读时没有控件，标签退回普通文字 */
  htmlFor?: string;
  descriptionId?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  const text = (
    <>
      {label}
      {unit ? <span className="font-normal text-muted-foreground">（{unit}）</span> : null}
    </>
  );
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1 basis-40">
        <div className={cn("flex items-center gap-2", disabled && "opacity-50")}>
          {Icon ? <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
          {htmlFor ? <Label htmlFor={htmlFor} className="leading-snug font-normal">{text}</Label>
            : <span className="text-sm leading-snug">{text}</span>}
        </div>
        {description ? <p id={descriptionId} className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p> : null}
      </div>
      <div className="ml-auto flex shrink-0 items-center">{children}</div>
    </div>
  );
}

/** 开关行：左侧标签与可选说明，右侧开关。图标只传组件，尺寸与颜色在这里统一。 */
export function SettingSwitchRow({
  label, description, icon, checked, onCheckedChange, disabled = false,
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
    <SettingRow label={label} description={description} icon={icon} htmlFor={readOnly ? undefined : id} descriptionId={descriptionId} disabled={disabled && !readOnly}>
      {readOnly ? <ReadOnlyValue muted={!checked}>{checked ? "开启" : "关闭"}</ReadOnlyValue> : (
        <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled}
          aria-describedby={description ? descriptionId : undefined} />
      )}
    </SettingRow>
  );
}
/** 步进器里的加减键：圆形，悬停时浮起一块底色，按下只让图标下沉，轨道不跟着缩放。 */
function StepButton({ label, icon: Icon, disabled, onClick }: {
  label: string;
  icon: LucideIcon;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <motion.button type="button" aria-label={label} disabled={disabled} onClick={onClick}
      initial="rest" whileHover={disabled ? undefined : "hover"} whileTap={disabled ? undefined : "press"}
      className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-[background-color,color,box-shadow] hover:bg-background hover:text-foreground hover:shadow-sm focus-visible:outline-offset-0 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:shadow-none group-data-disabled/stepper:opacity-100 dark:hover:bg-secondary">
      <motion.span variants={STEP_ICON} transition={iconTappable.transition} className="flex">
        <Icon className="h-3.5 w-3.5" />
      </motion.span>
    </motion.button>
  );
}

/** 加减键图标的手势幅度沿用 iconTappable，只是落在图标上。 */
const STEP_ICON = { rest: { scale: 1 }, hover: iconTappable.whileHover, press: iconTappable.whileTap };

/**
 * 数值步进：减键、数值、加键收在一条全圆角的凹槽里，与分段控件的轨道同一底色（`bg-muted`），不另加描边。
 * 按钮与输入框内的上下方向键立即生效；手动输入只在失焦或回车时提交并夹到范围内，
 * 输入 2026 这类多位数时不会在第一位就被夹成下限。数值变化时新值顺着增减方向轻轻顶上来。
 * 单位跟在标签后面，不接在凹槽外：凹槽各行等宽，同一面板里的步进器才能上下对齐。
 * 只读时显示数值与单位；`format` 把特殊值换成文字（0 → 「不限」）。
 */
export function SettingStepper({
  label, description, value, minimum, maximum, step = 1, unit, onChange, disabled = false, format,
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
  /** 只读取值的文字；缺省为「数值 单位」 */
  format?: (value: number) => string;
}) {
  const id = useId();
  const descriptionId = useId();
  const readOnly = useSettingsReadOnly();
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
  const change = useValueChange(value);
  const readout = useAnimationControls();
  useEffect(() => {
    if (!change || readOnly) return;
    const direction = change.to > change.from ? 1 : -1;
    void readout.start({
      opacity: [readoutTick.initial.opacity, 1],
      y: [direction * readoutTick.initial.y, 0],
      scale: [readoutTick.initial.scale, 1],
      transition: readoutTick.transition,
    });
  }, [change, readout, readOnly]);
  const handleKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") commitDraft();
    else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      commit(value + (event.key === "ArrowUp" ? step : -step));
    }
  };
  if (readOnly) {
    return (
      <SettingRow label={label} description={description}>
        <ReadOnlyValue>{format ? format(value) : unit ? `${value} ${unit}` : value}</ReadOnlyValue>
      </SettingRow>
    );
  }
  return (
    <SettingRow label={label} unit={unit} description={description} htmlFor={id} descriptionId={descriptionId} disabled={disabled}>
      <div data-disabled={disabled || undefined}
        className={cn(
          "group/stepper flex h-9 w-32 items-center gap-0.5 rounded-full bg-muted p-1 transition-shadow",
          "has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring/60",
          disabled && "opacity-50",
        )}>
        <StepButton label={`减少${label}`} icon={Minus} disabled={disabled || value <= minimum} onClick={() => commit(value - step)} />
        <motion.input
          id={id}
          type="text"
          inputMode="numeric"
          aria-describedby={description ? descriptionId : undefined}
          value={draft}
          disabled={disabled}
          animate={readout}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitDraft}
          onKeyDown={handleKey}
          className="min-w-0 flex-1 bg-transparent text-center text-sm font-medium tabular-nums outline-none disabled:cursor-not-allowed"
        />
        <StepButton label={`增加${label}`} icon={Plus} disabled={disabled || value >= maximum} onClick={() => commit(value + step)} />
      </div>
    </SettingRow>
  );
}
/** 上下堆叠的字段（文本、下拉、分段）：标签在上，控件占满整行；只读时退回标签与取值同一行。 */
function StackedField({
  label, description, htmlFor, labelId, descriptionId, disabled = false, children,
}: {
  label: string;
  description?: string;
  htmlFor?: string;
  labelId?: string;
  descriptionId?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2">
      {htmlFor ? <Label id={labelId} htmlFor={htmlFor} className={cn("leading-snug font-normal", disabled && "opacity-50")}>{label}</Label>
        : <span id={labelId} className={cn("text-sm leading-snug", disabled && "opacity-50")}>{label}</span>}
      {children}
      {description ? <p id={descriptionId} className="text-xs leading-relaxed text-muted-foreground">{description}</p> : null}
    </div>
  );
}

/**
 * 单行文本设置（房间名称、房间密码、目录编号）：可见标签命名输入框，占位文案给出业务提示。
 * `action` 放在输入框右侧（「同步目录」「读取」）；只读时显示取值，密码只显示「已设置」。
 */
export function SettingTextField({
  label, value, onChange, placeholder, type = "text", maxLength, inputMode, description, action, readOnlyText,
  error, autoFocus, disabled = false, inputClassName,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  type?: "text" | "password";
  maxLength?: number;
  inputMode?: "numeric" | "text";
  description?: string;
  action?: ReactNode;
  /** 只读时的取值文字；缺省为输入框的值，密码框不显示 */
  readOnlyText?: string;
  /** 落在这个字段上的校验失败：输入框标 `aria-invalid`，文案写在下方并经 `aria-describedby` 关联 */
  error?: string | null;
  autoFocus?: boolean;
  disabled?: boolean;
  /** 只改输入框的高度与字号（弹窗里的 `h-10`） */
  inputClassName?: string;
}) {
  const id = useId();
  const descriptionId = useId();
  const errorId = useId();
  const readOnly = useSettingsReadOnly();
  if (readOnly) {
    if (type === "password") return null;
    const text = readOnlyText ?? value;
    return (
      <SettingRow label={label} description={description}>
        <ReadOnlyValue muted={!text}>{text || "未设置"}</ReadOnlyValue>
      </SettingRow>
    );
  }
  return (
    <StackedField label={label} description={description} htmlFor={id} descriptionId={descriptionId}>
      <div className="flex gap-2">
        <Input id={id} type={type} value={value} maxLength={maxLength} placeholder={placeholder} inputMode={inputMode}
          autoFocus={autoFocus} disabled={disabled} className={inputClassName}
          aria-invalid={error ? true : undefined}
          aria-describedby={[description ? descriptionId : "", error ? errorId : ""].filter(Boolean).join(" ") || undefined}
          onChange={(event) => onChange(event.target.value)} />
        {action}
      </div>
      {error ? <p id={errorId} role="alert" className="text-xs text-destructive">{error}</p> : null}
    </StackedField>
  );
}

/** Radix Select 不接受空字符串作为选项值，「不限」用占位值往返。 */
const EMPTY_VALUE = "__all";

/** 带可见标签的下拉选择；空字符串表示「不限」。只读时显示所选项的文字。 */
export function SettingSelect({
  label, value, options, onChange, disabled = false,
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
        <ReadOnlyValue>{options.find((option) => option.value === value)?.label ?? value}</ReadOnlyValue>
      </SettingRow>
    );
  }
  return (
    <StackedField label={label} htmlFor={id} disabled={disabled}>
      <Select value={value || EMPTY_VALUE} onValueChange={(next) => onChange(next === EMPTY_VALUE ? "" : next)} disabled={disabled}>
        <SelectTrigger id={id}><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value || EMPTY_VALUE} value={option.value || EMPTY_VALUE}>{option.label}</SelectItem>
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
  label, value, options, onValueChange, description,
}: {
  label: string;
  value: T;
  options: SegmentedOption<T>[];
  onValueChange: (value: T) => void;
  description?: string;
}) {
  const labelId = useId();
  const readOnly = useSettingsReadOnly();
  if (readOnly) {
    return (
      <SettingRow label={label} description={description}>
        <ReadOnlyValue>{options.find((option) => option.value === value)?.label ?? value}</ReadOnlyValue>
      </SettingRow>
    );
  }
  return (
    <StackedField label={label} labelId={labelId} description={description}>
      <SegmentedControl aria-labelledby={labelId} value={value} options={options} onValueChange={onValueChange} />
    </StackedField>
  );
}
/** 年份输入：凹槽里的一格，失焦或回车时提交；`optional` 时留空表示不限。 */
function YearInput({ label, value, optional, minimum, maximum, onCommit, disabled }: {
  label: string;
  value: number | undefined;
  optional: boolean;
  minimum: number;
  maximum: number;
  onCommit: (value: number | undefined) => void;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    setDraft(value === undefined ? "" : String(value));
  }
  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() === "" && optional) { if (value !== undefined) onCommit(undefined); return; }
    if (draft.trim() === "" || !Number.isFinite(parsed)) { setDraft(value === undefined ? "" : String(value)); return; }
    const clamped = Math.max(minimum, Math.min(maximum, Math.round(parsed)));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label={label}
      value={draft}
      disabled={disabled}
      placeholder={optional ? "不限" : undefined}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === "Enter") commit(); }}
      className="h-7 w-14 rounded-full bg-transparent text-center text-sm font-medium tabular-nums outline-none placeholder:font-normal placeholder:text-muted-foreground focus-visible:bg-background disabled:cursor-not-allowed dark:focus-visible:bg-secondary"
    />
  );
}

/**
 * 年份范围：起止两格收在一条凹槽里，与步进器同一形态，中间用「至」相连。
 * `optional` 时任一格可留空表示不限（猜歌的番剧年份）；否则两格必填（CCB 的抽题年份）。起止顺序由调用处校验。
 */
export function SettingYearRange({
  label, start, end, onChange, optional = false, minimum = 1900, maximum = 2200, description, disabled = false,
}: {
  label: string;
  start: number | undefined;
  end: number | undefined;
  onChange: (start: number | undefined, end: number | undefined) => void;
  optional?: boolean;
  minimum?: number;
  maximum?: number;
  description?: string;
  disabled?: boolean;
}) {
  const readOnly = useSettingsReadOnly();
  if (readOnly) {
    const text = start === undefined && end === undefined ? "不限" : `${start ?? "不限"} 至 ${end ?? "不限"}`;
    return <SettingRow label={label} description={description}><ReadOnlyValue>{text}</ReadOnlyValue></SettingRow>;
  }
  return (
    <SettingRow label={label} description={description} disabled={disabled}>
      <div className={cn(
        "flex h-9 items-center gap-0.5 rounded-full bg-muted p-1 transition-shadow has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring/60",
        disabled && "opacity-50",
      )}>
        <YearInput label={`${label}起始`} value={start} optional={optional} minimum={minimum} maximum={maximum} disabled={disabled}
          onCommit={(value) => onChange(value, end)} />
        <span className="px-0.5 text-xs text-muted-foreground" aria-hidden="true">至</span>
        <YearInput label={`${label}结束`} value={end} optional={optional} minimum={minimum} maximum={maximum} disabled={disabled}
          onCommit={(value) => onChange(start, value)} />
      </div>
    </SettingRow>
  );
}

/**
 * 多选标签（歌曲类型）：每项是一枚可按下的胶囊，`aria-pressed` 表达选中；至少保留一项，全部取消时回到全选。
 * 标签行右侧的「全选」只在没全选时出现。只读时列出所选项，全选写作「全部」。
 */
export function SettingToggleChips<T extends string>({
  label, options, selected, onChange,
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
    return (
      <StackedField label={label}>
        <p className="text-sm leading-relaxed">{all ? "全部" : options.filter((option) => chosen.has(option.value)).map((option) => option.label).join("、")}</p>
      </StackedField>
    );
  }
  const toggle = (value: T) => {
    const next = chosen.has(value) ? selected.filter((item) => item !== value) : [...selected, value];
    onChange(next.length ? next : options.map((option) => option.value));
  };
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <span id={labelId} className="text-sm leading-snug">{label}</span>
        {!all ? (
          <button type="button" onClick={() => onChange(options.map((option) => option.value))}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground">
            全选
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby={labelId}>
        {options.map((option) => {
          const pressed = chosen.has(option.value);
          return (
            <motion.button key={option.value} type="button" {...tappable} aria-pressed={pressed} onClick={() => toggle(option.value)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs transition-colors",
                pressed ? "border-primary/40 bg-primary/10 font-medium text-primary" : "border-dashed border-border bg-transparent text-muted-foreground hover:border-solid hover:text-foreground",
              )}>
              {option.label}
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 一列字段的间距：后一项的上外边距（owl 选择器），不用 `space-y`。
 * 这样 `SettingReveal` 收起后整个移除时不残留间距，展开时间距算在它自己的内边距里、随高度一起补间，不会先跳 16px。
 */
export function SettingsFields({ children }: { children: ReactNode }) {
  return <div className="[&>*+*]:mt-4">{children}</div>;
}

/** 随开关出现的从属字段（歌词行数、房间密码）：高度按 `collapsible` 补间，上方间距在内边距里，不跳。只放在 `SettingsFields` 里。 */
export function SettingReveal({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <CollapsibleRegion open={open} className="!mt-0">
      <div className="pt-4">{children}</div>
    </CollapsibleRegion>
  );
}

/** 只读的一项：标签与取值。游戏自有的复合控件（歌单、追加作品）只读时用它。 */
export function SettingValue({ label, value, description }: { label: string; value: string; description?: string }) {
  return (
    <SettingRow label={label} description={description}>
      <ReadOnlyValue muted={!value}>{value || "未设置"}</ReadOnlyValue>
    </SettingRow>
  );
}

/**
 * 折叠组内的小节：可选的小标题（带图标）与一组字段。相邻小节之间一道分隔线，组内平铺的长列表由此分出层次。
 * `open` 为假时整节按 `collapsible` 收起（自动出题的筛选随出题方式出现）；分隔线与上间距算在节内，随高度一起补间。
 * 小节须是同一容器里的兄弟元素，第一节不画分隔线。
 */
export function SettingsSection({ title, icon: Icon, open = true, children }: {
  title?: string;
  icon?: LucideIcon;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <AnimatePresence initial={false}>
      {open ? (
        // flow-root 让节始终是 BFC：内层的上外边距留在节内、计入补间的高度；裁切只在补间期间由变体打开，字段的晕光不被切掉。
        <motion.section variants={collapsible} initial="initial" animate="animate" exit="exit" className="flow-root">
          <div className="[section:not(:first-child)>&]:mt-4 [section:not(:first-child)>&]:border-t [section:not(:first-child)>&]:pt-4">
            <SettingsFields>
              {title ? (
                <h4 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                  {title}
                </h4>
              ) : null}
              {children}
            </SettingsFields>
          </div>
        </motion.section>
      ) : null}
    </AnimatePresence>
  );
}
