import { useRef, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ScrollArea } from "@/components/ui/ScrollArea";
import { phaseSwap } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

/**
 * 游戏区的阶段舞台：统一内边距 `p-6 md:p-8` 与独立滚动。
 * 阶段切换用 phaseSwap（新内容自后推入、旧内容向前退出），落定后清除残留 transform，
 * 避免分数缩放让文本子像素抖动。三个游戏的游戏区都挂在这里。
 */
export function PhaseStage({
  phaseKey,
  children,
  before,
  overlays,
  reserveBottom = false,
  onPhaseSettled,
}: {
  /** 阶段标识，变化即触发切换 */
  phaseKey: string;
  children: ReactNode;
  /** 阶段内容之上、不随阶段切换的区块（如倒计时控制） */
  before?: ReactNode;
  /** 滚动区之外、游戏区内的浮层（测试控制器、揭词背板等） */
  overlays?: ReactNode;
  /** 底部固定控件存在时为滚动内容留出空间 */
  reserveBottom?: boolean;
  /** 新阶段进场落定后调用 */
  onPhaseSettled?: () => void;
}) {
  const phaseRef = useRef<HTMLDivElement>(null);
  return (
    <div className={cn("relative flex min-h-0 flex-1 flex-col overflow-hidden", reserveBottom && "pb-16")}>
      <ScrollArea data-testid="game-area-scroll" className="min-h-0 flex-1">
        <div className="p-6 md:p-8">
          {before}
          <AnimatePresence mode="wait">
            <motion.div
              key={phaseKey}
              ref={phaseRef}
              variants={phaseSwap}
              initial="initial"
              animate="animate"
              exit="exit"
              onAnimationComplete={(definition) => {
                if (definition !== "animate") return;
                if (phaseRef.current) phaseRef.current.style.transform = "";
                onPhaseSettled?.();
              }}
              style={{ willChange: "transform, opacity" }}
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </div>
      </ScrollArea>
      {overlays}
    </div>
  );
}
