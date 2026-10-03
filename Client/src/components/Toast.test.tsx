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
    rerender(<ToastViewport toasts={[...toasts, { id: 4, text: "设置已保存", type: "success" }]} />);
    expect(screen.getByText("设置已保存")).toBeInTheDocument();
    rerender(<ToastViewport toasts={[]} />);
    await waitFor(() => expect(screen.queryByText("连接成功")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText("设置已保存")).not.toBeInTheDocument());
    unmount();
  });
});
