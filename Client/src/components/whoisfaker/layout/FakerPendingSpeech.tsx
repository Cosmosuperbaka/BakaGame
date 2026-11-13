import { motion, useReducedMotion } from "framer-motion";
import { Check } from "lucide-react";
import { ellipsisDot } from "@/lib/motion/Throw";
import { receiptMark } from "@/lib/motion/NamedMoves";
import { cn } from "@/lib/Utils";

const DOTS = [0, 1, 2];

/**
 * 尚未提交或尚未轮到展示的发言占位。
 * 三点依次浮起再落回，读作“还在等这一句”，而非一个空值。
 * 减弱动效时三点静止：这是透明度的无限循环，`MotionConfig reducedMotion="user"` 只关变换、关不掉它；
 * 等待由读屏标签与三点本身表达，不靠闪烁。
 */
export function FakerPendingSpeech({
  className,
  label = "尚未发言",
}: {
  className?: string;
  label?: string;
}) {
  const reduced = useReducedMotion();
  return (
    <span
      className={cn("inline-flex items-center gap-0.5 align-middle", className)}
      role="status"
      aria-label={label}
    >
      {DOTS.map((index) => (
        <motion.span
          key={index}
          custom={index}
          variants={reduced ? undefined : ellipsisDot}
          animate="animate"
          aria-hidden="true"
          className="block size-1 rounded-full bg-muted-foreground"
        />
      ))}
    </span>
  );
}

/**
 * 已提交但顺序未到、内容尚未公开的发言。
 * 与 FakerPendingSpeech 相对：这里等待的是揭示时机，不是这位玩家本人，
 * 因此用一次落位的对勾表示「这一句已经有了」，不再播等待动画。
 */
export function SubmittedSpeech({ className }: { className?: string }) {
  return (
    <motion.span
      className={cn("inline-flex items-center align-middle text-success", className)}
      role="status"
      aria-label="已提交发言"
      {...receiptMark}
    >
      <Check className="h-3.5 w-3.5" aria-hidden="true" />
    </motion.span>
  );
}
