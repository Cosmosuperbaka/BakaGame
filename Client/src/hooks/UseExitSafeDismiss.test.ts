import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useExitSafeDismiss } from "@/hooks/UseExitSafeDismiss";

/** 浏览器的 `timeStamp` 与 `performance.now()` 同一时间原点；jsdom 给的是纪元毫秒，这里按浏览器口径补上。 */
const pressNow = () => {
  const event = new Event("pointerdown");
  Object.defineProperty(event, "timeStamp", { value: performance.now() });
  return event;
};

/** Radix 派发的「在外面操作」：带着触发它的原事件，可被取消。 */
const outside = (originalEvent: Event) =>
  new CustomEvent("dismissableLayer.pointerDownOutside", {
    cancelable: true,
    detail: { originalEvent },
  });

describe("useExitSafeDismiss", () => {
  it("退场途中按下、随后浮层又被重开：那一下的「按在外面」不再关闭重开的浮层", () => {
    const own = vi.fn();
    const { result, rerender } = renderHook(({ present }) => useExitSafeDismiss(present, own), {
      initialProps: { present: true },
    });
    rerender({ present: false });
    // 退场途中按下触发按钮：原事件此刻发生
    const press = pressNow();
    // 这一下的 click 把浮层重开，Radix 之后才派发「按在外面」
    rerender({ present: true });
    const event = outside(press);
    result.current(event);

    expect(event.defaultPrevented).toBe(true);
    expect(own).toHaveBeenCalledWith(event);
  });

  it("浮层在场时点在外面照常关闭", () => {
    const { result } = renderHook(() => useExitSafeDismiss(true));
    const event = outside(pressNow());
    result.current(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
