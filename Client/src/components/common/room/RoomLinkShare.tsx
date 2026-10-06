import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Copy, Link } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { readoutSwap } from "@/lib/Motion";
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
        <Button
          type="button"
          variant="outline"
          onClick={() => void handleCopy()}
          // 交替期间旧文案还在淡出，名字固定写在按钮上，读屏与按名查找都只得到当前这一份。
          aria-label={copied ? "已复制" : "复制"}
          // 成功态沿用 success 浅底描边，读作「复制好了」；悬停底色同步换成同色的预览档，不跳回 accent。
          className={cn("shrink-0 gap-1.5 px-3 text-xs", copied && "border-success/40 bg-success/10 text-success hover:bg-success/10 hover:text-success")}
        >
          {/* 图标与文字一起换：旧的抽出文档流淡出，新的自下方顶上来，按钮宽度跟着新文字。 */}
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span key={copied ? "copied" : "idle"} aria-hidden="true" variants={readoutSwap} initial="initial" animate="animate" exit="exit" className="flex items-center gap-1.5">
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "已复制" : "复制"}
            </motion.span>
          </AnimatePresence>
          <span className="sr-only" aria-live="polite">{copied ? "链接已复制" : ""}</span>
        </Button>
      </div>
    </div>
  );
}
