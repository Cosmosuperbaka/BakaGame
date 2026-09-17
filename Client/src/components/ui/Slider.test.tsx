import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Slider } from "./Slider";

describe("Slider", () => {
  it("正确渲染 slider 角色并体现数值属性", () => {
    render(
      <Slider
        value={[0.65]}
        min={0}
        max={1}
        step={0.01}
        aria-label="测试滑块"
      />,
    );

    const slider = screen.getByRole("slider", { name: "测试滑块" });
    expect(slider).toBeInTheDocument();
    expect(slider).toHaveAttribute("aria-valuenow", "0.65");
    expect(slider).toHaveAttribute("aria-valuemin", "0");
    expect(slider).toHaveAttribute("aria-valuemax", "1");
  });

  it("响应键盘方向键触发数值改变", () => {
    const handleValueChange = vi.fn();
    render(
      <Slider
        value={[50]}
        min={0}
        max={100}
        step={1}
        onValueChange={handleValueChange}
        aria-label="音量滑块"
      />,
    );

    const slider = screen.getByRole("slider", { name: "音量滑块" });
    slider.focus();
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(handleValueChange).toHaveBeenCalledWith([51]);

    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(handleValueChange).toHaveBeenCalledWith([49]);
  });

  it("处于 disabled 状态时禁止交互", () => {
    const handleValueChange = vi.fn();
    render(
      <Slider
        value={[0.5]}
        disabled
        onValueChange={handleValueChange}
        aria-label="禁用滑块"
      />,
    );

    const slider = screen.getByRole("slider", { name: "禁用滑块" });
    expect(slider).toHaveAttribute("data-disabled");
    slider.focus();
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(handleValueChange).not.toHaveBeenCalled();
  });
});
