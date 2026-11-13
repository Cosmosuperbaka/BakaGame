import { useCallback, useEffect, useRef, useState } from "react";

/** 距底部不超过这个距离仍算「在底部」：触控滚动与子像素取整都会留下几像素的余量。 */
const STICK_THRESHOLD = 48;

/**
 * 消息流的贴底跟随：只有玩家本来就在底部时才跟着新内容往下走，上翻翻看历史时不打扰。
 * 「有没有新消息」只认最后一项的标识，不看条数：客户端窗口满了以后条数恒定，条数不会再变。
 *
 * - `viewportRef` 挂在滚动容器上，`contentRef` 挂在它里面随内容增高的那一层，动画撑高内容时也能继续贴底。
 * - `force` 为真时这一项无论玩家在哪都贴底（自己刚发出的消息）。
 * - `unseen` 为真表示玩家上翻期间来了新项，调用方据此显示回到底部的入口。
 */
export function useStickToBottom(lastItemId: string | undefined, force = false) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // 观察器回调里读的「是否在底部」；渲染读下面的状态，不读 ref。
  const atBottomRef = useRef(true);
  const frameRef = useRef(0);
  const [atBottom, setAtBottom] = useState(true);
  // 玩家已经看到的最后一项：在底部或被强制贴底时跟着走，上翻期间停在原地。
  const [seen, setSeen] = useState(lastItemId);
  const [tracked, setTracked] = useState(lastItemId);
  const [trackedBottom, setTrackedBottom] = useState(true);
  if (tracked !== lastItemId) {
    setTracked(lastItemId);
    if (force || atBottom) setSeen(lastItemId);
  }
  // 玩家自己滚回底部就算看完了所有消息。
  if (trackedBottom !== atBottom) {
    setTrackedBottom(atBottom);
    if (atBottom) setSeen(lastItemId);
  }
  const unseen = !atBottom && seen !== lastItemId;

  const schedule = useCallback(() => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const viewport = viewportRef.current;
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    });
  }, []);

  // 跟随：最后一项换了而玩家没落下（在底部或被强制）就贴底；首次挂载也贴一次。
  useEffect(() => {
    if (!unseen) schedule();
  }, [lastItemId, unseen, schedule]);

  // 玩家自己滚动：更新是否在底部。
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onScroll = () => {
      const near =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= STICK_THRESHOLD;
      atBottomRef.current = near;
      setAtBottom(near);
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, []);

  // 内容或视口尺寸变了（气泡入场撑高、窗口缩放）：在底部就继续贴底。
  useEffect(() => {
    const content = contentRef.current;
    const viewport = viewportRef.current;
    if (!content || !viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (atBottomRef.current) schedule();
    });
    observer.observe(content);
    observer.observe(viewport);
    return () => {
      observer.disconnect();
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [schedule]);

  const scrollToBottom = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
    atBottomRef.current = true;
    setAtBottom(true);
  }, []);

  return { viewportRef, contentRef, unseen, scrollToBottom };
}
