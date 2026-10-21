import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { chatThrow } from "@/lib/Motion";
import { stubMatchMedia } from "@/test/MatchMedia";
import { STICKER_PREFIX } from "@/lib/Stickers";
import type { ChatMessage } from "@bakagame/shared";
import { ChatPanel } from "./ChatPanel";

// 表情名来自构建期清单：测试用一份最小清单，路径与清单里的表情名一一对应。
vi.mock("virtual:sticker-manifest", () => ({
  default: {
    packs: [
      {
        name: "夜愿华章",
        dir: "nightwish",
        preview: "/emojis/nightwish/audience_clap.gif",
        animated: true,
        items: [
          {
            key: "audience_clap",
            label: "鼓掌",
            path: "/emojis/nightwish/audience_clap.gif",
            animated: true,
          },
          {
            key: "ghost_laugh",
            label: "冷笑",
            path: "/emojis/nightwish/ghost_laugh.png",
            animated: false,
          },
        ],
      },
    ],
  },
}));

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
      />
    );

    const systemMsg = screen.getByText("游戏开始：第 1 轮出题阶段");
    expect(systemMsg).toBeInTheDocument();
    expect(systemMsg).toBeVisible();
    expect(screen.queryByTestId("chat-message-bubble")).not.toBeInTheDocument();
    expect(screen.queryByText("系统", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "聊天消息" })).toHaveValue("");
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
      />
    );

    const notice = screen.getByText("聊天仅增强版玩家可见");
    const bubble = screen.getByTestId("chat-message-bubble");
    expect(notice).toBeVisible();
    expect(bubble).toHaveTextContent("原版那边好像断了一下");
    expect(notice.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
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
      />
    );

    const bubbles = screen.getAllByTestId("chat-message-bubble");
    expect(bubbles).toHaveLength(2);

    expect(bubbles[0]).toHaveTextContent("这是我的消息");
    expect(bubbles[1]).toHaveTextContent("这是对方的消息");
    expect(screen.getByText("我", { exact: true })).toBeVisible();
    expect(screen.getByText("对手", { exact: true })).toBeVisible();
    expect(bubbles[0].compareDocumentPosition(bubbles[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
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
      />
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

  it("表情消息用清单里的表情名作替代文本，不同表情不再共用一句文案", async () => {
    const messages: ChatMessage[] = [
      {
        id: "m-sticker-clap",
        playerId: "p-other",
        playerName: "对手",
        text: `${STICKER_PREFIX}/emojis/nightwish/audience_clap.gif`,
        createdAt: 1005,
        system: false,
      },
      {
        id: "m-sticker-smirk",
        playerId: "p-me",
        playerName: "我",
        text: `${STICKER_PREFIX}/emojis/nightwish/ghost_laugh.png`,
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
      />
    );

    const clap = await screen.findByRole("img", { name: "鼓掌" });
    expect(clap).toHaveAttribute("src", "/emojis/nightwish/audience_clap.gif");
    expect(screen.getByRole("img", { name: "冷笑" })).toHaveAttribute(
      "src",
      "/emojis/nightwish/ghost_laugh.png"
    );
  });

  it("清单里没有的表情路径退回通用文案，不留空替代文本", async () => {
    const messages: ChatMessage[] = [
      {
        id: "m-sticker-unknown",
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
      />
    );

    const img = screen.getByRole("img", { name: "表情" });
    // 等清单加载完仍是这句：读屏至少知道这是一条表情，不会退化成无名的图
    await waitFor(() => expect(img).toHaveAttribute("alt", "表情"));
    expect(img).toHaveAttribute("src", "/emojis/bilibili/2233_laugh.webp");
  });

  it("消息流是有增量的 live region，读屏只报新到的消息", () => {
    render(
      <ChatPanel
        messages={[
          {
            id: "m-log",
            playerId: "p-other",
            playerName: "对手",
            text: "第 1 天描述阶段",
            createdAt: 1000,
            system: false,
          },
        ]}
        players={mockPlayers}
        myPlayerId="p-me"
        onSendMessage={vi.fn()}
      />
    );

    const log = screen.getByRole("log");
    expect(log).toHaveAttribute("aria-live", "polite");
    // 只报 additions：整段历史每来一条新消息就被重读一遍是噪音
    expect(log).toHaveAttribute("aria-relevant", "additions");
    expect(within(log).getByText("第 1 天描述阶段")).toBeInTheDocument();
  });

  it("支持文本输入与发送触发回调，空文本时禁用", async () => {
    const handleSend = vi.fn().mockResolvedValue(undefined);

    render(
      <ChatPanel messages={[]} players={mockPlayers} myPlayerId="p-me" onSendMessage={handleSend} />
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

  it("发送时文字凝成气泡收进发送按钮，回显那条不再叠一次弹入", async () => {
    const handleSend = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <ChatPanel messages={[]} players={mockPlayers} myPlayerId="p-me" onSendMessage={handleSend} />
    );
    const input = screen.getByRole("combobox", { name: "聊天消息" });
    fireEvent.change(input, { target: { value: "飞出去" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    // 掷出去的那枚胶囊只是装饰，读屏不读
    const ghost = await screen.findByText("飞出去");
    expect(ghost.closest("[aria-hidden='true']")).not.toBeNull();
    expect(input).toHaveValue("");

    rerender(
      <ChatPanel
        messages={[
          {
            id: "echo",
            playerId: "p-me",
            playerName: "我",
            text: "飞出去",
            createdAt: 1,
            system: false,
          },
        ]}
        players={mockPlayers}
        myPlayerId="p-me"
        onSendMessage={handleSend}
      />
    );
    expect(
      within(screen.getByTestId("chat-message-bubble")).getByText("飞出去")
    ).toBeInTheDocument();
  });

  it(
    "发送失败：收回动画把原文送回输入框并报一次失败",
    async () => {
      const failure = new Error("房间已断开");
      const handleSend = vi.fn().mockRejectedValue(failure);
      const onError = vi.fn();

      render(
        <ChatPanel
          messages={[]}
          players={mockPlayers}
          myPlayerId="p-me"
          onSendMessage={handleSend}
          onError={onError}
        />
      );

      const input = screen.getByRole("combobox", { name: "聊天消息" });
      fireEvent.change(input, { target: { value: "我这轮先投 Kanade" } });
      fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

      await waitFor(() => expect(handleSend).toHaveBeenCalledExactlyOnceWith("我这轮先投 Kanade"));
      expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
      // 掷出时先清空输入框（防重复提交），原文随收回动画回来；动画不额外触发第二次发送
      await waitFor(() => expect(input).toHaveValue("我这轮先投 Kanade"), {
        timeout: chatThrow.waitMs,
      });
      expect(handleSend).toHaveBeenCalledTimes(1);
    },
    chatThrow.waitMs + 4000
  );

  it(
    "已 ACK 但回显晚于等待窗口：不当成失败，原文不回输入框也不重发",
    async () => {
      const handleSend = vi.fn().mockResolvedValue(undefined);
      const onError = vi.fn();
      const { rerender } = render(
        <ChatPanel
          messages={[]}
          players={mockPlayers}
          myPlayerId="p-me"
          onSendMessage={handleSend}
          onError={onError}
        />
      );

      const input = screen.getByRole("combobox", { name: "聊天消息" });
      fireEvent.change(input, { target: { value: "回显慢了一步" } });
      fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
      await waitFor(() => expect(handleSend).toHaveBeenCalledExactlyOnceWith("回显慢了一步"));

      // 越过视觉等待窗口：胶囊自己撤掉，但业务上这条已经发出去了
      await new Promise((resolve) => setTimeout(resolve, chatThrow.waitMs + 300));
      expect(input).toHaveValue("");
      expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
      expect(onError).not.toHaveBeenCalled();
      expect(handleSend).toHaveBeenCalledTimes(1);

      rerender(
        <ChatPanel
          messages={[
            {
              id: "late-echo",
              playerId: "p-me",
              playerName: "我",
              text: "回显慢了一步",
              createdAt: 1,
              system: false,
            },
          ]}
          players={mockPlayers}
          myPlayerId="p-me"
          onSendMessage={handleSend}
          onError={onError}
        />
      );
      expect(
        within(screen.getByTestId("chat-message-bubble")).getByText("回显慢了一步")
      ).toBeInTheDocument();
      expect(handleSend).toHaveBeenCalledTimes(1);
    },
    chatThrow.waitMs + 6000
  );

  it("减弱动效下没有收回动画，失败当场把原文留在输入框", async () => {
    stubMatchMedia(true);
    try {
      const handleSend = vi.fn().mockRejectedValue(new Error("发送失败"));
      render(
        <ChatPanel
          messages={[]}
          players={mockPlayers}
          myPlayerId="p-me"
          onSendMessage={handleSend}
        />
      );
      const input = screen.getByRole("combobox", { name: "聊天消息" });
      fireEvent.change(input, { target: { value: "关掉动效的那条" } });
      fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

      await waitFor(() => expect(input).toHaveValue("关掉动效的那条"));
      expect(handleSend).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
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
      />
    );

    expect(screen.getByText("@我")).toBeInTheDocument();
    const bubble = screen.getByTestId("chat-message-bubble");
    expect(bubble).toHaveTextContent("你好 @我 来看这个！");
    expect(within(bubble).getByText("@我")).toBeVisible();
    expect(screen.queryByRole("listbox", { name: "提及玩家" })).not.toBeInTheDocument();
  });
  it("输入提及只提供其他成员，选择候选后发送完整消息", async () => {
    const handleSend = vi.fn().mockResolvedValue(undefined);
    render(
      <ChatPanel messages={[]} players={mockPlayers} myPlayerId="p-me" onSendMessage={handleSend} />
    );
    const input = screen.getByRole("combobox", { name: "聊天消息" });
    fireEvent.change(input, { target: { value: "你好 @" } });
    const candidates = screen.getByRole("listbox", { name: "提及玩家" });
    expect(input).toHaveAttribute("aria-expanded", "true");
    await waitFor(() =>
      expect(within(candidates).getByRole("option", { name: "对手" })).toBeVisible()
    );
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
      {
        id: "private-1",
        playerId: "p-other",
        playerName: "对手",
        text: "幽灵讨论",
        channel: "ghost",
        createdAt: 1,
        system: false,
      },
      {
        id: "private-system",
        playerId: "system",
        playerName: "系统",
        text: "第 2 天开始",
        createdAt: 2,
        system: true,
      },
    ];
    render(
      <ChatPanel
        messages={messages}
        players={mockPlayers}
        myPlayerId="p-me"
        notice="幽灵频道：仅出局玩家可见"
        onSendMessage={vi.fn()}
      />
    );
    expect(screen.getByText("第 2 天开始")).toBeVisible();
    const bubbles = screen.getAllByTestId("chat-message-bubble");
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toHaveTextContent("幽灵讨论");
    expect(within(bubbles[0]).queryByText("第 2 天开始")).not.toBeInTheDocument();
    expect(screen.queryByText("系统", { exact: true })).not.toBeInTheDocument();
  });

  it("别人的消息显示 +1，点击直接复读同一文本；自己与系统消息不显示", () => {
    const onRepeatMessage = vi.fn();
    const messages: ChatMessage[] = [
      {
        id: "m-other",
        playerId: "p-other",
        playerName: "对手",
        text: "复读这一条",
        createdAt: 1000,
        system: false,
      },
      {
        id: "m-mine",
        playerId: "p-me",
        playerName: "我",
        text: "自己的消息",
        createdAt: 2000,
        system: false,
      },
      {
        id: "m-system",
        playerId: "system",
        playerName: "系统",
        text: "系统消息",
        createdAt: 3000,
        system: true,
      },
    ];

    render(
      <ChatPanel
        messages={messages}
        players={mockPlayers}
        myPlayerId="p-me"
        onSendMessage={vi.fn()}
        onRepeatMessage={onRepeatMessage}
      />
    );

    const button = screen.getByRole("button", { name: "复读这条消息" });
    expect(button.textContent).toBe("+1");
    expect(screen.getAllByRole("button", { name: "复读这条消息" })).toHaveLength(1);

    fireEvent.click(button);
    expect(onRepeatMessage).toHaveBeenCalledWith("复读这一条");
  });

  it("复读请求在途时连点只发送一次", () => {
    let release!: () => void;
    const onRepeatMessage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    render(
      <ChatPanel
        messages={[
          {
            id: "m-other",
            playerId: "p-other",
            playerName: "对手",
            text: "只发一次",
            createdAt: 1000,
            system: false,
          },
        ]}
        players={mockPlayers}
        myPlayerId="p-me"
        onSendMessage={vi.fn()}
        onRepeatMessage={onRepeatMessage}
      />
    );

    const button = screen.getByRole("button", { name: "复读这条消息" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onRepeatMessage).toHaveBeenCalledTimes(1);
    release();
  });
});
