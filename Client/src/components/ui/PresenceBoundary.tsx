import { useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { PresenceContext } from "framer-motion";

/** 已完成首次提交的边界（按实例记）：之后挂载的子项读到的 `initial` 不再屏蔽入场。 */
const committed = new WeakSet<object>();

/**
 * 「首次不播入场」的边界。`AnimatePresence initial={false}` 只想跳过首屏那一次入场，
 * 但 framer-motion 把 `initial: false` 记进子项的 Presence 上下文后就不再更新：
 * 只要容器是首屏就在的那个子项，它里面**之后才挂载**的元素也一律被当成首屏、跳过入场
 * （新到的猜测不翻牌、追加的列表项直接出现）。
 *
 * 包在这类长寿命容器的内容外：边界首次提交时已在的元素照旧跳过入场，之后挂载的元素照常入场；
 * 退场登记、`isPresent` 等其余 Presence 信息原样透传，外层 `AnimatePresence` 的退场等待不受影响。
 * 容器不在 `AnimatePresence initial={false}` 之下时它什么也不做。
 */
export function PresenceBoundary({ children }: { children: ReactNode }) {
  const outer = useContext(PresenceContext);
  // 外层上下文每次渲染都可能换新对象（framer 为通知布局变化会复制一份），提交状态不能挂在它上面，只能按边界实例记。
  const [instance] = useState(() => ({}));
  // `initial` 由子项在各自挂载那一刻读取一次：首次提交前读到外层的值，之后读到 undefined（不屏蔽）。
  const value = useMemo(() => {
    if (!outer || outer.initial !== false) return outer;
    const context = { ...outer };
    Object.defineProperty(context, "initial", {
      enumerable: true,
      get: () => (committed.has(instance) ? undefined : outer.initial),
    });
    return context;
  }, [outer, instance]);
  useLayoutEffect(() => {
    committed.add(instance);
  }, [instance]);
  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
}
