import { motion } from "framer-motion"
import type { IndicatorRect } from "@/hooks/UseIndicatorRect"
import { indicatorSlide } from "@/lib/Motion"

/**
 * 选中项底块：标签页与分段控件共用。始终是同一个元素，从量到的旧位置滑到新选中项；
 * 首次出现直接落位（`initial={false}`），不从容器角落飞进来。
 * 位置由所在容器用 `useIndicatorRect` 测量后传入，容器须是定位元素，选项须是定位元素才能盖在底块上面。
 */
export function SlidingIndicator({ rect }: { rect: IndicatorRect | null }) {
  if (!rect) return null
  return (
    <motion.span
      data-indicator="true"
      aria-hidden="true"
      initial={false}
      animate={{ x: rect.x, y: rect.y, width: rect.width, height: rect.height }}
      transition={indicatorSlide}
      // 暗色下 background 比 muted 轨道只亮一点，选中块几乎看不出；改用更亮的 secondary。
      className="pointer-events-none absolute left-0 top-0 rounded-md bg-background shadow-sm dark:bg-secondary"
    />
  )
}
