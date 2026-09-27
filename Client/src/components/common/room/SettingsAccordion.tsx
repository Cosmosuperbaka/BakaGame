import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { collapsible, pressable, spring } from "@/lib/Motion";

/** 等待页的折叠设置区：标题行整行可点，箭头与展开状态同步翻转。 */
export function SettingsAccordion({
  icon,
  title,
  open,
  onOpenChange,
  children,
}: {
  icon: ReactNode;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div className="rounded-md border">
      <motion.button
        type="button"
        {...pressable}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-sm font-medium transition-colors hover:bg-accent/40"
      >
        {icon}
        <span className="flex-1 text-left">{title}</span>
        <motion.span className="inline-flex text-muted-foreground" animate={{ rotate: open ? 180 : 0 }} transition={spring.snap}>
          <ChevronDown className="h-4 w-4" />
        </motion.span>
      </motion.button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div variants={collapsible} initial="initial" animate="animate" exit="exit" className="overflow-hidden">
            <div className="border-t px-4 py-4">{children}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** 非房主看到的只读设置摘要。 */
export function SettingsChips({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap justify-center gap-2">
      {items.map((item) => (
        <span key={item} className="rounded-md bg-muted px-2.5 py-1 text-xs text-muted-foreground">
          {item}
        </span>
      ))}
    </div>
  );
}
