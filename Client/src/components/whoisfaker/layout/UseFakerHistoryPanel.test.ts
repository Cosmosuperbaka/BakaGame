import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useFakerHistoryPanel } from "./UseFakerHistoryPanel";

type Props = { roundId: string | undefined; historyAvailable: boolean; desktopSidebar: boolean };
const setup = (initial: Props = { roundId: "r1", historyAvailable: true, desktopSidebar: true }) =>
  renderHook((props: Props) => useFakerHistoryPanel(props), { initialProps: initial });

describe("useFakerHistoryPanel", () => {
  it("展开记下局次，换局后自然收起，下一局不会自己弹开", () => {
    const view = setup();
    act(() => view.result.current.toggleHistory());
    expect(view.result.current.historyOpen).toBe(true);
    view.rerender({ roundId: "r2", historyAvailable: true, desktopSidebar: true });
    expect(view.result.current.historyOpen).toBe(false);
    view.rerender({ roundId: "r1", historyAvailable: true, desktopSidebar: true });
    // 回到展开它的那一局并不会重新弹开之外的局次，但同一局的记忆仍在
    expect(view.result.current.historyOpen).toBe(true);
  });

  it("历史入口不可用时一律视为收起", () => {
    const view = setup();
    act(() => view.result.current.toggleHistory());
    view.rerender({ roundId: "r1", historyAvailable: false, desktopSidebar: true });
    expect(view.result.current.historyOpen).toBe(false);
    expect(view.result.current.openDrawer).toBeNull();
  });

  it("收起后列表继续带着历史渲染，直到宽度动画结束", () => {
    const view = setup();
    act(() => view.result.current.toggleHistory());
    expect(view.result.current.historyRendered).toBe(true);
    act(() => view.result.current.toggleHistory());
    expect(view.result.current.historyOpen).toBe(false);
    expect(view.result.current.historyRendered).toBe(true);
    act(() => view.result.current.onSidebarSettled());
    expect(view.result.current.historyRendered).toBe(false);
  });

  it("展开途中的动画结束事件不会把列表收掉", () => {
    const view = setup();
    act(() => view.result.current.toggleHistory());
    act(() => view.result.current.onSidebarSettled());
    expect(view.result.current.historyRendered).toBe(true);
  });

  it("窄屏没有侧栏与动画结束事件：收起中的标记不留存，也不锁游戏区", () => {
    const view = setup();
    act(() => view.result.current.toggleHistory());
    act(() => view.result.current.toggleHistory());
    expect(view.result.current.historyRendered).toBe(true);
    view.rerender({ roundId: "r1", historyAvailable: true, desktopSidebar: false });
    expect(view.result.current.historyRendered).toBe(false);
    view.rerender({ roundId: "r1", historyAvailable: true, desktopSidebar: true });
    expect(view.result.current.historyRendered).toBe(false);
  });

  it("只有桌面侧栏展开时游戏区才不可交互", () => {
    const view = setup();
    act(() => view.result.current.toggleHistory());
    expect(view.result.current.gameInert).toBe(true);
    view.rerender({ roundId: "r1", historyAvailable: true, desktopSidebar: false });
    expect(view.result.current.gameInert).toBe(false);
  });

  it("抽屉同一时刻只开一个：历史抽屉记局次，玩家与聊天记名称", () => {
    const view = setup();
    act(() => view.result.current.onDrawerChange("players"));
    expect(view.result.current.openDrawer).toBe("players");
    act(() => view.result.current.onDrawerChange("history"));
    expect(view.result.current.openDrawer).toBe("history");
    expect(view.result.current.historyDrawerOpen).toBe(true);
    view.rerender({ roundId: "r2", historyAvailable: true, desktopSidebar: true });
    expect(view.result.current.openDrawer).toBeNull();
    act(() => view.result.current.onDrawerChange("chat"));
    expect(view.result.current.openDrawer).toBe("chat");
    act(() => view.result.current.onDrawerChange(null));
    expect(view.result.current.openDrawer).toBeNull();
  });
});
