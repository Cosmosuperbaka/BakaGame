import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import { createToastSlice, type ToastState } from "@/stores/room/ToastSlice";
import { ToastViewport, type ToastItem } from "./Toast";

const noop = () => {};

/** 只看展示：三个回调都不接线。 */
function Static({ toasts }: { toasts: readonly ToastItem[] }) {
  return <ToastViewport toasts={toasts} onDismiss={noop} onPause={noop} onResume={noop} />;
}

/** 接上真实的提示切片，按玩家实际看到的那一份驱动：悬停、聚焦、关闭都走切片的计时。 */
function mountWithSlice() {
  const store = create<ToastState>((set, get) => createToastSlice(set, get));
  function Live() {
    const toasts = store((state) => state.toasts);
    const { dismissToast, pauseToast, resumeToast } = store.getState();
    return (
      <ToastViewport
        toasts={toasts}
        onDismiss={dismissToast}
        onPause={pauseToast}
        onResume={resumeToast}
      />
    );
  }
  render(<Live />);
  const texts = () => store.getState().toasts.map((item) => item.text);
  const show = (text: string, type?: ToastItem["type"]) => {
    act(() => {
      store.getState().showToast(text, type);
    });
  };
  const tick = (ms: number) => {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  };
  return { texts, show, tick };
}

/** 提示条本身（接指针事件的那一层）。 */
const cardOf = (text: string) => screen.getByText(text).closest(".pointer-events-auto")!;

describe("ToastViewport", () => {
  it("由 Props 展示各类通知，追加和清空后完成退出", async () => {
    const toasts: ToastItem[] = [
      { id: 1, text: "连接成功", type: "success" },
      { id: 2, text: "等待玩家", type: "info" },
      { id: 3, text: "密码错误", type: "error" },
    ];
    const { rerender, unmount } = render(<Static toasts={toasts} />);
    for (const toast of toasts) expect(screen.getByText(toast.text)).toBeInTheDocument();
    rerender(<Static toasts={[...toasts, { id: 4, text: "设置已保存", type: "success" }]} />);
    expect(screen.getByText("设置已保存")).toBeInTheDocument();
    rerender(<Static toasts={[]} />);
    await waitFor(() => expect(screen.queryByText("连接成功")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText("设置已保存")).not.toBeInTheDocument());
    unmount();
  });

  it("容器是具名区域；错误立即播报，其余礼貌排队", () => {
    render(
      <Static
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

  it("关闭钮不在播报节点里：读屏播报只读提示文字", () => {
    render(<Static toasts={[{ id: 1, text: "设置已保存", type: "success" }]} />);
    expect(screen.getByRole("status")).toHaveTextContent(/^设置已保存$/);
    expect(screen.getByRole("status")).not.toContainElement(
      screen.getByRole("button", { name: "关闭通知" })
    );
  });

  it("同一句话重发：仍是一条，播报节点换新，读屏再读一遍", () => {
    const item: ToastItem = { id: 1, text: "轮到你了", type: "info" };
    const { rerender } = render(<Static toasts={[item]} />);
    const before = screen.getByRole("status");
    rerender(<Static toasts={[{ ...item, repeat: 1 }]} />);
    expect(screen.getAllByText("轮到你了")).toHaveLength(1);
    const after = screen.getByRole("status");
    expect(after).toHaveTextContent("轮到你了");
    expect(after).not.toBe(before);
  });

  it("每种语义都带一枚前导图标，状态不只靠颜色区分", () => {
    render(
      <Static
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

  it("只有提示条本身接指针事件，容器不挡住下面的页面", () => {
    render(<Static toasts={[{ id: 1, text: "等待玩家", type: "info" }]} />);
    expect(screen.getByRole("region", { name: "通知" })).toHaveClass("pointer-events-none");
    expect(cardOf("等待玩家")).toHaveClass("pointer-events-auto");
    expect(cardOf("等待玩家")).toContainElement(screen.getByRole("button", { name: "关闭通知" }));
  });
});

describe("ToastViewport 的关闭与暂停", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("每条提示一枚关闭钮，点了立即移除，不等计时", () => {
    vi.useFakeTimers();
    const { texts, show } = mountWithSlice();
    show("甲");
    show("乙", "error");
    const buttons = screen.getAllByRole("button", { name: "关闭通知" });
    expect(buttons).toHaveLength(2);
    // 关闭钮的说明指向自己那条提示的文字，读屏分得清关的是哪一条。
    expect(buttons[1]).toHaveAccessibleDescription("乙");
    fireEvent.click(buttons[1]);
    expect(texts()).toEqual(["甲"]);
  });

  it("鼠标悬停时暂停计时，移开后按剩下的时长继续", () => {
    vi.useFakeTimers();
    const { texts, show, tick } = mountWithSlice();
    show("读一读");
    tick(1000);
    fireEvent.mouseEnter(cardOf("读一读"));
    tick(60_000);
    expect(texts()).toEqual(["读一读"]);
    fireEvent.mouseLeave(cardOf("读一读"));
    tick(1999);
    expect(texts()).toEqual(["读一读"]);
    tick(1);
    expect(texts()).toEqual([]);
  });

  it("键盘聚焦在提示上时暂停计时，焦点离开后继续", () => {
    vi.useFakeTimers();
    const { texts, show, tick } = mountWithSlice();
    show("读一读", "error");
    const close = screen.getByRole("button", { name: "关闭通知" });
    act(() => close.focus());
    tick(60_000);
    expect(texts()).toEqual(["读一读"]);
    act(() => close.blur());
    tick(4999);
    expect(texts()).toEqual(["读一读"]);
    tick(1);
    expect(texts()).toEqual([]);
  });

  it("悬停与聚焦叠加：鼠标移开但焦点还在，仍然暂停", () => {
    vi.useFakeTimers();
    const { texts, show, tick } = mountWithSlice();
    show("读一读");
    fireEvent.mouseEnter(cardOf("读一读"));
    act(() => screen.getByRole("button", { name: "关闭通知" }).focus());
    fireEvent.mouseLeave(cardOf("读一读"));
    tick(60_000);
    expect(texts()).toEqual(["读一读"]);
  });

  it("只暂停被悬停的那一条，别的照常消失", () => {
    vi.useFakeTimers();
    const { texts, show, tick } = mountWithSlice();
    show("甲");
    show("乙");
    fireEvent.mouseEnter(cardOf("乙"));
    tick(3000);
    expect(texts()).toEqual(["乙"]);
  });
});
