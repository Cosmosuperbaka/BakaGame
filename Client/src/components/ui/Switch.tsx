import * as React from "react"
import * as SwitchPrimitives from "@radix-ui/react-switch"
import { cn } from "@/lib/Utils"

/**
 * 开关。
 *
 * 滑块位移与按压缩放走 spring.snap（开关属于最轻一档的即时反馈），取 lib/Motion.ts 生成的 CSS 变量。
 * 这里不用 framer-motion：滑块的按压反馈依赖 `group-active:scale-90`，
 * 而 framer 的 layout 动画会写入内联 transform 覆盖该类，两者无法共存。
 */
const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      "group peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
      className
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        // 暗色关闭态：深色滑块压在 input 轨道上几乎隐形，改用浅色滑块。
        "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-sm ring-0 dark:data-[state=unchecked]:bg-foreground/75",
        "transition-transform duration-(--motion-spring-snap-duration) ease-(--motion-spring-snap)",
        "data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0",
        "group-active:scale-90"
      )}
    />
  </SwitchPrimitives.Root>
))
Switch.displayName = SwitchPrimitives.Root.displayName

export { Switch }
