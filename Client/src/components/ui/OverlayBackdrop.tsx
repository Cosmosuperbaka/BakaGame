import { forwardRef } from "react";
import { motion, type HTMLMotionProps } from "framer-motion";
import { backdrop } from "@/lib/motion/Choreography";
import { cn } from "@/lib/Utils";

/**
 * 遮罩铺满的范围。视口档给 Portal 里的弹窗与侧边面板；容器档给房间内的覆盖面板，
 * 它只盖顶栏以下、层级也停在抽屉那一层，两档的类名不能互换。
 */
const PLACEMENT_CLASS = {
  viewport: "scrim fixed inset-0 z-overlay",
  container: "scrim absolute inset-0 z-drawer",
} as const;

interface OverlayBackdropProps extends HTMLMotionProps<"div"> {
  placement: keyof typeof PLACEMENT_CLASS;
}

/**
 * 覆盖层遮罩，弹窗、侧边面板与房间覆盖面板共用同一条淡入淡出：遮罩先出现后消失，
 * 面板自己做位移（DesignGuide §8）。
 *
 * 只承担遮罩本体。Radix 的 Overlay 包装留在各调用处：三处的 forceMount 与 Portal 用法不同，
 * 收进来就得再开参数，反而把「这块遮罩长什么样」和「它怎么挂载」搅在一起。
 */
export const OverlayBackdrop = forwardRef<HTMLDivElement, OverlayBackdropProps>(
  ({ placement, className, ...props }, ref) => (
    <motion.div
      ref={ref}
      // 类名排在展开之前：Radix 的 Slot 用 cloneElement 合并属性，子元素自己声明的排在合并进来的前面，
      // 挪到末尾会改掉遮罩在 DOM 上的属性顺序。
      className={cn(PLACEMENT_CLASS[placement], className)}
      {...props}
      variants={backdrop}
      initial="initial"
      animate="animate"
      exit="exit"
    />
  )
);
OverlayBackdrop.displayName = "OverlayBackdrop";
