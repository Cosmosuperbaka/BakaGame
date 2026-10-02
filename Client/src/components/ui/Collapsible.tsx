import { useId, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { collapsible, headerTappable, spring } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

// 标题字号跟随所在区域的正文：`sm` 用于 CCB 反馈表这类 text-xs 的密集区域，箭头随字号等比收小。
const SIZES = {
  default: { trigger: "text-sm", icon: "h-4 w-4" },
  sm: { trigger: "text-xs", icon: "h-3.5 w-3.5" },
} as const;

/**
 * 折叠区的指示箭头：展开时翻转朝上，与内容区是同一状态的两种表现（Animation §2.4）。
 * 装饰性图标，对读屏隐藏；展开状态由触发按钮的 `aria-expanded` 表达。
 */
export function DisclosureChevron({
  open,
  className,
  iconClassName = "h-4 w-4",
}: {
  open: boolean;
  className?: string;
  iconClassName?: string;
}) {
  return (
    <motion.span aria-hidden="true" className={cn("inline-flex", className)} animate={{ rotate: open ? 180 : 0 }} transition={spring.snap}>
      <ChevronDown className={iconClassName} />
    </motion.span>
  );
}

/**
 * 按 collapsible 变体展开收起的内容区。收起即卸载，首次渲染不播放展开。
 * 外层只承担高度裁切（`overflow-hidden`）；内边距、边框写在子元素上，否则收起到 0 高时仍会露出一条。
 */
export function CollapsibleRegion({
  open,
  id,
  className,
  children,
}: {
  open: boolean;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div id={id} variants={collapsible} initial="initial" animate="animate" exit="exit" className={cn("overflow-hidden", className)}>
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/** 行内折叠区：标题文字按钮 + 同步翻转的箭头，内容按 collapsible 变体展开收起。 */
export function Collapsible({
  title,
  defaultOpen = false,
  size = "default",
  className,
  children,
}: {
  title: ReactNode;
  defaultOpen?: boolean;
  size?: "default" | "sm";
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  const sizing = SIZES[size];
  return (
    <div className={className}>
      <motion.button
        type="button"
        {...headerTappable}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        // 收起时内容已卸载，只在展开时指向内容区，免得引用不存在的元素。
        aria-controls={open ? contentId : undefined}
        className={cn("inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground", sizing.trigger)}
      >
        {title}
        <DisclosureChevron open={open} iconClassName={sizing.icon} />
      </motion.button>
      <CollapsibleRegion open={open} id={contentId}>
        <div className="pt-2">{children}</div>
      </CollapsibleRegion>
    </div>
  );
}
