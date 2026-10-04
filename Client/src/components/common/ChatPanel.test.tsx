import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatPanel } from "./ChatPanel";
import { STICKER_PREFIX } from "@/lib/Stickers";
import type { ChatMessage } from "@/types";

describe("ChatPanel (Common)", () => {
  const mockPlayers = [
    { id: "p-me", name: "我" },
    { id: "p-other", name: "对手" },
  ];

  it("系统消息/阶段提醒展示原文，不作为玩家气泡或署名", () => {
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

    render(
      <ChatPanel
        messages={messages}
        players={mockPlayers}
        myPlayerId="p-me"
        onSendMessage={vi.fn()}
      />,
    );

    const systemMsg = screen.getByText("游戏开始：第 1 轮出题阶段");
    expect(systemMsg).toBeInTheDocument();
    expect(systemMsg).toBeVisible();
    expect(screen.queryByTestId("chat-message-bubble")).not.toBeInTheDocument();
    expect(screen.queryByText("系统", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("频道可见范围说明先于玩家消息展示，不作为聊天正文", () => {
    const messages: ChatMessage[] = [
      {
        id: "m-1",
        playerId: "p-other",
        playerName: "对手",
        text: "原版那边好像断了一下",
        createdAt: 1000,
        system: false,
      },
    ];

    render(
      <ChatPanel
        messages={messages}
        players={mockPlayers}
        myPlayerId="p-me"
        notice="聊天仅增强版玩家可见"
        onSendMessage={vi.fn()}
      />,
    );

    const notice = screen.getByText("聊天仅增强版玩家可见");
    const bubble = screen.getByTestId("chat-message-bubble");
    expect(notice).toBeVisible();
    expect(bubble).toHaveTextContent("原版那边好像断了一下");
    expect(notice.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(within(bubble).queryByText("聊天仅增强版玩家可见")).not.toBeInTheDocument();
  });

  it("保留本人和他人消息的发送者、正文与时间顺序", () => {
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

    expect(bubbles[0]).toHaveTextContent("这是我的消息");
    expect(bubbles[1]).toHaveTextContent("这是对方的消息");
    expect(screen.getByText("我", { exact: true })).toBeVisible();
    expect(screen.getByText("对手", { exact: true })).toBeVisible();
    expect(bubbles[0].compareDocumentPosition(bubbles[1]) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("幽灵私密频道保留双方发言并展示可见范围说明", () => {
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
        notice="幽灵频道：仅出局玩家可见"
        onSendMessage={vi.fn()}
      />,
    );

    const bubbles = screen.getAllByTestId("chat-message-bubble");
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]).toHaveTextContent("幽灵本尊发言");
    expect(bubbles[1]).toHaveTextContent("其他幽灵发言");
    expect(screen.getByText("我", { exact: true })).toBeVisible();
    expect(screen.getByText("对手", { exact: true })).toBeVisible();
    expect(screen.getByText("幽灵频道：仅出局玩家可见")).toBeVisible();
    for (const bubble of bubbles) {
      expect(within(bubble).queryByText("幽灵频道：仅出局玩家可见")).not.toBeInTheDocument();
    }
  });

  it("合法表情包消息展示可访问图片与稳定资源路径", () => {
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
    await waitFor(() => expect(handleSend).toHaveBeenCalledExactlyOnceWith("你好世界"));
    await waitFor(() => expect(input).toHaveValue(""));
    expect(sendButton).toBeDisabled();
  });

  it("正文保留提及成员与上下文，不把提及误作输入候选", () => {
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
    expect(bubble).toHaveTextContent("你好 @我 来看这个！");
    expect(within(bubble).getByText("@我")).toBeVisible();
    expect(screen.queryByRole("listbox", { name: "提及玩家" })).not.toBeInTheDocument();
  });
  it("输入提及只提供其他成员，选择候选后发送完整消息", async () => {
    const handleSend = vi.fn().mockResolvedValue(undefined);
    render(<ChatPanel messages={[]} players={mockPlayers} myPlayerId="p-me" onSendMessage={handleSend} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "你好 @" } });
    const candidates = screen.getByRole("listbox", { name: "提及玩家" });
    expect(input).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(within(candidates).getByRole("option", { name: "对手" })).toBeVisible());
    expect(within(candidates).queryByRole("option", { name: "我" })).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("你好 @对手 ");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(handleSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(handleSend).toHaveBeenCalledExactlyOnceWith("你好 @对手"));
  });

  it("频道消息与系统提示混合时，只有玩家消息形成气泡", () => {
    const messages: ChatMessage[] = [
      { id: "private-1", playerId: "p-other", playerName: "对手", text: "幽灵讨论", channel: "ghost", createdAt: 1, system: false },
      { id: "private-system", playerId: "system", playerName: "系统", text: "第 2 天开始", createdAt: 2, system: true },
    ];
    render(<ChatPanel messages={messages} players={mockPlayers} myPlayerId="p-me"
      notice="幽灵频道：仅出局玩家可见" onSendMessage={vi.fn()} />);
    expect(screen.getByText("第 2 天开始")).toBeVisible();
    const bubbles = screen.getAllByTestId("chat-message-bubble");
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toHaveTextContent("幽灵讨论");
    expect(within(bubbles[0]).queryByText("第 2 天开始")).not.toBeInTheDocument();
    expect(screen.queryByText("系统", { exact: true })).not.toBeInTheDocument();
  });
});
