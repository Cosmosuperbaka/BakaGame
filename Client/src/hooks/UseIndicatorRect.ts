import { useLayoutEffect, useState, type RefObject } from "react";

/** 选中指示器相对容器的布局位置。取 offset 系列的布局值，不受祖先 transform 影响。 */
export interface IndicatorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const sameRect = (a: IndicatorRect | null, b: IndicatorRect) =>
  a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * 量出容器内选中项的位置，供标签页、分段控件的同一个指示器滑过去。
 * 用 offsetLeft / offsetWidth 而不是 getBoundingClientRect：弹窗展开时祖先正在缩放，
 * 包围盒跟着变，布局值不变，指示器就不会在开合途中被带着飘。
 * `activeKey` 是当前选中值，变了就重新测量；容器或选项尺寸变化（字体载入、窄屏换行）也会重新测量。
 * 选中项不可见（宽度为 0，如所在面板隐藏）时返回 null，再次可见时指示器直接落位，不从左上角飞过来。
 * 容器须是定位元素，选中项的 offsetParent 才是它；指示器自身带 `data-indicator`，不参与观察。
 */
export function useIndicatorRect(
  containerRef: RefObject<HTMLElement | null>,
  activeSelector: string,
  activeKey: unknown,
): IndicatorRect | null {
  const [rect, setRect] = useState<IndicatorRect | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const target = container.querySelector<HTMLElement>(activeSelector);
      if (!target || target.offsetWidth === 0) {
        setRect(null);
        return;
      }
      const next = { x: target.offsetLeft, y: target.offsetTop, width: target.offsetWidth, height: target.offsetHeight };
      setRect((previous) => (sameRect(previous, next) ? previous : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    for (const child of Array.from(container.children)) {
      if (!(child as HTMLElement).dataset.indicator) observer.observe(child);
    }
    return () => observer.disconnect();
  }, [containerRef, activeSelector, activeKey]);

  return rect;
}
