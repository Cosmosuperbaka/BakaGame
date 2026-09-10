import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "./Button";

describe("Button", () => {
  it("默认状态下正确渲染文案且可点击", async () => {
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>点击测试</Button>);

    const button = screen.getByRole("button", { name: "点击测试" });
    expect(button).toBeInTheDocument();
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-busy");
    expect(screen.queryByTestId("button-spinner")).not.toBeInTheDocument();

    await userEvent.click(button);
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it("当 loading 为 true 时显示旋转动效且处于禁用状态，阻止点击交互", async () => {
    const handleClick = vi.fn();
    render(
      <Button loading onClick={handleClick}>
        开始游戏
      </Button>,
    );

    const button = screen.getByRole("button", { name: "开始游戏" });
    expect(button).toBeInTheDocument();
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");

    const spinner = screen.getByTestId("button-spinner");
    expect(spinner).toBeInTheDocument();
    expect(spinner).toHaveAttribute("aria-hidden", "true");

    await userEvent.click(button);
    expect(handleClick).not.toHaveBeenCalled();
  });

  it("当 disabled 为 true 时即使未加载也处于禁用状态", async () => {
    const handleClick = vi.fn();
    render(
      <Button disabled onClick={handleClick}>
        再来一轮
      </Button>,
    );

    const button = screen.getByRole("button", { name: "再来一轮" });
    expect(button).toBeDisabled();
    expect(screen.queryByTestId("button-spinner")).not.toBeInTheDocument();

    await userEvent.click(button);
    expect(handleClick).not.toHaveBeenCalled();
  });
});
