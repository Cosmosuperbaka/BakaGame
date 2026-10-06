import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CountdownBadge } from "./CountdownBadge";

/** 礼貌播报区：徽章旁视觉隐藏的 aria-live 节点。 */
const announcer = (container: HTMLElement) => container.querySelector('[aria-live="polite"]');

describe("CountdownBadge", () => {
  it("徽章读出当前秒数，播报区只在 10、5、0 秒节点换文案", () => {
    const view = render(<CountdownBadge secondsLeft={30} />);
    expect(screen.getByRole("timer")).toHaveTextContent("剩余 30 秒");
    expect(announcer(view.container)).toHaveTextContent("");

    view.rerender(<CountdownBadge secondsLeft={10} />);
    expect(announcer(view.container)).toHaveTextContent("剩余 10 秒");
    // 9—6 秒停在上一个节点，文字不变就不会重读。
    view.rerender(<CountdownBadge secondsLeft={7} />);
    expect(announcer(view.container)).toHaveTextContent("剩余 10 秒");
    expect(screen.getByRole("timer")).toHaveTextContent("剩余 7 秒");
    view.rerender(<CountdownBadge secondsLeft={5} />);
    expect(announcer(view.container)).toHaveTextContent("剩余 5 秒");
    view.rerender(<CountdownBadge secondsLeft={0} />);
    expect(announcer(view.container)).toHaveTextContent("剩余 0 秒");
  });
});
