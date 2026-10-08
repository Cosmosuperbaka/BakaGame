import { Fragment, useId, type ReactNode } from "react";
import { motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { CollapsibleRegion, DisclosureChevron } from "@/components/ui/Collapsible";
import { SettingsReadOnly } from "@/components/common/room/SettingFields";
import { headerTappable } from "@/lib/Motion";

/**
 * 等待页的折叠设置组：标题行整行可点，箭头与展开状态同步翻转。图标只传组件，尺寸与颜色在这里统一。
 * 收起时标题下方一行弱化的摘要（`summary`，各项以「·」相连，只在「·」处换行），不展开也能看出这组设成了什么；展开时摘要收起、让位给字段。
 * 摘要不进按钮的可访问名，经 `aria-describedby` 读出。`readOnly` 时组内字段只显示取值（非房主看到同一份结构）。
 * `badge` 是接在标题后的一枚状态标，不论展开与否都在，也只作描述读出。
 * `media` 替换标题行左侧的图标（网易云账号换成网易云图标），尺寸由调用处给出，须是装饰性的（`alt=""`）。
 * `headline` 给定时接管标题行：标题文字转 `sr-only`（按钮的可访问名仍是组名），行内渲染调用方的富内容
 * （网易云账号的「头像、昵称、会员徽章、到期日」单行）；这行在收起与展开时都常驻，`summary` 与 `badge` 不再渲染，内容经 `aria-describedby` 读出。
 */
export function SettingsAccordion({
  icon: Icon,
  title,
  summary,
  open,
  onOpenChange,
  readOnly = false,
  badge,
  media,
  headline,
  children,
}: {
  icon: LucideIcon;
  title: string;
  summary?: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  readOnly?: boolean;
  badge?: ReactNode;
  media?: ReactNode;
  headline?: ReactNode;
  children: ReactNode;
}) {
  const badgeId = useId();
  const contentId = useId();
  const summaryId = useId();
  const headlineId = useId();
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
        aria-describedby={(headline
          ? [headlineId]
          : [badge ? badgeId : "", summaryText && !open ? summaryId : ""]
        ).filter(Boolean).join(" ") || undefined}
        className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"
      >
        {media ?? <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
        <span className="min-w-0 flex-1">
          {headline ? (
            <>
              {/* 富内容接管标题行：标题文字只留给读屏，按钮的可访问名与描述都不受视觉布局影响。 */}
              <span id={titleId} className="sr-only">{title}</span>
              <span id={headlineId} className="flex min-w-0 items-center gap-x-2">{headline}</span>
            </>
          ) : (
            <>
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span id={titleId} className="text-sm font-medium">{title}</span>
                {badge ? <span id={badgeId} className="inline-flex">{badge}</span> : null}
              </span>
              <CollapsibleRegion as="span" open={summaryText && !open}>
                <span id={summaryId} className="block pt-1 text-xs leading-relaxed text-muted-foreground">{summaryItems.map((item, index) => (
                  // 每一项整体不断行，窄屏只在「·」处换行，不把「60 秒」拆成两行；超过一行的长项（歌单名、昵称）截断。
                  <Fragment key={index}>
                    {index ? " · " : null}
                    <span className="inline-block max-w-full truncate align-bottom">{item}</span>
                  </Fragment>
                ))}</span>
              </CollapsibleRegion>
            </>
          )}
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
