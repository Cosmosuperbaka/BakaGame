import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { iconTappable, pressable, pressableStrong } from "@/lib/Motion";
import { Button } from "./Button";

const { motionButtonProps } = vi.hoisted(() => ({ motionButtonProps: vi.fn() }));

// jsdom不测动画几何，只在framer-motion边界核对组件选择的公共交互令牌。
vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  const { forwardRef } = await import("react");
  type MotionButtonProps = ComponentProps<"button"> & {
    whileHover?: unknown;
    whileTap?: unknown;
    transition?: unknown;
  };
  const MotionButton = forwardRef<HTMLButtonElement, MotionButtonProps>(
    ({ whileHover, whileTap, transition, ...props }, ref) => {
      motionButtonProps({ whileHover, whileTap, transition });
      return <button {...props} ref={ref} />;
    },
  );
  return {
    ...actual,
    motion: new Proxy(actual.motion, {
      get(target, property, receiver) {
        return property === "button" ? MotionButton : Reflect.get(target, property, receiver);
      },
    }),
  };
});

const feedback = () => motionButtonProps.mock.lastCall?.[0];

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

  it("省略variant与显式default使用相同主要操作反馈", () => {
    const view = render(<Button>默认操作</Button>);
    const implicit = feedback();
    expect(implicit).toEqual(pressableStrong);

    view.rerender(<Button variant="default">默认操作</Button>);
    expect(feedback()).toEqual(implicit);
    expect(screen.getByRole("button", { name: "默认操作" })).toBeEnabled();
  });

  it.each(["outline", "secondary", "ghost"] as const)("%s保持普通反馈，不被默认variant修复提升为主要操作", (variant) => {
    render(<Button variant={variant}>次要操作</Button>);
    expect(feedback()).toEqual(pressable);
  });

  it("危险按钮用主要反馈，图标尺寸优先使用图标反馈，link不缩放", () => {
    const view = render(<Button variant="destructive">删除</Button>);
    expect(feedback()).toEqual(pressableStrong);
    view.rerender(<Button size="icon" aria-label="图标操作" />);
    expect(feedback()).toEqual(iconTappable);
    view.rerender(<Button variant="destructive" size="icon" aria-label="图标操作" />);
    expect(feedback()).toEqual(iconTappable);
    view.rerender(<Button variant="link">文本入口</Button>);
    expect(feedback()).toEqual({ whileHover: undefined, whileTap: undefined, transition: undefined });
  });

  it("loading和disabled移除交互反馈，恢复后重新启用默认主要反馈", () => {
    const view = render(<Button loading>提交</Button>);
    expect(feedback()).toEqual({ whileHover: undefined, whileTap: undefined, transition: undefined });
    expect(screen.getByRole("button", { name: "提交" })).toHaveAttribute("aria-busy", "true");
    view.rerender(<Button disabled>提交</Button>);
    expect(feedback()).toEqual({ whileHover: undefined, whileTap: undefined, transition: undefined });
    expect(screen.getByRole("button", { name: "提交" })).toBeDisabled();
    view.rerender(<Button>提交</Button>);
    expect(feedback()).toEqual(pressableStrong);
    expect(screen.getByRole("button", { name: "提交" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "提交" })).not.toHaveAttribute("aria-busy");
  });

  it("asChild保持子元素语义且不叠加motion反馈", () => {
    render(<Button asChild><a href="/whoisfaker">进入大厅</a></Button>);
    expect(screen.getByRole("link", { name: "进入大厅" })).toHaveAttribute("href", "/whoisfaker");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(motionButtonProps).not.toHaveBeenCalled();
  });

});
