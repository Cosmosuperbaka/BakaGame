import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSecondsLeft } from "./UseSecondsLeft";

/**
 * 心跳仍按 200ms 走，但显示值只在整秒边界变化：这里数的就是「组件被叫起重跑了几次」，
 * 一次跨秒之外的写入都是白费的渲染。
 */
function renderCounting(deadlineAt: number | null) {
  let renders = 0;
  const view = renderHook(() => {
    renders += 1;
    return useSecondsLeft(deadlineAt);
  });
  return { view, renders: () => renders };
}

describe("useSecondsLeft", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("一秒内的心跳不逐条重渲染，跨秒才更新", () => {
    const { view, renders } = renderCounting(130_000);
    expect(view.result.current).toBe(30);
    expect(renders()).toBe(1);

    // 真实浏览器里每次心跳是各自独立的一次任务，各自触发一次渲染提交；
    // 一次 act 里连跳 800ms 会被 React 合并成一次，量不出每条心跳的代价，故逐跳推进。
    for (let tick = 0; tick < 4; tick += 1) {
      act(() => {
        vi.advanceTimersByTime(200);
      });
    }
    // 写入的值与当前相同 ⇒ React 连本组件都不叫起：一秒内 4 次空心跳零渲染。
    expect(view.result.current).toBe(30);
    expect(renders()).toBe(1);

    // 五秒 × 5 条心跳 = 25 次写入，显示值只变了 5 次。
    // 上限取 1 + 2×5：跨秒那一次真实渲染，加上 React 对「值没变」那次更新的确认渲染
    // （每个已提交的状态变化后至多一次，见 React 的 bailout 行为）；改造前这里会是 26。
    for (let second = 0; second < 5; second += 1) {
      for (let tick = 0; tick < 5; tick += 1) {
        act(() => {
          vi.advanceTimersByTime(200);
        });
      }
      expect(view.result.current).toBe(29 - second);
    }
    expect(renders()).toBeLessThanOrEqual(11);
  });

  it("剩余不足一秒向上取整，归零后不再往下走", () => {
    const { view } = renderCounting(100_900);
    expect(view.result.current).toBe(1);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(view.result.current).toBe(1);

    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(view.result.current).toBe(0);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(view.result.current).toBe(0);
  });

  it("没有截止时间时恒为 0，也不留下按秒空转的心跳", () => {
    const { view, renders } = renderCounting(null);
    expect(view.result.current).toBe(0);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(view.result.current).toBe(0);
    expect(renders()).toBe(1);
  });
});
