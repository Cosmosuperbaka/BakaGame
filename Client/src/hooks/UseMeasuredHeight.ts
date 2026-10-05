import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * 量出元素的布局高度，内容增减时跟着更新，供外层用弹性过渡把高度补间过去。
 * 取 offsetHeight：祖先正在缩放（浮层入场）时布局值不变，高度不会被入场动画带偏。
 * 量不到（未布局、隐藏或测试环境没有布局）时返回 null，调用处不写死高度、交给内容自然撑开。
 */
export function useMeasuredHeight(ref: RefObject<HTMLElement | null>): number | null {
  const [height, setHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const next = node.offsetHeight;
      setHeight(next > 0 ? next : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);

  return height;
}
