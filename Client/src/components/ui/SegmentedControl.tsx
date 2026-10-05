import * as React from "react"
import { motion } from "framer-motion"
import { SlidingIndicator } from "@/components/ui/SlidingIndicator"
import { useIndicatorRect } from "@/hooks/UseIndicatorRect"
import { tappable } from "@/lib/Motion"
import { cn } from "@/lib/Utils"

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  disabled?: boolean
}

interface SegmentedControlProps<T extends string> {
  value: T
  options: SegmentedOption<T>[]
  onValueChange: (value: T) => void
  /** 页面上已有可见标签时改传 `aria-labelledby` 指向它，二者给一个即可。 */
  "aria-label"?: string
  "aria-labelledby"?: string
  /** `sm` 用于工具条等密集区域，高度与 `Button size="sm"` 对齐。 */
  size?: "default" | "sm"
  className?: string
}

const SIZES = {
  default: { root: "h-9 p-1", item: "px-3 text-sm" },
  sm: { root: "h-8 p-0.5", item: "px-2.5 text-xs" },
} as const

/**
 * 分段单选：两三个互斥选项并排、始终可见。基于原生 radio，方向键切换与读屏语义由浏览器提供；
 * 选中底块与 Tabs 是同一个 `SlidingIndicator`：按量到的选中项位置滑动，所在弹窗缩放开合时不跟着飘。
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onValueChange,
  size = "default",
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: SegmentedControlProps<T>) {
  const groupId = React.useId()
  const sizing = SIZES[size]
  const rootRef = React.useRef<HTMLDivElement>(null)
  const rect = useIndicatorRect(rootRef, "[data-checked]", value)
  return (
    <div
      ref={rootRef}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      className={cn("relative inline-flex w-full items-center rounded-md bg-muted text-muted-foreground", sizing.root, className)}
    >
      <SlidingIndicator rect={rect} />
      {options.map((option) => {
        const checked = option.value === value
        return (
          <motion.label
            key={option.value}
            {...(option.disabled ? undefined : tappable)}
            // 视觉隐藏的原生 radio 才是聚焦停靠点；label 只承载按压动画，
            // 不显式排除的话会被 framer-motion 因 whileTap 自动加上 tabIndex=0。
            tabIndex={-1}
            data-checked={checked || undefined}
            className={cn(
              "relative flex h-full flex-1 cursor-pointer items-center justify-center whitespace-nowrap rounded-md font-medium transition-colors",
              sizing.item,
              checked ? "text-foreground" : !option.disabled && "hover:text-foreground",
              option.disabled && "cursor-not-allowed opacity-50",
            )}
          >
            <input
              type="radio"
              name={groupId}
              value={option.value}
              checked={checked}
              disabled={option.disabled}
              onChange={() => onValueChange(option.value)}
              className="sr-only"
            />
            <span className="relative">{option.label}</span>
          </motion.label>
        )
      })}
    </div>
  )
}
