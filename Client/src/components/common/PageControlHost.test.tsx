import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SitePageCommand } from "@bakagame/shared";
import {
  clearPageNotice,
  getPageControl,
  resetPageControl,
  setAgentFocus,
  setPageControl,
  showPageNotice,
} from "@/stores/UsePageControl";
import { PageControlHost } from "./PageControlHost";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  handlers: [] as Array<(command: SitePageCommand) => void>,
  reportPageResult: vi.fn(),
  closePageControl: vi.fn(),
  runPageCommand: vi.fn(),
}));

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useNavigate: () => mocks.navigate };
});

vi.mock("@/lib/SiteWs", () => ({
  onPageCommand: (handler: (command: SitePageCommand) => void) => {
    mocks.handlers.push(handler);
    return () => {
      const index = mocks.handlers.indexOf(handler);
      if (index >= 0) mocks.handlers.splice(index, 1);
    };
  },
  reportPageResult: mocks.reportPageResult,
  closePageControl: mocks.closePageControl,
}));

vi.mock("@/lib/PageActions", () => ({ runPageCommand: mocks.runPageCommand }));

const dispatch = async (command: SitePageCommand) => {
  await act(async () => {
    for (const handler of [...mocks.handlers]) handler(command);
    await Promise.resolve();
  });
};

const takeOver = () => act(() => setPageControl({ status: "controlled", agentName: "BakaAgent" }));

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.reportPageResult.mockReset();
  mocks.closePageControl.mockReset();
  mocks.runPageCommand.mockReset();
  mocks.runPageCommand.mockResolvedValue({ id: "c1", ok: true });
  resetPageControl();
  clearPageNotice();
});

afterEach(() => {
  resetPageControl();
  clearPageNotice();
});

describe("标签页接管的执行端", () => {
  it("指令交给执行模块，结果回执给服务端", async () => {
    render(<PageControlHost />);
    takeOver();
    await dispatch({ id: "c1", action: "click", control: "room.ready" });
    await vi.dynamicImportSettled();
    await act(async () => Promise.resolve());
    expect(mocks.runPageCommand).toHaveBeenCalledWith(
      expect.objectContaining({ id: "c1", action: "click" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(mocks.reportPageResult).toHaveBeenCalledWith({ id: "c1", ok: true });
  });

  it("接管结束时中止手上的动作并清掉焦点", async () => {
    let signal: AbortSignal | undefined;
    mocks.runPageCommand.mockImplementation((_command, context: { signal: AbortSignal }) => {
      signal = context.signal;
      return new Promise(() => undefined);
    });
    render(<PageControlHost />);
    takeOver();
    await dispatch({ id: "c1", action: "type", control: "chat.input", text: "你好" });
    await vi.dynamicImportSettled();
    await act(async () => Promise.resolve());
    expect(signal?.aborted).toBe(false);
    act(() => resetPageControl());
    expect(signal?.aborted).toBe(true);
  });
});

describe("接管层", () => {
  it("未接管时什么都不渲染，不占任何事件", () => {
    render(<PageControlHost />);
    expect(screen.queryByRole("button", { name: "收回控制" })).toBeNull();
    expect(document.documentElement.dataset.agentLocked).toBeUndefined();
  });

  /**
   * `isTrusted` 不可伪造，测试里派发的事件永远是脚本事件：
   * 直接拿到接管层注册的捕获监听，用「人类事件」的形状调用它。
   */
  const lockListener = () => {
    const add = vi.spyOn(window, "addEventListener");
    render(<PageControlHost />);
    takeOver();
    const block = add.mock.calls.find(([type]) => type === "pointerdown")?.[1] as (
      event: Event
    ) => void;
    add.mockRestore();
    return (type: string, target: EventTarget, init: Record<string, unknown> = {}) => {
      const event = {
        type,
        target,
        isTrusted: true,
        preventDefault: vi.fn(),
        stopImmediatePropagation: vi.fn(),
        ...init,
      };
      act(() => block(event as unknown as Event));
      return event;
    };
  };

  it("人类的点击、按键与滚动都被挡下，Agent 回放的脚本事件照常通过", () => {
    const send = lockListener();
    expect(document.documentElement.dataset.agentLocked).toBe("true");

    const page = document.createElement("button");
    document.body.append(page);
    for (const type of ["click", "keydown", "wheel", "touchmove", "paste"]) {
      const event = send(type, page);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopImmediatePropagation).toHaveBeenCalled();
    }
    const scripted = send("click", page, { isTrusted: false });
    expect(scripted.preventDefault).not.toHaveBeenCalled();
    page.remove();
  });

  it("收回入口放行；Esc 与 Tab 把键盘焦点送到入口上，刷新键不拦", () => {
    const send = lockListener();
    const release = screen.getByRole("button", { name: "收回控制" });

    expect(send("click", release).preventDefault).not.toHaveBeenCalled();
    fireEvent.click(release);
    expect(mocks.closePageControl).toHaveBeenCalledTimes(1);

    expect(send("keydown", document.body, { key: "Escape" }).preventDefault).toHaveBeenCalled();
    expect(document.activeElement).toBe(release);
    // 弹窗的焦点陷阱会抢走焦点：按过 Esc 之后确认键直接收回。
    send("keydown", document.body, { key: "Enter" });
    expect(mocks.closePageControl).toHaveBeenCalledTimes(2);
    for (const init of [{ key: "F5" }, { key: "r", ctrlKey: true }])
      expect(send("keydown", document.body, init).preventDefault).not.toHaveBeenCalled();
  });

  it("焦点框框住目标，状态条说明动作；接管层本身不进入 Agent 的画面", async () => {
    const target = document.createElement("button");
    target.textContent = "开始";
    target.getBoundingClientRect = () =>
      ({ top: 100, left: 40, width: 120, height: 40, bottom: 140, right: 160 }) as DOMRect;
    document.body.append(target);
    render(<PageControlHost />);
    takeOver();
    await act(async () => {
      setAgentFocus({ action: "click", element: target, label: "开始" });
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });
    const box = document.querySelector<HTMLElement>(".agent-focus-box");
    expect(box?.style.top).toBe("93px");
    expect(box?.querySelector(".agent-click-echo")).not.toBeNull();
    expect(screen.getAllByText("正在点击 · 开始").length).toBeGreaterThan(0);

    const { readPageView } = await import("@/lib/PageView");
    window.history.replaceState(null, "", "/");
    const view = readPageView();
    expect(view.controls.map((control) => control.label)).toEqual(["开始"]);
    target.remove();
  });

  it("断线期间保持锁定并说明在恢复", () => {
    render(<PageControlHost />);
    act(() => setPageControl({ status: "controlled", agentName: "BakaAgent", reconnecting: true }));
    expect(screen.getByText("连接中断，正在恢复")).toBeInTheDocument();
    expect(document.documentElement.dataset.agentLocked).toBe("true");
  });

  it("接管结束后立刻解锁并留一句话说明原因", () => {
    render(<PageControlHost />);
    takeOver();
    act(() => {
      resetPageControl();
      showPageNotice("BakaAgent 已断开，页面已解锁");
    });
    expect(getPageControl().status).toBe("off");
    expect(document.documentElement.dataset.agentLocked).toBeUndefined();
    expect(screen.getByText("BakaAgent 已断开，页面已解锁")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "收回控制" })).toBeNull();
  });
});
