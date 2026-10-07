import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * 量出元素的布局尺寸，内容增减时跟着更新，供外层用弹性过渡把宽高补间过去。
 * 取 offsetHeight / offsetWidth：祖先正在缩放（浮层入场）时布局值不变，尺寸不会被入场动画带偏。
 * 量不到（未布局、隐藏或测试环境没有布局）时返回 null，调用处不写死尺寸、交给内容自然撑开。
 */
function useMeasuredSize(ref: RefObject<HTMLElement | null>, axis: "height" | "width"): number | null {
  const [size, setSize] = useState<number | null>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const next = axis === "height" ? node.offsetHeight : node.offsetWidth;
      setSize(next > 0 ? next : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, axis]);

  return size;
}

/** 内容高度：两态交替的外框、搜索结果面板按它补间高度。 */
export function useMeasuredHeight(ref: RefObject<HTMLElement | null>): number | null {
  return useMeasuredSize(ref, "height");
}

/** 内容宽度：文案会变长变短的按钮（「复制」↔「已复制」）按它补间宽度。 */
export function useMeasuredWidth(ref: RefObject<HTMLElement | null>): number | null {
  return useMeasuredSize(ref, "width");
}
