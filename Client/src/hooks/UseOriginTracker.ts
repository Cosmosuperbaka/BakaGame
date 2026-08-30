import { useState } from "react";
import type { OriginPoint } from "@/lib/Motion";

/**
 * 记录最近一次点击的触发元素位置。
 * 浮层据此把 transform-origin 落在按钮上，读作从按钮里被拉出来，
 * 而不是从屏幕正中凭空出现。
 */
export function useOriginTracker() {
  const [origin, setOrigin] = useState<OriginPoint | null>(null);

  const capture = (event: { currentTarget: EventTarget | null }) => {
    const node = event.currentTarget;
    if (!(node instanceof Element)) return;
    const rect = node.getBoundingClientRect();
    setOrigin({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  };

  return { origin, capture };
}
