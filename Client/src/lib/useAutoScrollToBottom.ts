import { useEffect, useRef } from "react";

/** 内容新增或动画改变高度时，将所属 Radix 滚动区稳定地贴到底部。 */
export function useAutoScrollToBottom(changeKey: unknown) {
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const content = contentRef.current;
    const viewport = content?.closest(
      "[data-radix-scroll-area-viewport]",
    ) as HTMLElement | null;
    if (!content || !viewport) return;

    let frame = 0;
    const scrollToBottom = () => {
      frame = 0;
      viewport.scrollTop = viewport.scrollHeight;
    };
    const scheduleScroll = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(scrollToBottom);
    };

    scheduleScroll();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(scheduleScroll);
    observer?.observe(content);
    observer?.observe(viewport);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [changeKey]);

  return contentRef;
}
