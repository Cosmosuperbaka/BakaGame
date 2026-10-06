import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Check, Copy, Link } from "lucide-react";
import { pressable } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

/** 「已复制」反馈的停留时长：给玩家读完提示的时间，不参与任何业务时序。 */
const COPIED_FEEDBACK_MS = 2_000;

/** 等待页的房间链接：展示完整地址并一键复制，复制失败交给调用方提示。 */
export function RoomLinkShare({ path, onCopyError }: { path: string; onCopyError: () => void }) {
  const [copied, setCopied] = useState(false);
  const shareUrl = `${window.location.origin}${path}`;

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
    } catch {
      onCopyError();
    }
  };

  return (
    // 标题与下方设置字段同一间距（gap-1.5）；它不是某个控件的 label，没有 htmlFor 目标，写成普通文字。
    // 列宽取 minmax(0,1fr)：默认的 auto 列按长链接的最小内容宽度撑开，窄屏上复制按钮会被挤出卡片。
    <div className="grid w-full grid-cols-1 gap-1.5">
      <p className="text-xs font-medium text-muted-foreground">房间链接</p>
      <div className="flex gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
          <Link className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{shareUrl}</span>
        </div>
        <motion.button
          type="button"
          {...pressable}
          onClick={() => void handleCopy()}
          aria-live="polite"
          className={cn(
            "flex h-9 shrink-0 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors",
            copied ? "border-success/40 bg-success/10 text-success" : "hover:bg-accent hover:text-accent-foreground",
          )}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "已复制" : "复制"}
        </motion.button>
      </div>
    </div>
  );
}
