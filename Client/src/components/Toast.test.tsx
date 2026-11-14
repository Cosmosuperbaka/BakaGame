import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToastViewport, type ToastItem } from "./Toast";

describe("ToastViewport", () => {
  it("由 Props 展示各类通知，追加和清空后完成退出", async () => {
    const toasts: ToastItem[] = [
      { id: 1, text: "连接成功", type: "success" },
      { id: 2, text: "等待玩家", type: "info" },
      { id: 3, text: "密码错误", type: "error" },
    ];
    const { rerender, unmount } = render(<ToastViewport toasts={toasts} />);
    for (const toast of toasts) expect(screen.getByText(toast.text)).toBeInTheDocument();
    rerender(
      <ToastViewport toasts={[...toasts, { id: 4, text: "设置已保存", type: "success" }]} />
    );
    expect(screen.getByText("设置已保存")).toBeInTheDocument();
    rerender(<ToastViewport toasts={[]} />);
    await waitFor(() => expect(screen.queryByText("连接成功")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText("设置已保存")).not.toBeInTheDocument());
    unmount();
  });

  it("容器是具名区域；错误立即播报，其余礼貌排队", () => {
    render(
      <ToastViewport
        toasts={[
          { id: 1, text: "密码错误", type: "error" },
          { id: 2, text: "设置已保存", type: "success" },
        ]}
      />
    );
    expect(screen.getByRole("region", { name: "通知" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("密码错误");
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("设置已保存");
    expect(status).toHaveAttribute("aria-live", "polite");
  });

  it("同一句话重发：仍是一条，播报节点换新，读屏再读一遍", () => {
    const item: ToastItem = { id: 1, text: "轮到你了", type: "info" };
    const { rerender } = render(<ToastViewport toasts={[item]} />);
    const before = screen.getByRole("status");
    rerender(<ToastViewport toasts={[{ ...item, repeat: 1 }]} />);
    expect(screen.getAllByText("轮到你了")).toHaveLength(1);
    const after = screen.getByRole("status");
    expect(after).toHaveTextContent("轮到你了");
    expect(after).not.toBe(before);
  });

  it("每种语义都带一枚前导图标，状态不只靠颜色区分", () => {
    render(
      <ToastViewport
        toasts={[
          { id: 1, text: "等待玩家", type: "info" },
          { id: 2, text: "设置已保存", type: "success" },
          { id: 3, text: "密码错误", type: "error" },
        ]}
      />
    );
    const icons = ["等待玩家", "设置已保存", "密码错误"].map((text) =>
      screen.getByText(text).parentElement?.querySelector("svg")
    );
    for (const icon of icons) expect(icon).toHaveAttribute("aria-hidden", "true");
    // 三种语义的图标形状互不相同
    expect(new Set(icons.map((icon) => icon?.getAttribute("class"))).size).toBe(3);
  });
});
