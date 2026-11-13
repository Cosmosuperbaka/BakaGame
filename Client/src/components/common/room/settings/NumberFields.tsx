import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { Slider } from "@/components/ui/Slider";
import { useValueChange } from "@/hooks/UseValueChange";
import { iconTappable, readoutTick } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { motion, useAnimationControls } from "framer-motion";
import { Minus, Plus, type LucideIcon } from "lucide-react";
import {
  ReadOnlyValue,
  SettingRow,
  useSettingsReadOnly,
} from "@/components/common/room/settings/Layout";

/** 步进器里的加减键：圆形，悬停时浮起一块底色，按下只让图标下沉，轨道不跟着缩放。 */
function StepButton({
  label,
  icon: Icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <motion.button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      initial="rest"
      whileHover={disabled ? undefined : "hover"}
      whileTap={disabled ? undefined : "press"}
      className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-[background-color,color,box-shadow] hover:bg-background hover:text-foreground hover:shadow-sm focus-visible:outline-offset-0 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:shadow-none group-data-disabled/stepper:opacity-100 dark:hover:bg-secondary"
    >
      <motion.span variants={STEP_ICON} transition={iconTappable.transition} className="flex">
        <Icon className="h-3.5 w-3.5" />
      </motion.span>
    </motion.button>
  );
}

/** 加减键图标的手势幅度沿用 iconTappable，只是落在图标上。 */
const STEP_ICON = {
  rest: { scale: 1 },
  hover: iconTappable.whileHover,
  press: iconTappable.whileTap,
};

/**
 * 数值步进：减键、数值、加键收在一条全圆角的凹槽里，与分段控件的轨道同一底色（`bg-muted`），不另加描边。
 * 按钮与输入框内的上下方向键立即生效；手动输入只在失焦或回车时提交并夹到范围内，
 * 输入 2026 这类多位数时不会在第一位就被夹成下限。数值变化时新值顺着增减方向轻轻顶上来。
 * 单位跟在标签后面，不接在凹槽外：凹槽各行等宽，同一面板里的步进器才能上下对齐。
 * 只读时显示数值与单位；`format` 把特殊值换成文字（0 → 「不限」）。
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
  format,
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
    <SettingRow
      label={label}
      unit={unit}
      description={description}
      htmlFor={id}
      descriptionId={descriptionId}
      disabled={disabled}
    >
      <div
        data-disabled={disabled || undefined}
        className={cn(
          "group/stepper flex h-9 w-32 items-center gap-0.5 rounded-full bg-muted p-1",
          // 焦点环收在凹槽边界（与 TeamPicker 同一写法），内联输入不设自己的环，避免一个控件两层指示
          "has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-ring",
          disabled && "opacity-50"
        )}
      >
        <StepButton
          label={`减少${label}`}
          icon={Minus}
          disabled={disabled || value <= minimum}
          onClick={() => commit(value - step)}
        />
        <motion.input
          id={id}
          type="text"
          inputMode="numeric"
          // 文本框承载数值输入，语义上是数值调节控件：读屏要知道范围、当前值与上下方向键可调
          role="spinbutton"
          aria-valuemin={minimum}
          aria-valuemax={maximum}
          aria-valuenow={value}
          aria-describedby={description ? descriptionId : undefined}
          value={draft}
          disabled={disabled}
          animate={readout}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitDraft}
          onKeyDown={handleKey}
          className="min-w-0 flex-1 bg-transparent text-center text-sm font-medium tabular-nums outline-none disabled:cursor-not-allowed"
        />
        <StepButton
          label={`增加${label}`}
          icon={Plus}
          disabled={disabled || value >= maximum}
          onClick={() => commit(value + step)}
        />
      </div>
    </SettingRow>
  );
}

/**
 * 刻度滑动条（热度门槛这类跨几个数量级的值）：滑块落在 `stops` 的档位上，档位越往后间距越大，
 * 前段细调、后段大步，整条轨道都用得上。轨道下方每档一道细刻度，`majors` 里的档位加长并标出数值；
 * 右侧读数与步进器同为衬线加粗。`stops[0]` 常为 0，由 `format` 写成「不限」。
 * 回写的值只会是 `stops` 里的某一档，任意数字混不进设置。
 */
