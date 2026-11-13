import { useEffect, useRef, useState } from "react";
import { wordRevealTiming } from "@/lib/motion/NamedMoves";
import type { WhoIsFakerPhase } from "@bakagame/shared";

/**
 * 词语揭示：true 时居中放大，false 时停靠顶栏；始终是同一个元素在移动。
 * 返回的 `setDockSize` 是 `useState` 的 setter，引用稳定，`FakerAssignedWord` 把它当 effect 依赖。
 */
export function useFakerWordReveal({
  phase,
  day,
  assignedWordText,
}: {
  phase: WhoIsFakerPhase;
  day: number;
  assignedWordText: string | undefined;
}) {
  const [wordRevealed, setWordRevealed] = useState(false);
  const [dockSize, setDockSize] = useState({ width: 0, height: 0 });
  const hasRevealedThisGameRef = useRef(false);
  const wordAnchorRef = useRef<HTMLSpanElement>(null);

  // 重置揭词标记——新局开始时（phase 回到 waiting）清除
  useEffect(() => {
    if (phase === "waiting") hasRevealedThisGameRef.current = false;
  }, [phase]);

  // 仅第一天描述阶段揭示词语，且每局只触发一次
  useEffect(() => {
    if (phase !== "description" || day !== 1 || !assignedWordText || hasRevealedThisGameRef.current)
      return;
    hasRevealedThisGameRef.current = true;
    const show = window.setTimeout(() => setWordRevealed(true), wordRevealTiming.showAfterMs);
    const dock = window.setTimeout(() => setWordRevealed(false), wordRevealTiming.dockAfterMs);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(dock);
      // 揭示途中离开该阶段时收回停靠态，避免下一局残留居中放大。
      setWordRevealed(false);
    };
  }, [phase, day, assignedWordText]);

  return { wordRevealed, dockSize, setDockSize, wordAnchorRef };
}
