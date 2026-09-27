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
  className?: string
}

/**
 * 分段单选：两三个互斥选项并排、始终可见。基于原生 radio，方向键切换与读屏语义由浏览器提供；
 * 选中底块以 layoutId 在选项之间滑动，与 Tabs 的指示器是同一个观感。
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onValueChange,
  className,
  "aria-label": ariaLabel,
}: SegmentedControlProps<T>) {
  const groupId = React.useId()
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn("inline-flex h-9 w-full items-center rounded-md bg-muted p-1 text-muted-foreground", className)}
    >
      {options.map((option) => {
        const checked = option.value === value
        return (
          <motion.label
            key={option.value}
            {...(option.disabled ? undefined : tappable)}
            className={cn(
              "relative flex h-full flex-1 cursor-pointer items-center justify-center whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors",
              "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
              checked && "text-foreground",
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
                className="absolute inset-0 rounded-md bg-background shadow"
              />
            ) : null}
            <span className="relative">{option.label}</span>
          </motion.label>
        )
      })}
    </div>
  )
}
