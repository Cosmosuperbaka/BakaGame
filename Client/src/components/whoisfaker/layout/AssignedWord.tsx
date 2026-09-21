import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import type { RefObject } from "react";
import { duration, ease, spring } from "@/lib/Motion";
import { DOCK_SCALE, availableDockWidth, dockScaleFor } from "./AssignedWordLayout";

interface AssignedWordProps {
  /** 本人本局的词语或提示；无值时不渲染 */
  word: string;
  /** 是否处于揭示状态：true 时居中放大，false 时停靠顶栏 */
  revealed: boolean;
  /** 顶栏中为停靠态预留的占位元素 */
  anchorRef: RefObject<HTMLElement | null>;
  /** 居中揭示时依据的区域（游戏区） */
  stageRef: RefObject<HTMLElement | null>;
  /** 测量出的停靠尺寸，交回顶栏设置占位大小 */
  onDockSizeChange: (size: { width: number; height: number }) => void;
}

interface Placement {
  x: number;
  y: number;
  scale: number;
}

/**
 * 词语揭示。整个过程只有一个元素：
 * 从游戏区中心的放大态连续位移并缩小到顶栏停靠位，
 * 不存在两个元素之间的交接，因此没有瞬移。
 */
export function AssignedWord({
  word,
  revealed,
  anchorRef,
  stageRef,
  onDockSizeChange,
}: AssignedWordProps) {
  const wordRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [dock, setDock] = useState<{ width: number; height: number; scale: number } | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  // 以未变形的自然尺寸为基准，按可容纳宽度反推停靠缩放比，
  // 再据此回推停靠占位大小，保证长词语整词可见而不被裁切。
  useLayoutEffect(() => {
    const node = wordRef.current;
    if (!node) return;
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    if (width === 0 || height === 0) return;
    const scale = dockScaleFor(width, availableDockWidth());
    setNatural({ width, height });
    setDock({
      width: Math.ceil(width * scale),
      height: Math.ceil(height * scale),
      scale,
    });
    onDockSizeChange({
      width: Math.ceil(width * scale),
      height: Math.ceil(height * scale),
    });
  }, [word, onDockSizeChange]);

  const measure = useCallback(() => {
    if (!natural || !dock) return;
    if (revealed) {
      const stage = stageRef.current?.getBoundingClientRect();
      if (!stage) return;
      setPlacement({
        x: stage.left + (stage.width - natural.width) / 2,
        y: stage.top + (stage.height - natural.height) / 2,
        scale: 1,
      });
      return;
    }
    const anchor = anchorRef.current?.getBoundingClientRect();
    if (!anchor) return;
    // 锚点按缩后尺寸占位，可能比缩放后的词语宽（锚点有最小宽度）。
    // 居中放置可消化这段余量，长词语也不会越出顶栏右边界。
    setPlacement({
      x: anchor.left + (anchor.width - dock.width) / 2,
      y: anchor.top + (anchor.height - dock.height) / 2,
      scale: dock.scale,
    });
  }, [revealed, natural, dock, anchorRef, stageRef]);

  useLayoutEffect(measure, [measure]);

  // 视口或面板尺寸变化时重新落位，避免停靠位漂移。
  // 同时重新计算停靠缩放，横竖屏切换后长词语依然完整可见。
  useEffect(() => {
    const anchor = anchorRef.current;
    const remeasureScale = () => {
      const node = wordRef.current;
      if (!node) return;
      const width = node.offsetWidth;
      const height = node.offsetHeight;
      if (width === 0 || height === 0) return;
      const scale = dockScaleFor(width, availableDockWidth());
      setDock({
        width: Math.ceil(width * scale),
        height: Math.ceil(height * scale),
        scale,
      });
    };
    window.addEventListener("resize", measure);
    window.addEventListener("resize", remeasureScale);
    const observer = anchor ? new ResizeObserver(measure) : null;
    if (anchor && observer) observer.observe(anchor);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("resize", remeasureScale);
      observer?.disconnect();
    };
  }, [measure, anchorRef]);

  return (
    <motion.div
      ref={wordRef}
      aria-hidden={revealed ? undefined : "true"}
      className="pointer-events-none fixed left-0 top-0 z-modal whitespace-nowrap rounded-md bg-primary/10 px-6 py-3 text-[2.25rem] font-bold leading-tight text-primary"
      style={{ originX: 0, originY: 0 }}
      animate={
        placement
          ? { x: placement.x, y: placement.y, scale: placement.scale, opacity: 1 }
          : { opacity: 0, x: 0, y: 0, scale: DOCK_SCALE }
      }
      transition={
        placement
          ? {
              x: spring.drift,
              y: spring.drift,
              scale: spring.drift,
              opacity: { duration: duration.quick, ease: ease.out },
            }
          : { duration: duration.none }
      }
    >
      {word}
    </motion.div>
  );
}
