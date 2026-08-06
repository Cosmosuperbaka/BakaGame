import { motion } from "framer-motion";
import { ellipsisDot } from "@/lib/motion";
import { cn } from "@/lib/utils";

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
