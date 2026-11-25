import { useCallback, useLayoutEffect, useRef } from "react";

/** Radix 可关闭层「在外面操作」的事件：按下与聚焦两种都带着触发它的原事件。 */
type OutsideEvent = CustomEvent<{ originalEvent: Event }>;

/**
 * 浮层经 AnimatePresence 播完退场才卸载，这段时间它仍是 Radix 的可关闭层。退场途中按下的指针
 * （最常见的是再点一次触发按钮重开）落在它外面，Radix 却要等这一下的 click 之后才派发「按在外面」，
 * 刚被重开的浮层随即又被关掉，玩家看到的是「点了没反应」。
 *
 * 以浮层最近一次重新在场（`present` 由假变真）的时刻为界：原事件早于它的「在外面操作」发生在退场途中，
 * 不再关闭任何东西。返回值交给 Radix Content 的 `onInteractOutside`（下拉选择是 `onPointerDownOutside`），
 * 调用处自己的处理照常执行。
 * `present` 在 AnimatePresence 的子树里取 `useIsPresent()`，在持有开合状态的组件里直接传 `open`。
 */
export function useExitSafeDismiss<E extends OutsideEvent>(
  present: boolean,
  onInteractOutside?: (event: E) => void
): (event: E) => void {
  const presentSince = useRef(0);
  useLayoutEffect(() => {
    if (present) presentSince.current = performance.now();
  }, [present]);
  return useCallback(
    (event: E) => {
      if (event.detail.originalEvent.timeStamp < presentSince.current) event.preventDefault();
      onInteractOutside?.(event);
    },
    [onInteractOutside]
  );
}
