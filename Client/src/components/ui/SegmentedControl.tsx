import * as React from "react"
import { motion } from "framer-motion"
import { spring, tappable } from "@/lib/Motion"
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
  "aria-label": string
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
 * 选中底块以 layoutId 在选项之间滑动，与 Tabs 的指示器是同一个观感。
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onValueChange,
  size = "default",
  className,
  "aria-label": ariaLabel,
}: SegmentedControlProps<T>) {
  const groupId = React.useId()
  const sizing = SIZES[size]
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn("inline-flex w-full items-center rounded-md bg-muted text-muted-foreground", sizing.root, className)}
    >
      {options.map((option) => {
        const checked = option.value === value
        return (
          <motion.label
            key={option.value}
            {...(option.disabled ? undefined : tappable)}
            // 视觉隐藏的原生 radio 才是聚焦停靠点；label 只承载按压动画，
            // 不显式排除的话会被 framer-motion 因 whileTap 自动加上 tabIndex=0。
            tabIndex={-1}
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
            {checked ? (
              <motion.span
                layoutId={`segmented-${groupId}`}
                transition={spring.swift}
                className="absolute inset-0 rounded-md bg-background shadow-sm"
              />
            ) : null}
            <span className="relative">{option.label}</span>
          </motion.label>
        )
      })}
    </div>
  )
}
