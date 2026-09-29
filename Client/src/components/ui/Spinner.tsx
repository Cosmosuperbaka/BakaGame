import { motion, type HTMLMotionProps } from "framer-motion"
import { LoaderCircle } from "lucide-react"
import { spinner } from "@/lib/Motion"
import { cn } from "@/lib/Utils"

type SpinnerProps = Omit<HTMLMotionProps<"span">, "children">

/**
 * 加载指示。旋转走 spinner 令牌，随 MotionConfig 尊重减弱动效；Tailwind 的 animate-spin 是不受约束的 CSS 关键帧，不用。
 * 默认对读屏隐藏：进行中的含义由外层 role="status"、按钮 aria-busy 或并排文字表达。
 * 尺寸与颜色由调用处的 size-* 与 text-* 决定，图标铺满并继承 currentColor。
 */
function Spinner({ className, ...props }: SpinnerProps) {
  return (
    <motion.span
      {...spinner}
      aria-hidden="true"
      className={cn("inline-flex size-4 shrink-0 items-center justify-center", className)}
      {...props}
    >
      <LoaderCircle className="size-full" />
    </motion.span>
  )
}

export { Spinner }
