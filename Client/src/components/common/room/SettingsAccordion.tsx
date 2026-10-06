import { Fragment, useId, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { CollapsibleRegion, DisclosureChevron } from "@/components/ui/Collapsible";
import { SettingsReadOnly } from "@/components/common/room/SettingFields";
import { collapsible, headerTappable } from "@/lib/Motion";

/**
 * 等待页的折叠设置组：标题行整行可点，箭头与展开状态同步翻转。图标只传组件，尺寸与颜色在这里统一。
 * 收起时标题下方一行弱化的摘要（`summary`，各项以「·」相连，只在「·」处换行），不展开也能看出这组设成了什么；展开时摘要收起、让位给字段。
 * 摘要不进按钮的可访问名，经 `aria-describedby` 读出。`readOnly` 时组内字段只显示取值（非房主看到同一份结构）。
 * `badge` 是接在标题后的一枚状态标（网易云账号的连接状态），不论展开与否都在，也只作描述读出。
 */
export function SettingsAccordion({
  icon: Icon,
  title,
  summary,
  open,
  onOpenChange,
  readOnly = false,
  badge,
  children,
}: {
  icon: LucideIcon;
  title: string;
  summary?: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  readOnly?: boolean;
  badge?: ReactNode;
  children: ReactNode;
}) {
  const badgeId = useId();
  const contentId = useId();
  const summaryId = useId();
  const titleId = useId();
  const summaryItems = summary?.filter(Boolean) ?? [];
  const summaryText = summaryItems.length > 0;
  return (
    <div className="overflow-hidden rounded-md border bg-panel">
      {/* 整行标题用 headerTappable：只按压不悬停缩放，免得整行文字随鼠标晃动。 */}
      <motion.button
        type="button"
        {...headerTappable}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-controls={open ? contentId : undefined}
        // 可访问名只取标题：摘要虽在按钮里，作为描述读出，按名字查找时不受摘要内容影响。
        aria-labelledby={titleId}
        aria-describedby={[badge ? badgeId : "", summaryText && !open ? summaryId : ""].filter(Boolean).join(" ") || undefined}
        className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"
      >
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span id={titleId} className="text-sm font-medium">{title}</span>
            {badge ? <span id={badgeId} className="inline-flex">{badge}</span> : null}
          </span>
          <AnimatePresence initial={false}>
            {summaryText && !open ? (
              <motion.span key="summary" variants={collapsible} initial="initial" animate="animate" exit="exit" className="block overflow-hidden">
                <span id={summaryId} className="block pt-1 text-xs leading-relaxed text-muted-foreground">{summaryItems.map((item, index) => (
                  // 每一项整体不断行，窄屏只在「·」处换行，不把「60 秒」拆成两行；超过一行的长项（歌单名、昵称）截断。
                  <Fragment key={index}>
                    {index ? " · " : null}
                    <span className="inline-block max-w-full truncate align-bottom">{item}</span>
                  </Fragment>
                ))}</span>
              </motion.span>
            ) : null}
          </AnimatePresence>
        </span>
        <DisclosureChevron open={open} className="mt-0.5 text-muted-foreground" />
      </motion.button>
      <CollapsibleRegion open={open} id={contentId}>
        <div className="border-t px-4 py-4">
          <SettingsReadOnly readOnly={readOnly}>{children}</SettingsReadOnly>
        </div>
      </CollapsibleRegion>
    </div>
  );
}

/** 一列折叠设置组的统一间距：三个游戏的等待页都用它包住各组，不各写 `space-y`。 */
export function SettingsStack({ children }: { children: ReactNode }) {
  return <div className="space-y-3">{children}</div>;
}
