import { useId, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { collapsible, headerTappable, spring } from "@/lib/Motion";

/** 行内折叠区：标题文字按钮 + 同步翻转的箭头，内容按 collapsible 变体展开收起。 */
export function Collapsible({
  title,
  defaultOpen = false,
  className,
  children,
}: {
  title: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  return (
    <div className={className}>
      <motion.button
        type="button"
        {...headerTappable}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={contentId}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        {title}
        <motion.span className="inline-flex" animate={{ rotate: open ? 180 : 0 }} transition={spring.snap}>
          <ChevronDown className="h-4 w-4" />
        </motion.span>
      </motion.button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div id={contentId} variants={collapsible} initial="initial" animate="animate" exit="exit" className="overflow-hidden">
            <div className="pt-2">{children}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
