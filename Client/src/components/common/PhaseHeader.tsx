import { motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { phaseTitleRise } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

interface Props {
  icon: LucideIcon;
  title: string;
  iconClassName?: string;
  titleClassName?: string;
}

/**
 * 阶段标题：标题文字从基线下方的遮罩里升起（`phaseTitleRise`），给阶段切换一个「翻页」信号。
 * 以标题文本为 key：同一阶段里标题原地换字（CEE 的轮次提示）也会重新升起一次。
 */
export function PhaseHeader({ icon: Icon, title, iconClassName, titleClassName }: Props) {
  return (
    <div className="flex min-h-[5.5rem] flex-col items-center justify-start text-center">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">
        <Icon className={cn("h-5 w-5 text-foreground", iconClassName)} />
      </span>
      <h2 className={cn("mt-3 overflow-hidden text-2xl font-semibold leading-8", titleClassName)}>
        <motion.span
          key={title}
          className="block"
          initial={phaseTitleRise.initial}
          animate={phaseTitleRise.animate}
          transition={phaseTitleRise.transition}
        >
          {title}
        </motion.span>
      </h2>
    </div>
  );
}
