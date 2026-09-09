/**
 * 全局图片防拖拽保护模块
 * 拦截浏览器原生 dragstart 事件，彻底杜绝所有 <img> 标签的幽灵虚影拖拽行为。
 */

/**
 * 判断事件目标是否为图片元素，并在命中时阻止原生拖拽默认行为
 */
export function preventImageDrag(event: Event): void {
  const target = event.target;
  if (!target) {
    return;
  }

  const isImg =
    (typeof HTMLImageElement !== "undefined" && target instanceof HTMLImageElement) ||
    (typeof (target as Element).tagName === "string" &&
      (target as Element).tagName.toLowerCase() === "img");

  if (isImg) {
    event.preventDefault();
  }
}

/**
 * 注册全局 dragstart 监听器
 * @returns 销毁监听器的清理函数
 */
export function setupGlobalImageProtection(): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  window.addEventListener("dragstart", preventImageDrag);
  return () => {
    window.removeEventListener("dragstart", preventImageDrag);
  };
}
