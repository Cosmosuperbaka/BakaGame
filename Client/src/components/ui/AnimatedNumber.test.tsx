import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AnimatedNumber } from "./AnimatedNumber";

// 滚动用的数字带与「+N」浮标都是 aria-hidden 的装饰层：文字内容始终只有真实数值，
// 读屏、按文字查找与复制不受滚动影响；装饰层播完即移除。
const decorations = (container: HTMLElement) => container.querySelectorAll("[aria-hidden]");

describe("AnimatedNumber", () => {
  it("挂载时直接显示数值，不叠装饰层", () => {
    const { container } = render(<AnimatedNumber value={42} gain="above" />);
    expect(container.textContent).toBe("42");
    expect(decorations(container)).toHaveLength(0);
  });

  it("分数增加时文字立即是新值，数字带与「+N」播完后移除", async () => {
    const view = render(<AnimatedNumber value={8} gain="above" />);
    view.rerender(<AnimatedNumber value={11} gain="above" />);
    expect(view.container.textContent).toBe("11");
    // 一层数字带、一枚浮标
    expect(decorations(view.container)).toHaveLength(2);
    await waitFor(() => expect(decorations(view.container)).toHaveLength(0), { timeout: 4_000 });
    expect(view.container.textContent).toBe("11");
  });

  it("分数减少只滚动，不浮起「+N」", async () => {
    const view = render(<AnimatedNumber value={23} gain="above" />);
    view.rerender(<AnimatedNumber value={19} gain="above" />);
    expect(view.container.textContent).toBe("19");
    expect(decorations(view.container)).toHaveLength(1);
    await waitFor(() => expect(decorations(view.container)).toHaveLength(0), { timeout: 4_000 });
  });

  it("给了起点时挂载即从起点滚到终值，增量列带符号", async () => {
    const { container } = render(<AnimatedNumber value={4} from={0} signed />);
    expect(container.textContent).toBe("+4");
    expect(decorations(container)).toHaveLength(1);
    await waitFor(() => expect(decorations(container)).toHaveLength(0), { timeout: 4_000 });
    expect(container.textContent).toBe("+4");
  });

  it("起点与终值相同、或只差符号时不叠数字带", () => {
    expect(decorations(render(<AnimatedNumber value={0} from={0} signed />).container)).toHaveLength(0);
    expect(decorations(render(<AnimatedNumber value={3} from={-3} />).container)).toHaveLength(0);
  });

  it("重新挂载不重播上一次的变化", () => {
    const view = render(<AnimatedNumber value={5} gain="above" />);
    view.rerender(<AnimatedNumber value={6} gain="above" />);
    view.unmount();
    const { container } = render(<AnimatedNumber value={6} gain="above" />);
    expect(decorations(container)).toHaveLength(0);
  });
});
