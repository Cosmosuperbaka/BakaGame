import { useCallback, useRef, type ReactNode, type Ref } from "react";
import { motion } from "framer-motion";
import { CheckCircle2, Sword, Undo2, Vote } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  listItem,
  receiptCard,
  receiptMarkFollow,
  selectable,
  useOriginStyle,
  type OriginPoint,
} from "@/lib/Motion";
import { cn } from "@/lib/Utils";

/**
 * 投票与夜晚行动的选项卡：同一种实色块（`bg-muted`），按阶段换图标与悬停预览。
 * 夜晚是对某人出手，图标取 Sword、悬停取 destructive 的预览档，与投票的中性悬停区分开。
 */
export function TargetOption({
  name,
  tone,
  disabled,
  onSelect,
}: {
  name: string;
  tone: "vote" | "night";
  disabled?: boolean;
  onSelect: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const Icon = tone === "night" ? Sword : Vote;
  return (
    <motion.button
      type="button"
      variants={listItem}
      {...selectable}
      title={name}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex min-w-0 cursor-pointer items-center justify-between rounded-md bg-muted px-4 py-3.5 text-left transition-colors",
        tone === "night" ? "hover:bg-destructive/5" : "hover:bg-accent/40",
      )}
    >
      <span className="truncate text-sm font-medium">{name}</span>
      <Icon className={cn("ml-2 h-4 w-4 shrink-0", tone === "night" ? "text-destructive" : "text-muted-foreground")} />
    </motion.button>
  );
}

/**
 * 提交回执。选项网格与回执是同一次决定的前后两面：两者经 `AnimatePresence mode="popLayout"` 交叉，
 * 回执的缩放原点落在被点的那张选项上（`origin`），读作「这张卡被接住了」；撤销时沿原路收回。
 * 没有点击来源（刷新后已投过票）时从自身中心展开。
 */
export function ActionReceipt({
  title,
  detail,
  origin,
  busy,
  onUndo,
  ref,
}: {
  title: string;
  detail: ReactNode;
  origin: OriginPoint | null;
  busy: boolean;
  onUndo: () => void;
  /** popLayout 需要量出退场元素的位置 */
  ref?: Ref<HTMLDivElement>;
}) {
  const localRef = useRef<HTMLDivElement>(null);
  const originStyle = useOriginStyle(localRef, origin);
  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      localRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  return (
    <motion.div
      ref={setRef}
      initial={receiptCard.initial}
      animate={receiptCard.animate}
      exit={receiptCard.exit}
      transition={receiptCard.transition}
      style={originStyle}
      className="mx-auto flex max-w-sm items-center justify-between gap-3 rounded-md border border-primary/40 bg-primary/10 px-4 py-3"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <motion.span className="inline-flex shrink-0" {...receiptMarkFollow}>
          <CheckCircle2 className="h-5 w-5 text-primary" />
        </motion.span>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">{title}</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</div>
        </div>
      </div>
      <Button variant="ghost" size="sm" className="shrink-0" loading={busy} onClick={onUndo}>
        {busy ? null : <Undo2 className="h-3.5 w-3.5" />}
        撤销
      </Button>
    </motion.div>
  );
}
