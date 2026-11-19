import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * 配合 `scroll-fade-y` / `scroll-fade-x`：滚动到哪一头，就收起那一头的淡出。
 *
 * 全站不画滚动条，滚动区靠边缘淡出读出「还有内容」。工具类单用时两头常驻淡出，
 * 要求调用处留出不小于淡出段的内边距；弹窗、标签栏、表格这类贴边排版的滚动区留不出这段余量，
 * 用本钩子只在「那一头还有内容」时淡出，停在顶端或放得下时不裁切任何东西。
 * 直接改滚动区自身的 CSS 变量，不触发重渲染。
 */
export function useScrollFade<T extends HTMLElement>(
  axis: "x" | "y"
): [nodeRef: RefObject<T | null>, ref: (node: T | null) => void] {
  // 用状态接住节点：滚动区可以晚于宿主组件挂载（如展开后才出现的历史表），挂上即接管。
  // 同时写进 ref 对象，供同一滚动区上的其它钩子（标签入视）在 effect 里读取。
  const [node, setNode] = useState<T | null>(null);
  const nodeRef = useRef<T | null>(null);
  const ref = useCallback((next: T | null) => {
    nodeRef.current = next;
    setNode(next);
  }, []);
  useEffect(() => {
    if (!node) return;
    const update = () => {
      const offset = axis === "y" ? node.scrollTop : node.scrollLeft;
      const room =
        axis === "y" ? node.scrollHeight - node.clientHeight : node.scrollWidth - node.clientWidth;
      // 亚像素缩放下滚到底也可能差零点几像素，留一像素容差。
      setEdge(node, "--scroll-fade-start", offset > 1);
      setEdge(node, "--scroll-fade-end", room - offset > 1);
    };
    update();
    node.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(node);
    // 内容增减（展开、换页）不改变滚动区自身尺寸，单独盯住直接子元素。
    for (const child of Array.from(node.children)) observer.observe(child);
    return () => {
      node.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [node, axis]);
  return [nodeRef, ref];
}

/** 那一头还有内容时用工具类的默认淡出宽度，否则收成 0。 */
function setEdge(node: HTMLElement, name: string, more: boolean) {
  if (more) node.style.removeProperty(name);
  else node.style.setProperty(name, "0px");
}

/**
 * 横滑标签栏：当前标签变了就把它横向挪进可见范围，留一点余量露出相邻标签；放得下时不动。
 * 直链或跨标签跳转进来时，靠后的当前标签不会停在视口外。
 */
export function useActiveTabIntoView(scrollerRef: RefObject<HTMLElement | null>, active: string) {
  useEffect(() => {
    const scroller = scrollerRef.current;
    const tab = scroller?.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
    if (!scroller || !tab) return;
    const bounds = scroller.getBoundingClientRect();
    const target = tab.getBoundingClientRect();
    const margin = 32;
    if (target.right > bounds.right) scroller.scrollLeft += target.right - bounds.right + margin;
    else if (target.left < bounds.left) scroller.scrollLeft -= bounds.left - target.left + margin;
  }, [scrollerRef, active]);
}
