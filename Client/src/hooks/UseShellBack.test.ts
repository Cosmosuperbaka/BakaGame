import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SHELL_BACK_EVENT, useShellBack } from "./UseShellBack";

const pressBack = () => {
  const event = new CustomEvent(SHELL_BACK_EVENT, { cancelable: true });
  window.dispatchEvent(event);
  return event;
};

describe("useShellBack", () => {
  it("接手返回：回调执行并取消事件，壳据此不再后退", () => {
    const onBack = vi.fn();
    renderHook(() => useShellBack(onBack));
    const event = pressBack();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("停用或卸载后不接手，返回照常往上一页走", () => {
    const onBack = vi.fn();
    const { rerender, unmount } = renderHook(({ enabled }) => useShellBack(onBack, enabled), {
      initialProps: { enabled: false },
    });
    expect(pressBack().defaultPrevented).toBe(false);
    rerender({ enabled: true });
    expect(pressBack().defaultPrevented).toBe(true);
    unmount();
    expect(pressBack().defaultPrevented).toBe(false);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("同一次返回只交给一个接手方", () => {
    const first = vi.fn();
    const second = vi.fn();
    renderHook(() => useShellBack(first));
    renderHook(() => useShellBack(second));
    pressBack();
    expect(first.mock.calls.length + second.mock.calls.length).toBe(1);
  });
});
