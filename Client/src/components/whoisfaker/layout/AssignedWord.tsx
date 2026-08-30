import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import type { RefObject } from "react";
import { duration, ease, spring } from "@/lib/Motion";

/**
 * 停靠状态的缩放比。词语始终以放大尺寸渲染，停靠时缩小，
 * 因此两端都是清晰字形，中间过程只有 transform 在变化。
 */
const DOCK_SCALE = 0.34;

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
  const [placement, setPlacement] = useState<Placement | null>(null);

  // 以未变形的自然尺寸为基准，反推停靠占位大小。
  useLayoutEffect(() => {
    const node = wordRef.current;
    if (!node) return;
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    if (width === 0 || height === 0) return;
    setNatural({ width, height });
    onDockSizeChange({
      width: Math.ceil(width * DOCK_SCALE),
      height: Math.ceil(height * DOCK_SCALE),
    });
  }, [word, onDockSizeChange]);

  const measure = useCallback(() => {
    if (!natural) return;
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
    setPlacement({ x: anchor.left, y: anchor.top, scale: DOCK_SCALE });
  }, [revealed, natural, anchorRef, stageRef]);

  useLayoutEffect(measure, [measure]);

  // 视口或面板尺寸变化时重新落位，避免停靠位漂移。
  useEffect(() => {
    const anchor = anchorRef.current;
    window.addEventListener("resize", measure);
    const observer = anchor ? new ResizeObserver(measure) : null;
    if (anchor && observer) observer.observe(anchor);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [measure, anchorRef]);

  return (
    <motion.div
      ref={wordRef}
      aria-hidden={revealed ? undefined : "true"}
      className="pointer-events-none fixed left-0 top-0 z-[60] whitespace-nowrap rounded-xl bg-primary/10 px-6 py-3 text-[2.25rem] font-bold leading-tight text-primary"
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
