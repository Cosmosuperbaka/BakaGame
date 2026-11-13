import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RoomListCard, type LobbyRoomView } from "./RoomListCard";

const room: LobbyRoomView = {
  roomId: "1234",
  name: "测试房",
  hasPassword: false,
  inGame: false,
  allowSpectators: true,
  playerCount: 3,
  spectatorCount: 0,
} as LobbyRoomView;

describe("RoomListCard 键盘语义", () => {
  it("房间卡是真正的按钮：Enter 与空格都交给点击处理，收到的是真实的点击事件", async () => {
    const user = userEvent.setup();
    // React 的合成事件在处理函数返回后会清空 currentTarget，要在调用时就记下来
    const received: { type: string; target: EventTarget | null }[] = [];
    const onSelect = vi.fn((event: { type: string; currentTarget: EventTarget | null }) => {
      received.push({ type: event.type, target: event.currentTarget });
    });
    render(<RoomListCard room={room} onSelect={onSelect} />);
    const card = screen.getByRole("button", { name: /测试房/ });
    expect(card.tagName).toBe("BUTTON");
    card.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onSelect).toHaveBeenCalledTimes(2);
    for (const event of received) {
      expect(event.type).toBe("click");
      expect(event.target).toBe(card);
    }
  });

  it("禁用时不响应点击，也不进入键盘焦点序", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<RoomListCard room={room} onSelect={onSelect} disabled />);
    const card = screen.getByRole("button", { name: /测试房/ });
    expect(card).toHaveAttribute("aria-disabled", "true");
    await user.click(card);
    expect(onSelect).not.toHaveBeenCalled();
    await user.tab();
    expect(card).not.toHaveFocus();
  });
});
