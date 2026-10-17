import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Hint, TooltipProvider } from "@/components/ui/Tooltip";

describe("Hint", () => {
  it("文案为空时只渲染原元素，不挂浮层", () => {
    render(<Hint label={undefined}><span>玩家名</span></Hint>);
    const trigger = screen.getByText("玩家名");
    expect(trigger).not.toHaveAttribute("data-state");
    expect(trigger.tagName).toBe("SPAN");
  });

  it("悬停后浮层给出同一份文案，且沿用设计系统的浮层表面", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider delayDuration={0}>
        <Hint label="很长的玩家昵称"><span>玩家名</span></Hint>
      </TooltipProvider>,
    );

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.hover(screen.getByText("玩家名"));

    const tooltip = await waitFor(() => screen.getByRole("tooltip"));
    expect(tooltip).toHaveTextContent("很长的玩家昵称");
    expect(tooltip.className).toContain("floating-surface");
  });

  it("上游没有 Provider 时自行兜底，不因缺少祖先而报错", async () => {
    const user = userEvent.setup();
    render(<Hint label="兜底文案"><span>触发元素</span></Hint>);

    await user.hover(screen.getByText("触发元素"));
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("兜底文案"));
  });
});
