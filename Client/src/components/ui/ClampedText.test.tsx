import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ClampedText } from "./ClampedText";

// jsdom 没有布局：收起时 clientHeight 按截断行数给出，scrollHeight 按字数折算成真实行数。
const LINE = 16;
const PER_LINE = 10;
function fakeLayout() {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.classList.contains("line-clamp-2")) return LINE * 2;
    if (this.classList.contains("line-clamp-3")) return LINE * 3;
    return this.scrollHeight;
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
    this: HTMLElement
  ) {
    return Math.ceil((this.textContent?.length ?? 0) / PER_LINE) * LINE;
  });
}

describe("ClampedText", () => {
  afterEach(() => vi.restoreAllMocks());

  it("放得下时不出现箭头，仍按行数截断", () => {
    fakeLayout();
    render(<ClampedText label="角色简介">十个字以内的简介</ClampedText>);
    expect(screen.getByText("十个字以内的简介")).toHaveClass("line-clamp-2");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("超出行数时默认截断，箭头展开全文后仍可收起", () => {
    fakeLayout();
    const text = "很长的简介".repeat(10);
    render(
      <ClampedText label="角色简介" lines={3}>
        {text}
      </ClampedText>
    );
    const content = screen.getByText(text);
    const toggle = screen.getByRole("button", { name: "展开角色简介" });
    expect(content).toHaveClass("line-clamp-3");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", content.id);

    fireEvent.click(toggle);
    expect(content).not.toHaveClass("line-clamp-3");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAccessibleName("收起角色简介");

    fireEvent.click(toggle);
    expect(content).toHaveClass("line-clamp-3");
    expect(screen.getByRole("button", { name: "展开角色简介" })).toBeInTheDocument();
  });

  it("defaultExpanded 时首次渲染即展开，箭头用于收起", () => {
    fakeLayout();
    const text = "很长的简介".repeat(10);
    render(
      <ClampedText label="角色简介" defaultExpanded>
        {text}
      </ClampedText>
    );
    expect(screen.getByText(text)).not.toHaveClass("line-clamp-2");
    expect(screen.getByRole("button", { name: "收起角色简介" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
  });
});
