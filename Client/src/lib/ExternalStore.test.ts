import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createExternalStore } from "./ExternalStore";

describe("外部状态", () => {
  it("React 之外同步读写，订阅者收到通知，退订后不再收到", () => {
    const store = createExternalStore(0);
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = store.subscribe(first);
    store.subscribe(second);

    expect(store.get()).toBe(0);
    store.set(1);
    expect(store.get()).toBe(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    stopFirst();
    store.set(2);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("写入同一个值也通知；emit 不改值只通知；write 只改值不通知", () => {
    const store = createExternalStore("a");
    const listener = vi.fn();
    store.subscribe(listener);

    store.set("a");
    expect(store.get()).toBe("a");
    expect(listener).toHaveBeenCalledTimes(1);

    store.emit();
    expect(store.get()).toBe("a");
    expect(listener).toHaveBeenCalledTimes(2);

    store.write("b");
    expect(store.get()).toBe("b");
    expect(listener).toHaveBeenCalledTimes(2);

    store.emit();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("hook 跟着写入重渲染，退订后不再跟随", () => {
    const store = createExternalStore(0);
    const { result, unmount } = renderHook(() => store.use());
    expect(result.current).toBe(0);

    act(() => store.set(3));
    expect(result.current).toBe(3);

    unmount();
    act(() => store.set(4));
    expect(result.current).toBe(3);
  });

  it("两份 store 互不牵连", () => {
    const left = createExternalStore(0);
    const right = createExternalStore(0);
    const listener = vi.fn();
    right.subscribe(listener);

    left.set(9);
    expect(right.get()).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });
});
