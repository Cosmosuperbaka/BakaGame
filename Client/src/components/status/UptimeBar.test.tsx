import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { UptimeBar } from "./UptimeBar";
import type { BarCell } from "./StatusFormat";

const cellOf = (index: number, level: BarCell["level"] = "operational"): BarCell => ({
  key: `c${index}`,
  level,
  total: 12,
  ratio: level === "operational" ? 1 : 0.5,
  latencyMs: 100 + index,
  when: `10月${index + 1}日`,
  events: [],
});

const CELLS = [cellOf(0), cellOf(1, "degraded"), cellOf(2)];

const renderBar = (cells: BarCell[] | null = CELLS) =>
  render(
    <div>
      <UptimeBar
        cells={cells}
        placeholderCount={3}
        loading={false}
        revealKey="realtime"
        revealDelay={0}
      />
      <button type="button">条带之外</button>
    </div>
  );

const bar = () => screen.getByRole("img", { name: /个时段有数据/ });

describe("条带明细的键盘与触屏入口", () => {
  it("条带可以用键盘聚焦，方向键逐格查看，说明与悬停时是同一个浮层", async () => {
    const user = userEvent.setup();
    renderBar();

    await user.tab();
    expect(bar()).toHaveFocus();
    // 聚焦落在最新一格：与「左旧右新」的读法一致，先看到现在。
    expect(await screen.findByText("10月3日")).toBeInTheDocument();

    await user.keyboard("{ArrowLeft}");
    expect(await screen.findByText("10月2日")).toBeInTheDocument();
    expect(screen.getByText("异常 · 可用率 50.00%")).toBeInTheDocument();

    await user.keyboard("{Home}");
    expect(await screen.findByText("10月1日")).toBeInTheDocument();
    await user.keyboard("{End}");
    expect(await screen.findByText("10月3日")).toBeInTheDocument();
    // 到头不越界。
    await user.keyboard("{ArrowRight}");
    expect(screen.getByText("10月3日")).toBeInTheDocument();
  });

  it("键盘查看到的那一格由读屏可达的播报区读出", async () => {
    const user = userEvent.setup();
    renderBar();
    await user.tab();
    await user.keyboard("{ArrowLeft}");

    const live = await screen.findByText(/10月2日.*异常/, { selector: '[aria-live="polite"]' });
    expect(live).toBeInTheDocument();
  });

  it("焦点离开条带，说明收起", async () => {
    const user = userEvent.setup();
    renderBar();
    await user.tab();
    await screen.findByText("10月3日");

    await user.tab();
    await waitFor(() => expect(screen.queryByText("10月3日")).not.toBeInTheDocument());
  });

  it("触屏点按一格后说明固定显示，手指抬起不收回；点条带之外才收起", async () => {
    renderBar();
    const cells = bar().querySelectorAll("[data-cell]");
    act(() => {
      fireEvent.pointerEnter(cells[1]!, { pointerType: "touch" });
    });
    expect(await screen.findByText("10月2日")).toBeInTheDocument();

    // 手指抬起后指针事件会补发 pointerleave：触屏不能因此收回。
    act(() => {
      fireEvent.pointerLeave(bar().parentElement!, { pointerType: "touch" });
    });
    // 退场动画不到一秒：等够久再看，说明还在才算真的固定住了。
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(screen.getByText("10月2日")).toBeInTheDocument();

    act(() => {
      fireEvent.pointerDown(screen.getByRole("button", { name: "条带之外" }), {
        pointerType: "touch",
      });
    });
    await waitFor(() => expect(screen.queryByText("10月2日")).not.toBeInTheDocument());
  });

  it("鼠标离开条带仍立即收起说明", async () => {
    renderBar();
    const cells = bar().querySelectorAll("[data-cell]");
    act(() => {
      fireEvent.pointerEnter(cells[1]!, { pointerType: "mouse" });
    });
    await screen.findByText("10月2日");
    act(() => {
      fireEvent.pointerLeave(bar().parentElement!, { pointerType: "mouse" });
    });
    await waitFor(() => expect(screen.queryByText("10月2日")).not.toBeInTheDocument());
  });

  it("数据还没到的占位条带不可聚焦", () => {
    renderBar(null);
    expect(screen.getByRole("img")).not.toHaveAttribute("tabindex");
  });
});
