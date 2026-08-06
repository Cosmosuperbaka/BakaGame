import * as React from "react"
import * as SwitchPrimitives from "@radix-ui/react-switch"
import { cn } from "@/lib/utils"

/**
 * 开关。
 *
 * 滑块位移用带过冲的贝塞尔曲线（落位时略微越过再回收），表达拨动的物理感。
 * 这里不用 framer-motion：滑块的按压反馈依赖 `group-active:scale-90`，
 * 而 framer 的 layout 动画会写入内联 transform 覆盖该类，两者无法共存。
 * 曲线取 index.css 的 --motion-ease-overshoot，与 lib/motion.ts 的 spring.snap 观感对齐。
 */
const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      "group peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
      className
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0",
        "transition-transform duration-[var(--motion-duration-base)] ease-[var(--motion-ease-overshoot)]",
        "data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0",
        "group-active:scale-90"
      )}
    />
  </SwitchPrimitives.Root>
))
Switch.displayName = SwitchPrimitives.Root.displayName

export { Switch }
