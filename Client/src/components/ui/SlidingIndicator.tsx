import { motion } from "framer-motion"
import type { IndicatorRect } from "@/hooks/UseIndicatorRect"
import { indicatorSlide } from "@/lib/Motion"
import { cn } from "@/lib/Utils"

/** 下划线指示器的粗细（像素），与 `TabsList` 底边的 1px 分隔线叠在同一条基线上。 */
const UNDERLINE = 2

/**
 * 三种形状对应三类容器：
 * - `block`：方格底块，CCB 队伍面板的九宫格；
 * - `pill`：胶囊底块，分段控件，与步进器、年份范围同一种全圆角凹槽；
 * - `underline`：标签页底部的一道主色细线，标签本身不铺底。
 */
export type SlidingIndicatorShape = "block" | "pill" | "underline"

const SHAPES: Record<SlidingIndicatorShape, string> = {
  // 暗色下 background 比 muted 轨道只亮一点，选中块几乎看不出；改用更亮的 secondary。
  block: "rounded-md bg-background shadow-sm dark:bg-secondary",
  // 胶囊底块带一圈很淡的主色描边：读作「按下去的那一颗」，而不只是更亮的一格。
  pill: "rounded-full bg-background shadow-xs ring-1 ring-primary/25 dark:bg-secondary",
  underline: "rounded-full bg-primary",
}

/**
 * 选中项指示器：标签页、分段控件与队伍面板共用。始终是同一个元素，从量到的旧位置滑到新选中项；
 * 首次出现直接落位（`initial={false}`），不从容器角落飞进来。
 * 位置由所在容器用 `useIndicatorRect` 测量后传入，容器须是定位元素，选项须是定位元素才能盖在指示器上面。
 */
export function SlidingIndicator({ rect, shape = "block" }: { rect: IndicatorRect | null; shape?: SlidingIndicatorShape }) {
  if (!rect) return null
  const target = shape === "underline"
    ? { x: rect.x, y: rect.y + rect.height - UNDERLINE, width: rect.width, height: UNDERLINE }
    : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  return (
    <motion.span
      data-indicator="true"
      aria-hidden="true"
      initial={false}
      animate={target}
      transition={indicatorSlide}
      className={cn("pointer-events-none absolute left-0 top-0", SHAPES[shape])}
    />
  )
}
