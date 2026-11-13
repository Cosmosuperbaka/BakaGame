import { useRef, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { Hint } from "@/components/ui/Tooltip";
import { useMeasuredHeight } from "@/hooks/UseMeasuredHeight";
import { listContainer, listItem } from "@/lib/motion/Choreography";
import { optionTappable } from "@/lib/motion/Feedback";
import { spring } from "@/lib/motion/Transitions";
import { cn } from "@/lib/Utils";

/** 面板里的说明行：`busy` 查询中、`info` 空结果之类的说明、`error` 失败（读屏立即播报）。 */
export interface SearchStatus {
  tone: "busy" | "info" | "error";
  text: string;
}

/** 二级列表（作品下的角色、番剧下的关联曲）顶上的返回行，键盘也能选到。 */
export interface SearchBack {
  label: string;
  /** 行尾的补充说明，如当前所在的作品名 */
  detail?: string;
  onBack: () => void;
}

export type SearchItem<T> =
  { kind: "back"; key: string; back: SearchBack } | { kind: "option"; key: string; option: T };

interface SearchPanelProps<T> {
  items: SearchItem<T>[];
  listId: string;
  listKey: string;
  label: string;
  status: SearchStatus | null;
  activeIndex: number;
  pendingKey: string | null;
  optionId: (index: number) => string;
  unavailable: (item: SearchItem<T>) => boolean;
  agentControlPrefix?: string;
  renderOption: (option: T) => ReactNode;
  onHighlight: (index: number) => void;
  onChoose: (item: SearchItem<T>) => void;
}

/**
 * 面板内容。高度随候选多少用弹性补间（`spring.settle`），换一批结果、进出二级列表时面板平滑伸缩，不跳。
 * 旧的一批候选经 popLayout 抽出文档流、按序淡出，新的一批同时推入，两批交叉而不是先清空再出现。
 */
export function SearchPanel<T>({
  items,
  listId,
  listKey,
  label,
  status,
  activeIndex,
  pendingKey,
  optionId,
  unavailable,
  agentControlPrefix,
  renderOption,
  onHighlight,
  onChoose,
}: SearchPanelProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const height = useMeasuredHeight(scrollRef);
  const backRows = items[0]?.kind === "back" ? 1 : 0;

  return (
    <motion.div
      initial={false}
      animate={height === null ? undefined : { height }}
      transition={spring.settle}
      className="overflow-hidden"
    >
      <div
        ref={scrollRef}
        className="scrollbar-hidden relative max-h-[min(22rem,var(--radix-popover-content-available-height))] overflow-y-auto overscroll-contain"
      >
        {status ? (
          <motion.p
            key={`${status.tone}:${status.text}`}
            variants={listItem}
            initial="initial"
            animate="animate"
            style={{ originX: 0 }}
            role={status.tone === "error" ? "alert" : "status"}
            className={cn(
              "flex items-center gap-2 px-3 py-3 text-sm",
              status.tone === "error" ? "text-destructive" : "text-muted-foreground",
              items.length > 0 && "border-b"
            )}
          >
            {status.tone === "busy" ? <Spinner /> : null}
            {status.text}
          </motion.p>
        ) : null}
        <AnimatePresence initial={false} mode="popLayout">
          {items.length > 0 ? (
            <motion.ul
              key={listKey}
              id={listId}
              role="listbox"
              aria-label={`${label}结果`}
              variants={listContainer(items.length)}
              initial="initial"
              animate="animate"
              exit="exit"
              className="w-full"
            >
              {items.map((item, index) => {
                const blocked = unavailable(item);
                const highlighted = index === activeIndex;
                // 返回行至多一条且排在最前，候选的序号就是行号减去它占的那一行
                const optionIndex = index - backRows;
                return (
                  <motion.li
                    key={item.key}
                    id={optionId(index)}
                    role="option"
                    aria-selected={highlighted}
                    aria-disabled={blocked || undefined}
                    data-active={highlighted || undefined}
                    data-agent-control={
                      agentControlPrefix
                        ? item.kind === "back"
                          ? `${agentControlPrefix}.back`
                          : `${agentControlPrefix}.result.${optionIndex}`
                        : undefined
                    }
                    variants={listItem}
                    style={{ originX: 0 }}
                    {...(blocked ? undefined : optionTappable)}
                    onMouseMove={() => onHighlight(index)}
                    onClick={() => onChoose(item)}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-center gap-3 border-t px-3 py-2 text-sm transition-colors first:border-t-0",
                      // 不可选的行被键盘或指针经过时只铺弱化底：仍让人看见当前位置，但不像可选行那样亮起来
                      blocked
                        ? "cursor-not-allowed data-active:bg-muted"
                        : "data-active:bg-accent data-active:text-accent-foreground",
                      item.kind === "back" && "text-muted-foreground"
                    )}
                  >
                    {item.kind === "back" ? (
                      <>
                        <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
                        <span className="shrink-0 font-medium">{item.back.label}</span>
                        {item.back.detail ? (
                          <span className="ml-auto min-w-0 truncate text-xs">
                            {item.back.detail}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <div
                          className={cn(
                            "flex min-w-0 flex-1 items-center gap-3",
                            blocked && pendingKey !== item.key && "opacity-50"
                          )}
                        >
                          {renderOption(item.option)}
                        </div>
                        {pendingKey === item.key ? <Spinner className="text-primary" /> : null}
                      </>
                    )}
                  </motion.li>
                );
              })}
            </motion.ul>
          ) : null}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

/**
 * 候选行的常用内容：缩略图加两行文字（主名、副名），文字过长时截断并保留完整 `title`。
 * `trailing` 放行尾的标记（「已被选择」、会员专享徽章、年份）。
 */
export function SearchOptionContent({
  media,
  title,
  subtitle,
  trailing,
}: {
  media?: ReactNode;
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
}) {
  return (
    <>
      {media}
      <span className="min-w-0 flex-1">
        {/* 标题与副标题都会按列表宽度截断，悬停给出完整文本 */}
        <Hint label={title}>
          <span className="block truncate font-medium">{title}</span>
        </Hint>
        {subtitle ? (
          <Hint label={subtitle}>
            <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>
          </Hint>
        ) : null}
      </span>
      {trailing ? <span className="shrink-0 text-xs text-muted-foreground">{trailing}</span> : null}
    </>
  );
}
