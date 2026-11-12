import { useId, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { PresenceBoundary } from "@/components/ui/PresenceBoundary";
import { collapsible, headerTappable, spring } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

// 标题字号跟随所在区域的正文：`sm` 用于 CEE 反馈表这类 text-xs 的密集区域，箭头随字号等比收小。
const SIZES = {
  default: { trigger: "text-sm", icon: "h-4 w-4" },
  sm: { trigger: "text-xs", icon: "h-3.5 w-3.5" },
} as const;

/**
 * 折叠区的指示箭头：展开时翻转朝上，与内容区是同一状态的两种表现（DesignGuide §8）。
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
    <motion.span
      aria-hidden="true"
      className={cn("inline-flex", className)}
      animate={{ rotate: open ? 180 : 0 }}
      transition={spring.snap}
    >
      <ChevronDown className={iconClassName} />
    </motion.span>
  );
}

/**
 * 按 collapsible 变体展开收起的内容区。收起即卸载，首次渲染不播放展开。
 * 外层只承担高度补间与补间期间的裁切（由 `collapsible` 变体切换 `overflow`，落定后不裁，区内的聚焦晕光不被切掉）；
 * 内边距、边框写在子元素上，否则收起到 0 高时仍会露出一条。
 * 放在按钮里时（折叠标题下的摘要）传 `as="span"`：按钮只能包含行内内容，外层随之写成 `block`。
 */
export function CollapsibleRegion({
  open,
  id,
  as = "div",
  className,
  children,
}: {
  open: boolean;
  id?: string;
  as?: "div" | "span";
  className?: string;
  children: ReactNode;
}) {
  const Region = as === "span" ? motion.span : motion.div;
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <Region
          id={id}
          variants={collapsible}
          initial="initial"
          animate="animate"
          exit="exit"
          className={cn(as === "span" && "block", className)}
        >
          {/* 默认展开时区内之后才挂载的内容照常入场 */}
          <PresenceBoundary>{children}</PresenceBoundary>
        </Region>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * 行内折叠区：标题文字按钮 + 同步翻转的箭头，内容按 collapsible 变体展开收起。
 * 标题是一枚轻量的可点胶囊：负外边距抵掉内边距，文字仍与上下文左对齐；悬停铺一层 accent/40
 * （与折叠设置组、复盘标题的整行悬停同一档），展开时标题转为正文色，读得出「这一段是打开的」。
 * 资料行、表格单元里「默认截断、按需展开全文」的长文本不用它，用 `ClampedText`。
 */
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
        className={cn(
          "-mx-1.5 inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 font-serif text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground aria-expanded:text-foreground",
          sizing.trigger
        )}
      >
        {title}
        <DisclosureChevron open={open} iconClassName={sizing.icon} />
      </motion.button>
      <CollapsibleRegion open={open} id={contentId}>
        <div className="pt-1.5">{children}</div>
      </CollapsibleRegion>
    </div>
  );
}
