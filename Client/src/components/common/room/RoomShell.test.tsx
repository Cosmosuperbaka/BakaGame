import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageSquare } from "lucide-react";
import { ChatPanel } from "@/components/common/ChatPanel";
import { roomEntrance, roomEntranceMs } from "@/lib/Motion";
import { stubMatchMedia } from "@/test/MatchMedia";
import { ChatColumn, PlayerColumn, RoomShell } from "./RoomShell";

const shell = (withColumns: boolean) => (
  <RoomShell
    onLeave={() => {}}
    title="测试房间"
    roomId="1234"
    player={withColumns ? <PlayerColumn>玩家</PlayerColumn> : undefined}
    game={<p>游戏区</p>}
    chat={withColumns ? <ChatColumn>聊天</ChatColumn> : undefined}
  />
);

describe("RoomShell 进房编排", () => {
  // 帧由测试手动推进，模拟跨页过渡暂停渲染期间第一帧迟迟不来。
  let frames: FrameRequestCallback[] = [];
  const nextFrame = () =>
    act(() => frames.splice(0).forEach((callback) => callback(performance.now())));

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback)
    );
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("挂载后四栏按编排顺序标记，窗口从第一帧算起、过后撤掉", async () => {
    const { container } = render(shell(true));
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute("data-room-entering");
    // 文档顺序即阅读顺序（顶栏→玩家栏→游戏区→聊天栏），与 CSS 延迟的生成顺序一致。
    const parts = [...root.querySelectorAll<HTMLElement>("[data-room-part]")].map(
      (node) => node.dataset.roomPart
    );
    expect(parts).toEqual([...roomEntrance.parts]);

    // 第一帧之前各栏动画都还没起播，窗口不能先走掉。
    await act(() => vi.advanceTimersByTime(roomEntranceMs * 2));
    expect(root).toHaveAttribute("data-room-entering");

    nextFrame();
    await act(() => vi.advanceTimersByTime(roomEntranceMs - 1));
    expect(root).toHaveAttribute("data-room-entering");
    await act(() => vi.advanceTimersByTime(1));
    expect(root).not.toHaveAttribute("data-room-entering");
  });

  it("窗口过后才出现的栏（断线重连后补上）直接出现，不重播编排", async () => {
    const { container, rerender } = render(shell(false));
    nextFrame();
    await act(() => vi.advanceTimersByTime(roomEntranceMs));

    rerender(shell(true));
    const root = container.firstElementChild as HTMLElement;
    expect(root).not.toHaveAttribute("data-room-entering");
    expect(root.querySelector("[data-room-part='player']")).toBeInTheDocument();
    expect(root.querySelector("[data-room-part='chat']")).toBeInTheDocument();
  });
});

describe("RoomShell 栏的挂载", () => {
  const chatDrawer = (openDrawer: string | null) => (
    <RoomShell
      onLeave={() => {}}
      title="测试房间"
      player={<PlayerColumn>玩家栏</PlayerColumn>}
      game={<p>游戏区</p>}
      chat={
        <ChatColumn>
          <ChatPanel messages={[]} onSendMessage={() => {}} />
        </ChatColumn>
      }
      openDrawer={openDrawer}
      drawers={[
        {
          key: "chat",
          icon: MessageSquare,
          label: "聊天",
          side: "right",
          title: "聊天",
          closeFrom: "xl",
          content: <ChatPanel messages={[]} onSendMessage={() => {}} />,
        },
      ]}
    />
  );
  afterEach(() => vi.unstubAllGlobals());

  it("宽屏只挂桌面栏，窄屏不挂桌面栏", () => {
    stubMatchMedia(true);
    const wide = render(chatDrawer(null));
    expect(screen.getByText("玩家栏")).toBeInTheDocument();
    expect(screen.getAllByRole("combobox", { name: "聊天消息" })).toHaveLength(1);
    wide.unmount();

    stubMatchMedia(false);
    render(chatDrawer(null));
    expect(screen.queryByText("玩家栏")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "聊天消息" })).not.toBeInTheDocument();
  });

  it("窄屏打开聊天抽屉时聊天只有一个实例", () => {
    stubMatchMedia(false);
    render(chatDrawer("chat"));
    // 抽屉是 modal，打开期间背后的内容对读屏不可达，所以连隐藏的也要算上
    expect(screen.getAllByRole("combobox", { name: "聊天消息", hidden: true })).toHaveLength(1);
  });

  it("视口越过断点时桌面栏随之挂上或卸下", () => {
    const media = stubMatchMedia(false);
    render(chatDrawer(null));
    expect(screen.queryByText("玩家栏")).not.toBeInTheDocument();
    act(() => media.crossBreakpoint(true));
    expect(screen.getByText("玩家栏")).toBeInTheDocument();
    act(() => media.crossBreakpoint(false));
    expect(screen.queryByText("玩家栏")).not.toBeInTheDocument();
  });

  it("草稿在关闭再打开抽屉、跨断点切换后都保留", async () => {
    const media = stubMatchMedia(false);
    const view = render(chatDrawer("chat"));
    fireEvent.change(screen.getByRole("combobox", { name: "聊天消息" }), {
      target: { value: "打了一半" },
    });
    view.rerender(chatDrawer(null));
    await waitFor(() =>
      expect(screen.queryByRole("combobox", { name: "聊天消息" })).not.toBeInTheDocument()
    );
    view.rerender(chatDrawer("chat"));
    expect(screen.getByRole("combobox", { name: "聊天消息" })).toHaveValue("打了一半");
    // 旋到宽屏：抽屉自动关闭，桌面栏接手，草稿还在
    view.rerender(chatDrawer(null));
    act(() => media.crossBreakpoint(true));
    expect(screen.getByRole("combobox", { name: "聊天消息" })).toHaveValue("打了一半");
  });
});
