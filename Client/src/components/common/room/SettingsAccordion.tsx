import { useId, type ReactNode } from "react";
import { motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { CollapsibleRegion, DisclosureChevron } from "@/components/ui/Collapsible";
import { headerTappable } from "@/lib/Motion";

/** 等待页的折叠设置区：标题行整行可点，箭头与展开状态同步翻转。图标只传组件，尺寸与颜色在这里统一。 */
export function SettingsAccordion({
  icon: Icon,
  title,
  open,
  onOpenChange,
  children,
}: {
  icon: LucideIcon;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const contentId = useId();
  return (
    <div className="rounded-md border">
      {/* 整行标题用 headerTappable：只按压不悬停缩放，免得整行文字随鼠标晃动。 */}
      <motion.button
        type="button"
        {...headerTappable}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-controls={open ? contentId : undefined}
        className="flex w-full items-center gap-2 px-4 py-3 text-sm font-medium transition-colors hover:bg-accent/40"
      >
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="flex-1 text-left">{title}</span>
        <DisclosureChevron open={open} className="text-muted-foreground" />
      </motion.button>
      <CollapsibleRegion open={open} id={contentId}>
        <div className="border-t px-4 py-4">{children}</div>
      </CollapsibleRegion>
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
