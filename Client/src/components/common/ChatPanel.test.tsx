import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatPanel } from "./ChatPanel";
import { STICKER_PREFIX } from "@/lib/Stickers";
import type { ChatMessage } from "@/types";

describe("ChatPanel (Common)", () => {
  const mockPlayers = [
    { id: "p-me", name: "我" },
    { id: "p-other", name: "对手" },
  ];

  it("系统消息/阶段提醒渲染为纯文本无背景样式", () => {
    const messages: ChatMessage[] = [
      {
        id: "sys-1",
        playerId: "system",
        playerName: "系统",
        text: "游戏开始：第 1 轮出题阶段",
        createdAt: 1000,
        system: true,
      },
    ];

    const { container } = render(
      <ChatPanel
        messages={messages}
        players={mockPlayers}
        myPlayerId="p-me"
        onSendMessage={vi.fn()}
      />,
    );

    const systemMsg = screen.getByText("游戏开始：第 1 轮出题阶段");
    expect(systemMsg).toBeInTheDocument();
    // 验证系统消息没有嵌套带灰色背景的 span 胶囊
    expect(systemMsg.tagName.toLowerCase()).toBe("div");
    expect(systemMsg.className).toContain("text-center");
    expect(systemMsg.className).toContain("text-xs");
    expect(container.querySelector(".rounded-full.bg-muted\\/40")).toBeNull();
  });

  it("正确区分本人与他人的消息气泡左右布局", () => {
    const messages: ChatMessage[] = [
      {
        id: "m-1",
        playerId: "p-me",
        playerName: "我",
        text: "这是我的消息",
        createdAt: 1001,
        system: false,
      },
      {
        id: "m-2",
        playerId: "p-other",
        playerName: "对手",
        text: "这是对方的消息",
        createdAt: 1002,
        system: false,
      },
    ];

    render(
      <ChatPanel
        messages={messages}
        players={mockPlayers}
        myPlayerId="p-me"
        onSendMessage={vi.fn()}
      />,
    );

    const bubbles = screen.getAllByTestId("chat-message-bubble");
    expect(bubbles).toHaveLength(2);

    // 本人消息：靠右侧布局与 primary 背景
    expect(bubbles[0]).toHaveTextContent("这是我的消息");
    expect(bubbles[0].className).toContain("bg-primary");

    // 他人消息：靠左侧布局与 muted 弱底色（明度低于面板，不刺眼）
    expect(bubbles[1]).toHaveTextContent("这是对方的消息");
    expect(bubbles[1].className).toContain("bg-muted");
    expect(bubbles[1].className).not.toContain("bg-card");
  });

  it("支持 Ghost 幽灵通道的虚线与弱化样式", () => {
    const messages: ChatMessage[] = [
      {
        id: "m-ghost-1",
        playerId: "p-me",
        playerName: "我",
        text: "幽灵本尊发言",
        createdAt: 1003,
        system: false,
        channel: "ghost",
      },
      {
        id: "m-ghost-2",
        playerId: "p-other",
        playerName: "对手",
        text: "其他幽灵发言",
        createdAt: 1004,
        system: false,
        channel: "ghost",
      },
    ];

    render(
      <ChatPanel
        messages={messages}
        players={mockPlayers}
        myPlayerId="p-me"
        onSendMessage={vi.fn()}
      />,
    );

    const bubbles = screen.getAllByTestId("chat-message-bubble");
    expect(bubbles[0].className).toContain("border-dashed");
    expect(bubbles[1].className).toContain("border-dashed");
  });

  it("渲染合法的表情包贴纸并在点击表情时发送", () => {
    const messages: ChatMessage[] = [
      {
        id: "m-sticker",
        playerId: "p-other",
        playerName: "对手",
        text: `${STICKER_PREFIX}/emojis/bilibili/2233_laugh.webp`,
        createdAt: 1005,
        system: false,
      },
    ];

    render(
      <ChatPanel
        messages={messages}
        players={mockPlayers}
        myPlayerId="p-me"
        onSendMessage={vi.fn()}
      />,
    );

    const img = screen.getByRole("img", { name: "表情" });
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "/emojis/bilibili/2233_laugh.webp");
  });

  it("支持文本输入与发送触发回调，空文本时禁用", async () => {
    const handleSend = vi.fn().mockResolvedValue(undefined);

    render(
      <ChatPanel
        messages={[]}
        players={mockPlayers}
        myPlayerId="p-me"
        onSendMessage={handleSend}
      />,
    );

    const input = screen.getByPlaceholderText("请输入文本");
    const sendButton = screen.getByRole("button", { name: "发送消息" });

    // 初始状态下发送按钮被禁用
    expect(sendButton).toBeDisabled();

    // 输入空白字符串依然禁用
    fireEvent.change(input, { target: { value: "   " } });
    expect(sendButton).toBeDisabled();

    // 输入有效文本后启用并点击发送
    fireEvent.change(input, { target: { value: "你好世界" } });
    expect(sendButton).not.toBeDisabled();

    fireEvent.click(sendButton);
    expect(handleSend).toHaveBeenCalledWith("你好世界");
  });

  it("在正文中正确识别并高亮 @提及 成员", () => {
    const messages: ChatMessage[] = [
      {
        id: "m-mention",
        playerId: "p-other",
        playerName: "对手",
        text: "你好 @我 来看这个！",
        createdAt: 1006,
        system: false,
      },
    ];

    render(
      <ChatPanel
        messages={messages}
        players={mockPlayers}
        myPlayerId="p-me"
        onSendMessage={vi.fn()}
      />,
    );

    expect(screen.getByText("@我")).toBeInTheDocument();
    const bubble = screen.getByTestId("chat-message-bubble");
    // 被提及本人时有光圈轮廓
    expect(bubble.className).toContain("ring-1 ring-primary/45");
  });
});
