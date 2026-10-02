import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { roomEntrance, roomEntranceMs } from "@/lib/Motion";
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
  const nextFrame = () => act(() => frames.splice(0).forEach((callback) => callback(performance.now())));

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("挂载后四栏按编排顺序标记，窗口从第一帧算起、过后撤掉", () => {
    const { container } = render(shell(true));
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute("data-room-entering");
    // 文档顺序即阅读顺序（顶栏→玩家栏→游戏区→聊天栏），与 CSS 延迟的生成顺序一致。
    const parts = [...root.querySelectorAll<HTMLElement>("[data-room-part]")].map((node) => node.dataset.roomPart);
    expect(parts).toEqual([...roomEntrance.parts]);

    // 第一帧之前各栏动画都还没起播，窗口不能先走掉。
    act(() => vi.advanceTimersByTime(roomEntranceMs * 2));
    expect(root).toHaveAttribute("data-room-entering");

    nextFrame();
    act(() => vi.advanceTimersByTime(roomEntranceMs - 1));
    expect(root).toHaveAttribute("data-room-entering");
    act(() => vi.advanceTimersByTime(1));
    expect(root).not.toHaveAttribute("data-room-entering");
  });

  it("窗口过后才出现的栏（断线重连后补上）直接出现，不重播编排", () => {
    const { container, rerender } = render(shell(false));
    nextFrame();
    act(() => vi.advanceTimersByTime(roomEntranceMs));

    rerender(shell(true));
    const root = container.firstElementChild as HTMLElement;
    expect(root).not.toHaveAttribute("data-room-entering");
    expect(root.querySelector("[data-room-part='player']")).toBeInTheDocument();
    expect(root.querySelector("[data-room-part='chat']")).toBeInTheDocument();
  });
});
