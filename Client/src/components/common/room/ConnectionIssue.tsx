import { AnimatePresence, motion } from "framer-motion";
import { WifiOff } from "lucide-react";
import { popover } from "@/lib/motion/Choreography";
import { readoutSwap } from "@/lib/motion/NamedMoves";

/**
 * 顶栏的断线提示：sm 起写成文字，更窄时收成一枚图标（可访问名即文案），两者都随断线出现、恢复后收起。
 * 房间页与排位页共用，样式与动效只在这里维护。
 */
export function ConnectionIssue({ text }: { text?: string | null }) {
  return (
    <AnimatePresence initial={false}>
      {text ? (
        <motion.span
          key="text"
          variants={readoutSwap}
          initial="initial"
          animate="animate"
          exit="exit"
          role="status"
          className="mr-1 hidden shrink-0 text-xs text-destructive motion-safe:animate-breathe sm:inline"
        >
          {text}
        </motion.span>
      ) : null}
      {text ? (
        <motion.span
          key="icon"
          variants={popover}
          initial="initial"
          animate="animate"
          exit="exit"
          role="status"
          aria-label={text}
          className="mr-1 flex shrink-0 text-destructive sm:hidden"
        >
          <WifiOff className="h-4 w-4" aria-hidden="true" />
          {/* 播报读的是区域里的文字，aria-label 只作可访问名；两者同一份文案。 */}
          <span className="sr-only">{text}</span>
        </motion.span>
      ) : null}
    </AnimatePresence>
  );
}
