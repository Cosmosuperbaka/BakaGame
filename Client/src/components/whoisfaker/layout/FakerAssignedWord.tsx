import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import type { RefObject } from "react";
import { duration, ease, spring } from "@/lib/motion/Transitions";
import { wordDock } from "@/lib/motion/NamedMoves";
import { cn } from "@/lib/Utils";

/**
 * 停靠状态的缩放比。词语始终以放大尺寸渲染，停靠时缩小，
 * 因此两端都是清晰字形，中间过程只有 transform 在变化。
 */

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
export function FakerAssignedWord({
  word,
  revealed,
  anchorRef,
  stageRef,
  onDockSizeChange,
}: AssignedWordProps) {
  const wordRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  /** 单行排开时的自然宽度：停靠位按它申请宽度，中栏放得下时就不折行。 */
  const singleLineWidthRef = useRef(0);
  /**
   * 中栏放不下单行时的折行宽度（未缩放的像素）。停靠元素是固定定位，不受中栏裁切，
   * 宽过中栏就会盖住右侧的反馈、设置等图标；折成至多两行后仍是同一个元素，
   * 揭示与停靠两端用同一宽度，过渡途中不重排。
   */
  const [wrapWidth, setWrapWidth] = useState<number | null>(null);

  // 以未变形的自然尺寸为基准，反推停靠占位大小：宽度按单行申请，高度按当前（可能折行的）实际高度。
  useLayoutEffect(() => {
    const node = wordRef.current;
    if (!node) return;
    const { maxWidth, whiteSpace } = node.style;
    node.style.maxWidth = "none";
    node.style.whiteSpace = "nowrap";
    const singleLine = node.offsetWidth;
    node.style.maxWidth = maxWidth;
    node.style.whiteSpace = whiteSpace;
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    if (width === 0 || height === 0) return;
    singleLineWidthRef.current = singleLine;
    setNatural({ width, height });
    onDockSizeChange({
      width: Math.ceil(singleLine * wordDock.scale),
      height: Math.ceil(height * wordDock.scale),
    });
  }, [word, wrapWidth, onDockSizeChange]);

  const measure = useCallback(() => {
    if (!natural) return;
    // 停靠位在中栏里可以被挤窄：比单行窄时按它的实际宽度折行。
    const anchorWidth = anchorRef.current?.getBoundingClientRect().width ?? 0;
    const wanted = Math.ceil(singleLineWidthRef.current * wordDock.scale);
    setWrapWidth(
      anchorWidth > 0 && anchorWidth + 1 < wanted ? Math.floor(anchorWidth / wordDock.scale) : null
    );
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
    setPlacement({ x: anchor.left, y: anchor.top, scale: wordDock.scale });
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
      data-agent-focus="private"
      aria-hidden={revealed ? undefined : "true"}
      // 揭示态盖在揭词背板之上取 z-modal；停靠后只是顶栏里的一枚标签，降到 z-sticky，让抽屉与弹窗盖得住它。
      // 停靠后与顶栏的 HeaderChip 同一语言：实底 bg-muted 配正文色，主色不作正文（DesignGuide §3）。
      className={cn(
        "pointer-events-none fixed left-0 top-0 rounded-md bg-muted px-6 py-3 text-4xl font-bold leading-tight text-foreground",
        wrapWidth === null ? "whitespace-nowrap" : "whitespace-normal [overflow-wrap:anywhere]",
        revealed ? "z-modal" : "z-sticky"
      )}
      style={{ originX: 0, originY: 0, maxWidth: wrapWidth ?? undefined }}
      animate={
        placement
          ? { x: placement.x, y: placement.y, scale: placement.scale, opacity: 1 }
          : { opacity: 0, x: 0, y: 0, scale: wordDock.scale }
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
      {/* 折行时最多两行：停靠后两行仍在顶栏高度之内，超长的提示以省略号收尾。
        截断放在内层：外层的内边距不参与裁切，第三行不会从底边露出半截。 */}
      <span className={wrapWidth === null ? undefined : "line-clamp-2"}>{word}</span>
    </motion.div>
  );
}
