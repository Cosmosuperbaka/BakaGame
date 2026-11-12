import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/Button";
import { DisclosureChevron } from "@/components/ui/Collapsible";
import { useMeasuredHeight } from "@/hooks/UseMeasuredHeight";
import { spring } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

/** 收起时保留的行数。只列静态类名，Tailwind 才能扫到。 */
const CLAMP = { 2: "line-clamp-2", 3: "line-clamp-3" } as const;

/**
 * 默认截断的长文本：收起时最多 `lines` 行、行尾省略，第一行右上角的箭头展开全文、再点收起。
 * 只在确实放不下时出现箭头；展开后保留它用于收起。高度经 `useMeasuredHeight` 按 `spring.settle` 补间
 * （折叠区补间高度是 DesignGuide §8 允许的例外），箭头与展开状态同步翻转。
 *
 * 用在资料行、表格单元这类「一行标签 + 一段内容」的位置：内容就地截断，不另起一个折叠标题。
 * 字号、颜色与行高由 `className` 给出，箭头颜色经 `toggleClassName` 跟随所在行（缺省为次要文字色）。
 * `label` 是被截断内容的名称，箭头的可访问名据此写成「展开{label}」「收起{label}」。
 */
export function ClampedText({
  label,
  lines = 2,
  defaultExpanded = false,
  className,
  toggleClassName,
  children,
}: {
  label: string;
  lines?: keyof typeof CLAMP;
  defaultExpanded?: boolean;
  className?: string;
  toggleClassName?: string;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [overflowing, setOverflowing] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);
  const height = useMeasuredHeight(textRef);
  const id = useId();

  // 收起时量是否被截断；所在列宽随容器变化，宽度一变就重量。展开后不量，箭头留着用来收起。
  useLayoutEffect(() => {
    const node = textRef.current;
    if (!node || expanded) return;
    const measure = () => setOverflowing(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [expanded, children]);

  const toggleable = overflowing || expanded;
  return (
    <motion.div
      initial={false}
      animate={height === null ? undefined : { height }}
      transition={spring.settle}
      className="relative overflow-hidden"
    >
      <div
        ref={textRef}
        id={id}
        className={cn(className, !expanded && CLAMP[lines], toggleable && "pr-6")}
      >
        {children}
      </div>
      {toggleable ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          // 外层在补间时裁切溢出：聚焦环向内收，贴着右上角也不被切掉。
          className={cn(
            "absolute top-0 right-0 h-5 w-5 focus-visible:-outline-offset-2",
            toggleClassName ?? "text-muted-foreground"
          )}
          aria-expanded={expanded}
          aria-controls={id}
          aria-label={`${expanded ? "收起" : "展开"}${label}`}
          onClick={() => setExpanded((open) => !open)}
        >
          <DisclosureChevron open={expanded} iconClassName="size-3.5" />
        </Button>
      ) : null}
    </motion.div>
  );
}
