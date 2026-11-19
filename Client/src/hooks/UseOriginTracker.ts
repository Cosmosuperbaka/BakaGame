import { useState } from "react";
import type { OriginPoint } from "@/lib/motion/Origin";

/** 点击目标的中心点：需要同步拿到来源点（写进 store 等）的调用方直接用它，否则用下面的 Hook。 */
export const originOfEvent = (event: { currentTarget: EventTarget | null }): OriginPoint | null => {
  const node = event.currentTarget;
  if (!(node instanceof Element)) return null;
  const rect = node.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};

/**
 * 记录最近一次点击的触发元素位置。
 * 浮层据此把 transform-origin 落在按钮上，读作从按钮里被拉出来，
 * 而不是从屏幕正中凭空出现。
 */
export function useOriginTracker() {
  const [origin, setOrigin] = useState<OriginPoint | null>(null);

  const capture = (event: { currentTarget: EventTarget | null }) => {
    const point = originOfEvent(event);
    if (point) setOrigin(point);
  };

  return { origin, capture };
}
