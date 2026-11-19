import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { tappable } from "@/lib/motion/Feedback";
import { cn } from "@/lib/Utils";

/**
 * 可按下的胶囊：`aria-pressed` 表达选中，用于多选。选中是主色浅底与描边；
 * 未选是虚线描边，悬停时描边变实。`idleClassName` 只覆盖未选态（例如暗色弹窗底上要更醒目的虚线色）。
 */
export function ToggleChip({
  pressed,
  onPressedChange,
  idleClassName = "border-border",
  children,
}: {
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  idleClassName?: string;
  children: ReactNode;
}) {
  return (
    <motion.button
      type="button"
      {...tappable}
      aria-pressed={pressed}
      onClick={() => onPressedChange(!pressed)}
      className={cn(
        "rounded-full border px-3 py-1 text-xs transition-colors",
        pressed
          ? "border-primary/40 bg-primary/10 font-medium text-primary"
          : cn(
              "border-dashed bg-transparent text-muted-foreground hover:border-solid hover:text-foreground",
              idleClassName
            )
      )}
    >
      {children}
    </motion.button>
  );
}
