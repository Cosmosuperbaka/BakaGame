import { AnimatePresence, motion, type TargetAndTransition, type Variants } from "framer-motion";
import type { PublicStatusLevel } from "@bakagame/shared";
import { CheckCircle2, CircleHelp, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { readoutSwap, statusGlyphSwap, vanish } from "@/lib/motion/NamedMoves";
import { cn } from "@/lib/Utils";
import { CELL_TONE, LEVEL_TEXT } from "./StatusFormat";

const LEVEL_BADGE = {
  operational: { variant: "matched", Icon: CheckCircle2 },
  degraded: { variant: "alert", Icon: TriangleAlert },
  unknown: { variant: "subtle", Icon: CircleHelp },
} as const;

/** 窄屏只留图标：形状本身区分三档，文字转给读屏，把宽度让给组件名。 */
export function LevelBadge({ level }: { level: PublicStatusLevel }) {
  const { variant, Icon } = LEVEL_BADGE[level];
  return (
    <Badge variant={variant} size="sm" className="shrink-0">
      <Icon aria-hidden="true" className="size-3" />
      <span className="sr-only sm:not-sr-only">{LEVEL_TEXT[level]}</span>
    </Badge>
  );
}

const PLACEHOLDER = "—";

/**
 * 推送或轮询换来的新读数自下方顶上来，读作「这个数被换掉了」；值不变不动。
 * 占位「—」换成第一次读到的值不算「被换掉」：占位直接撤走，不和新值叠在一起闪成一道删除线。
 */
const readoutVariants: Variants = {
  ...readoutSwap,
  exit: (value: string): TargetAndTransition =>
    value === PLACEHOLDER ? vanish : (readoutSwap.exit as TargetAndTransition),
};

export function Readout({ value }: { value: string }) {
  return (
    <span className="relative inline-flex">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={value}
          custom={value}
          variants={readoutVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          className="inline-block whitespace-nowrap"
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

const GLYPH = {
  operational: { Icon: CheckCircle2, tone: "bg-success/10 text-success" },
  degraded: { Icon: TriangleAlert, tone: "bg-destructive/10 text-destructive" },
  unknown: { Icon: CircleHelp, tone: "bg-muted text-muted-foreground" },
} as const;

/** 主卡左侧的状态图标：等级变了才换档，读取中按统一呼吸令牌起伏。 */
export function StatusGlyph({ level, loading }: { level: PublicStatusLevel; loading: boolean }) {
  const { Icon, tone } = GLYPH[loading ? "unknown" : level];
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-10 shrink-0 place-items-center rounded-md transition-colors duration-(--motion-duration-base) ease-(--motion-ease-out) sm:size-11",
        tone
      )}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={loading ? "loading" : level}
          variants={statusGlyphSwap}
          initial="initial"
          animate="animate"
          exit="exit"
          className="grid place-items-center"
        >
          <Icon className={cn("size-5", loading && "motion-safe:animate-breathe")} />
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

export function SummaryStat({
  label,
  shortLabel,
  value,
}: {
  label: string;
  /** 窄屏三栏各只有七八十像素：换一个不必折行的短名，时间窗口由下方的范围切换说明。 */
  shortLabel: string;
  value: string;
}) {
  return (
    <div className="flex min-w-0 flex-col-reverse justify-end gap-1.5 border-l border-border px-3 first:border-l-0 first:pl-0 sm:px-5">
      <dt className="text-2xs leading-snug text-muted-foreground">
        <span className="sm:hidden">{shortLabel}</span>
        <span className="hidden sm:inline">{label}</span>
      </dt>
      <dd className="font-mono text-xl leading-none tabular-nums">
        <Readout value={value} />
      </dd>
    </div>
  );
}

/** 图例：每一档同时给形状与文字，条格读作什么由这里定。 */
const LEGEND = [
  { label: "正常", tone: CELL_TONE.operational },
  { label: "异常", tone: CELL_TONE.degraded },
  { label: "未知", tone: CELL_TONE.unknown },
  { label: "无样本", tone: CELL_TONE.empty },
] as const;

export function Legend() {
  return (
    <ul
      aria-label="条带图例"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground"
    >
      {LEGEND.map((item) => (
        <li key={item.label} className="flex items-center gap-1">
          <span aria-hidden="true" className="flex h-3 w-1.5 items-end">
            <span className={cn("w-full rounded-xs", item.tone)} />
          </span>
          {item.label}
        </li>
      ))}
      <li className="hidden md:block">悬停条格看时段详情</li>
    </ul>
  );
}
