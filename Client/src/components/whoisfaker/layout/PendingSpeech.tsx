import { motion } from "framer-motion";
import { Check } from "lucide-react";
import { ellipsisDot, spring } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

const DOTS = [0, 1, 2];

/**
 * 尚未提交或尚未轮到展示的发言占位。
 * 三点依次浮起再落回，读作“还在等这一句”，而非一个空值。
 */
export function PendingSpeech({
  className,
  label = "尚未发言",
}: {
  className?: string;
  label?: string;
}) {
  return (
    <span
      className={cn("inline-flex items-center gap-[3px] align-middle", className)}
      role="status"
      aria-label={label}
    >
      {DOTS.map((index) => (
        <motion.span
          key={index}
          custom={index}
          variants={ellipsisDot}
          animate="animate"
          aria-hidden="true"
          className="block h-[3px] w-[3px] rounded-full bg-muted-foreground/70"
        />
      ))}
    </span>
  );
}

/**
 * 已提交但顺序未到、内容尚未公开的发言。
 * 与 PendingSpeech 相对：这里等待的是揭示时机，不是这位玩家本人，
 * 因此用一次落位的对勾表示「这一句已经有了」，不再播等待动画。
 */
export function SubmittedSpeech({ className }: { className?: string }) {
  return (
    <motion.span
      className={cn("inline-flex items-center align-middle text-emerald-700 dark:text-emerald-400", className)}
      role="status"
      aria-label="已提交发言"
      initial={{ scale: 0.4, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={spring.impulse}
    >
      <Check className="h-3.5 w-3.5" aria-hidden="true" />
    </motion.span>
  );
}
