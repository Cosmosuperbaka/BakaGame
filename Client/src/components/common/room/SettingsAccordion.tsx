import { Fragment, useId, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { CollapsibleRegion, DisclosureChevron } from "@/components/ui/Collapsible";
import { SettingsReadOnly } from "@/components/common/room/SettingFields";
import { headerTappable, readoutSwap } from "@/lib/Motion";

/**
 * 等待页的折叠设置组：标题行整行可点，箭头与展开状态同步翻转。图标只传组件，尺寸与颜色在这里统一。
 * 收起时标题下方一行弱化的摘要（`summary`，各项以「·」相连，只在「·」处换行），不展开也能看出这组设成了什么；展开时摘要收起、让位给字段。
 * 摘要不进按钮的可访问名，经 `aria-describedby` 读出。`readOnly` 时组内字段只显示取值（非房主看到同一份结构）。
 * `badge` 是接在标题后的一枚状态标，不论展开与否都在，也只作描述读出。
 * `media` 替换标题行左侧的图标（网易云账号换成网易云图标），尺寸由调用处给出，须是装饰性的（`alt=""`）。
 * `headline` 给定时收起态接管标题行：标题文字转 `sr-only`（按钮的可访问名仍是组名），行内渲染调用方的富内容
 * （网易云账号的「头像、昵称、会员徽章、到期日」单行），内容经 `aria-describedby` 读出；展开后行内换回普通的标题文字
 * （展开卡里已有同一份信息，标题行不再重复），两态以 `readoutSwap` 在原地交叉替换，`summary` 与 `badge` 不再渲染。
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
  // 描述：接管标题行时取行内富内容；展开后行内已换回可见的标题文字，账号行不再重复朗读。
  const describedBy = (headline
    ? [open ? "" : headlineId]
    : [badge ? badgeId : "", summaryText && !open ? summaryId : ""]
  ).filter(Boolean).join(" ") || undefined;
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
        aria-describedby={describedBy}
        className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"
      >
        {media ?? <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
        <span className="min-w-0 flex-1">
          {headline ? (
            <>
              {/* 标题文字只留给读屏：按钮的可访问名与描述都不受视觉布局影响；展开时行内另有一份同文案的可见标题。 */}
              <span id={titleId} className="sr-only">{title}</span>
              {/* 两态在同一格里叠放交叉替换（Animation §2.4）。这一格必须定位：popLayout 量的是
                  「相对 offsetParent 的 offsetTop/offsetLeft」，播放时却按包含块解释。按钮的 whileTap
                  缩放会让它自己成为包含块（测量瞬间更近、优先命中），松手后弹簧归位把 transform 抹成
                  none，包含块就塌到更上层的阶段舞台（它靠 will-change: transform 当包含块）——
                  于是「行内小偏移」被当成「距舞台原点」，退场的一态会闪现在舞台左上角。定位在这一格后，
                  测量与播放的包含块始终是这一格，按钮缩放的起落与更上层舞台都不再影响落位。 */}
              <span className="relative grid min-w-0 items-center">
                <AnimatePresence initial={false} mode="popLayout">
                  {open ? (
                    <motion.span key="title" variants={readoutSwap} initial="initial" animate="animate" exit="exit"
                      className="col-start-1 row-start-1 text-sm font-medium" aria-hidden="true">{title}</motion.span>
                  ) : (
                    <motion.span key="headline" variants={readoutSwap} initial="initial" animate="animate" exit="exit"
                      className="col-start-1 row-start-1 flex min-w-0 items-center gap-x-2">
                      <span id={headlineId} className="flex min-w-0 items-center gap-x-2">{headline}</span>
                    </motion.span>
                  )}
                </AnimatePresence>
              </span>
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