export function SettingScaleSlider({
  label,
  description,
  value,
  stops,
  majors = [],
  format,
  formatTick = format,
  onChange,
  disabled = false,
}: {
  label: string;
  description?: string;
  value: number;
  /** 升序的档位 */
  stops: readonly number[];
  /** 加长并标注数值的档位 */
  majors?: readonly number[];
  format: (value: number) => string;
  /** 刻度标注的写法，缺省同读数 */
  formatTick?: (value: number) => string;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const labelId = useId();
  const descriptionId = useId();
  const readOnly = useSettingsReadOnly();
  // 设置里存的值若不在档位上（旧数据），落到不超过它的最近一档。
  const index = Math.max(
    0,
    stops.reduce((found, stop, position) => (stop <= value ? position : found), 0)
  );
  const last = stops.length - 1;
  if (readOnly) {
    return (
      <SettingRow label={label} description={description}>
        <ReadOnlyValue muted={value === 0}>{format(value)}</ReadOnlyValue>
      </SettingRow>
    );
  }
  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span
          id={labelId}
          className={cn("font-serif text-sm leading-snug", disabled && "opacity-50")}
        >
          {label}
        </span>
        <span
          aria-hidden="true"
          className={cn(
            "text-sm font-semibold tabular-nums",
            stops[index] === 0 ? "text-muted-foreground" : "text-foreground"
          )}
        >
          {format(stops[index])}
        </span>
      </div>
      <div className="px-2">
        <Slider
          value={[index]}
          min={0}
          max={last}
          step={1}
          disabled={disabled}
          onValueChange={([position]) => onChange(stops[position] ?? 0)}
          aria-labelledby={labelId}
          aria-describedby={description ? descriptionId : undefined}
          aria-valuetext={format(stops[index])}
          className="h-6"
        />
        {/* 刻度与滑块中心对齐：Radix 把滑块中心限制在轨道两端各缩进半个滑块，刻度按同样的比例排布在去掉两端的宽度里。 */}
        <div aria-hidden="true" className="relative mx-2 h-6">
          {stops.map((stop, position) => {
            const major = majors.includes(stop) || position === 0 || position === last;
            const left = `${(position / last) * 100}%`;
            return (
              <span
                key={stop}
                className="absolute top-0 flex -translate-x-1/2 flex-col items-center"
                style={{ left }}
              >
                <span
                  className={cn(
                    "w-px rounded-full",
                    major ? "h-2 bg-muted-foreground/70" : "h-1 bg-muted-foreground/35",
                    position <= index && "bg-primary/70"
                  )}
                />
                {major ? (
                  <span className="mt-0.5 whitespace-nowrap font-sans text-2xs text-muted-foreground">
                    {formatTick(stop)}
                  </span>
                ) : null}
              </span>
            );
          })}
        </div>
      </div>
      {description ? (
        <p id={descriptionId} className="text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      ) : null}
    </div>
  );
}

/** 年份输入：凹槽里的一格，失焦或回车时提交；`optional` 时留空表示不限。 */
function YearInput({
  label,
  value,
  optional,
  minimum,
  maximum,
  onCommit,
  disabled,
}: {
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
    if (draft.trim() === "" && optional) {
      if (value !== undefined) onCommit(undefined);
      return;
    }
    if (draft.trim() === "" || !Number.isFinite(parsed)) {
      setDraft(value === undefined ? "" : String(value));
      return;
    }
    const clamped = Math.max(minimum, Math.min(maximum, Math.round(parsed)));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  // 焦点环由外层「至」凹槽统一画，这里只把落点垫亮，保证数字在 muted 上仍读得清
  return (
    <input
      type="text"
      inputMode="numeric"
      role="spinbutton"
      aria-label={label}
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      aria-valuenow={value}
      value={draft}
      disabled={disabled}
      placeholder={optional ? "不限" : undefined}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          // 留空（不限）时上键落到下限、下键落到上限，与方向键「从哪头进来」的直觉一致
          const up = event.key === "ArrowUp";
          const next = value === undefined ? (up ? minimum : maximum) : value + (up ? 1 : -1);
          const clamped = Math.max(minimum, Math.min(maximum, next));
          setDraft(String(clamped));
          if (clamped !== value) onCommit(clamped);
        }
      }}
      className="h-7 w-14 rounded-full bg-transparent text-center text-sm font-medium tabular-nums outline-none placeholder:font-normal placeholder:text-muted-foreground focus-visible:bg-background disabled:cursor-not-allowed dark:focus-visible:bg-secondary"
    />
  );
}

/**
 * 年份范围：起止两格收在一条凹槽里，与步进器同一形态，中间用「至」相连。
 * `optional` 时任一格可留空表示不限（猜歌的番剧年份）；否则两格必填（CEE 的抽题年份）。起止顺序由调用处校验。
 */
export function SettingYearRange({
  label,
  start,
  end,
  onChange,
  optional = false,
  minimum = 1900,
  maximum = 2200,
  description,
  disabled = false,
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
    const text =
      start === undefined && end === undefined ? "不限" : `${start ?? "不限"} 至 ${end ?? "不限"}`;
    return (
      <SettingRow label={label} description={description}>
        <ReadOnlyValue>{text}</ReadOnlyValue>
      </SettingRow>
    );
  }
  return (
    <SettingRow label={label} description={description} disabled={disabled}>
      <div
        className={cn(
          "flex h-9 items-center gap-0.5 rounded-full bg-muted p-1",
          // 与步进器同一形态：焦点环收在凹槽边界，两格输入共用一条指示
          "has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-ring",
          disabled && "opacity-50"
        )}
      >
        <YearInput
          label={`${label}起始`}
          value={start}
          optional={optional}
          minimum={minimum}
          maximum={maximum}
          disabled={disabled}
          onCommit={(value) => onChange(value, end)}
        />
        <span className="px-0.5 text-xs text-muted-foreground" aria-hidden="true">
          至
        </span>
        <YearInput
          label={`${label}结束`}
          value={end}
          optional={optional}
          minimum={minimum}
          maximum={maximum}
          disabled={disabled}
          onCommit={(value) => onChange(start, value)}
        />
      </div>
    </SettingRow>
  );
}
