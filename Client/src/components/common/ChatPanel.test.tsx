import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
      {
        name: "日常",
        dir: "daily",
        preview: "/emojis/daily/hello.png",
        animated: false,
        items: [{ key: "hello", label: "你好", path: "/emojis/daily/hello.png", animated: false }],
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
    expect(screen.getByRole("combobox", { name: "聊天消息" })).toHaveAttribute(
      "data-agent-control",
      "chat.input"
    );
    expect(screen.getByRole("button", { name: "发送消息" })).toHaveAttribute(
      "data-agent-control",
      "chat.send"
    );
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

    const clap = await screen.findByRole("img", { name: /鼓掌/ });
    expect(clap).toHaveAttribute("src", "/emojis/nightwish/audience_clap.gif");
    expect(screen.getByRole("img", { name: /冷笑/ })).toHaveAttribute(
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

  it("只有最新一条他人消息显示 +1，点击直接复读同一文本", () => {
    const onRepeatMessage = vi.fn();
    const messages: ChatMessage[] = [
      {
        id: "m-older",
        playerId: "p-other",
        playerName: "对手",
        text: "上一条消息",
        createdAt: 1000,
        system: false,
      },
      {
        id: "m-latest",
        playerId: "p-other",
        playerName: "对手",
        text: "复读这一条",
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
    // 系统提示不参与复读，按钮仍挂在最新一条玩家消息的气泡上
    const bubbles = screen.getAllByTestId("chat-message-bubble");
    expect(bubbles[1].parentElement).toContainElement(button);

    fireEvent.click(button);
    expect(onRepeatMessage).toHaveBeenCalledWith("复读这一条");
  });

  it("末尾连续相同文本叠成复读链：只在最前面那条挂 ×N，系统提示不打断，链断了角标消失", () => {
    const say = (id: string, text: string, playerId = "p-other"): ChatMessage => ({
      id,
      playerId,
      playerName: playerId === "p-me" ? "我" : "对手",
      text,
      createdAt: 0,
      system: false,
    });
    const chain: ChatMessage[] = [
      say("m-1", "前面的话"),
      say("m-2", "草"),
      say("m-3", "草", "p-me"),
      { ...say("m-sys", "第 2 天开始"), playerId: "system", playerName: "系统", system: true },
      say("m-4", "草"),
    ];
    const { container, rerender } = render(
      <ChatPanel messages={chain} players={mockPlayers} myPlayerId="p-me" onSendMessage={vi.fn()} />
    );

    const counts = () =>
      [...container.querySelectorAll("[aria-hidden='true']")].filter((node) =>
        /^×\d+$/.test(node.textContent ?? "")
      );
    expect(counts()).toHaveLength(1);
    expect(counts()[0]).toHaveTextContent("×3");
    const bubbles = screen.getAllByTestId("chat-message-bubble");
    expect(bubbles[3].parentElement).toContainElement(counts()[0] as HTMLElement);

    rerender(
      <ChatPanel
        messages={[...chain, say("m-5", "说点别的")]}
        players={mockPlayers}
        myPlayerId="p-me"
        onSendMessage={vi.fn()}
      />
    );
    expect(counts()).toHaveLength(0);
  });

  it("最新一条是自己发送的消息时不显示 +1", () => {
    const messages: ChatMessage[] = [
      {
        id: "m-other",
        playerId: "p-other",
        playerName: "对手",
        text: "别人的旧消息",
        createdAt: 1000,
        system: false,
      },
      {
        id: "m-mine",
        playerId: "p-me",
        playerName: "我",
        text: "自己的最新消息",
        createdAt: 2000,
        system: false,
      },
    ];

    render(
      <ChatPanel
        messages={messages}
        players={mockPlayers}
        myPlayerId="p-me"
        onSendMessage={vi.fn()}
        onRepeatMessage={vi.fn()}
      />
    );

    expect(screen.queryByRole("button", { name: "复读这条消息" })).not.toBeInTheDocument();
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

describe("ChatPanel 表情选择器", () => {
  const players = [
    { id: "p-me", name: "我" },
    { id: "p-other", name: "对手" },
  ];
  const renderPanel = (onSendMessage = vi.fn().mockResolvedValue(undefined)) =>
    render(
      <ChatPanel messages={[]} players={players} myPlayerId="p-me" onSendMessage={onSendMessage} />
    );

  it("再点一次笑脸按钮就收起，不会立刻又展开", async () => {
    const user = userEvent.setup();
    renderPanel();
    const smile = screen.getByRole("button", { name: "发送表情" });
    await user.click(smile);
    expect(smile).toHaveAttribute("aria-expanded", "true");
    await screen.findByRole("tablist", { name: "表情包分类" });
    await user.click(smile);
    expect(smile).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(screen.queryByRole("tablist")).not.toBeInTheDocument());
  });

  it("打开时焦点进入面板，Esc 关闭并把焦点还给笑脸按钮", async () => {
    const user = userEvent.setup();
    renderPanel();
    const smile = screen.getByRole("button", { name: "发送表情" });
    await user.click(smile);
    const panel = await screen.findByRole("dialog", { name: "表情包" });
    expect(panel).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard("{Escape}");
    expect(smile).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(smile).toHaveFocus());
  });

  it("Tab 能走到每个表情，方向键在格子里移动焦点", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "发送表情" }));
    await screen.findByRole("tablist", { name: "表情包分类" });
    await user.tab();
    const first = screen.getByRole("button", { name: /鼓掌/ });
    expect(first).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: /冷笑/ })).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(first).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("button", { name: /冷笑/ })).toHaveFocus();
  });

  it("页签是完整的页签语义：方向键切换，选中页签与面板互相关联", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "发送表情" }));
    const tabs = await screen.findAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", tabs[0].id);
    expect(tabs[0]).toHaveAttribute("aria-controls", panel.id);
    tabs[0].focus();
    await user.keyboard("{ArrowRight}");
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: /你好/ })).toBeInTheDocument();
  });

  it("选中表情后发送并收起面板", async () => {
    const user = userEvent.setup();
    const send = vi.fn().mockResolvedValue(undefined);
    renderPanel(send);
    await user.click(screen.getByRole("button", { name: "发送表情" }));
    await user.click(await screen.findByRole("button", { name: /鼓掌/ }));
    expect(send).toHaveBeenCalledWith(`${STICKER_PREFIX}/emojis/nightwish/audience_clap.gif`);
    expect(screen.getByRole("button", { name: "发送表情" })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
  });
});

describe("ChatPanel 提及候选的光标与焦点", () => {
  const players = [
    { id: "p-me", name: "我" },
    { id: "p-other", name: "小明" },
  ];
  const send = vi.fn().mockResolvedValue(undefined);
  const renderPanel = () =>
    render(<ChatPanel messages={[]} players={players} myPlayerId="p-me" onSendMessage={send} />);

  it("光标移出提及范围后候选收起，回车发送的是原文而不是拼坏的草稿", async () => {
    const user = userEvent.setup();
    send.mockClear();
    renderPanel();
    const input = screen.getByRole("combobox", { name: "聊天消息" });
    await user.type(input, "你好 @小");
    expect(screen.getByRole("listbox", { name: "提及玩家" })).toBeInTheDocument();
    await user.keyboard("{Home}");
    await waitFor(() =>
      expect(screen.queryByRole("listbox", { name: "提及玩家" })).not.toBeInTheDocument()
    );
    await user.keyboard("{Enter}");
    expect(send).toHaveBeenCalledExactlyOnceWith("你好 @小");
    expect(input).toHaveValue("");
  });

  it("光标移回提及范围内，候选重新出现", async () => {
    const user = userEvent.setup();
    renderPanel();
    const input = screen.getByRole("combobox", { name: "聊天消息" });
    await user.type(input, "你好 @小");
    await user.keyboard("{Home}");
    await user.keyboard("{End}");
    expect(screen.getByRole("listbox", { name: "提及玩家" })).toBeInTheDocument();
  });

  it("输入框失焦后候选收起", async () => {
    const user = userEvent.setup();
    renderPanel();
    const input = screen.getByRole("combobox", { name: "聊天消息" });
    await user.type(input, "@小");
    expect(screen.getByRole("listbox", { name: "提及玩家" })).toBeInTheDocument();
    await user.click(document.body);
    await waitFor(() =>
      expect(screen.queryByRole("listbox", { name: "提及玩家" })).not.toBeInTheDocument()
    );
  });

  it("点候选不会先让输入框失焦，选中后文本完整", async () => {
    const user = userEvent.setup();
    renderPanel();
    const input = screen.getByRole("combobox", { name: "聊天消息" });
    await user.type(input, "你好 @小");
    await user.click(screen.getByRole("option", { name: "小明" }));
    expect(input).toHaveValue("你好 @小明 ");
  });
});

describe("ChatPanel 滚动跟随", () => {
  const players = [
    { id: "p-me", name: "我" },
    { id: "p-other", name: "对手" },
  ];
  const message = (id: string, playerId = "p-other"): ChatMessage => ({
    id,
    playerId,
    playerName: playerId === "p-me" ? "我" : "对手",
    text: `消息 ${id}`,
    createdAt: Number(id.replace(/\D/g, "")) * 1000,
    system: false,
  });
  /** jsdom 不做布局：给滚动区装上可读写的几何，赋值 scrollTop 时像浏览器一样补发 scroll 事件。 */
  async function installViewport(container: HTMLElement, state: { top: number }) {
    const viewport = container.querySelector<HTMLElement>("[data-scroll-region]")!;
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 300 });
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      get: () => state.top,
      set: (value: number) => {
        state.top = value;
        fireEvent.scroll(viewport);
      },
    });
    // 挂载时排的那次贴底先落定，再开始模拟玩家的操作。
    await new Promise((resolve) => setTimeout(resolve, 40));
    return viewport;
  }
  const scrollTo = (viewport: HTMLElement, state: { top: number }, top: number) => {
    state.top = top;
    fireEvent.scroll(viewport);
  };
  const renderPanel = (messages: ChatMessage[]) => {
    const view = render(
      <ChatPanel messages={messages} players={players} myPlayerId="p-me" onSendMessage={vi.fn()} />
    );
    const rerender = (next: ChatMessage[]) =>
      view.rerender(
        <ChatPanel messages={next} players={players} myPlayerId="p-me" onSendMessage={vi.fn()} />
      );
    return { ...view, rerender };
  };

  it("玩家在底部时新消息跟随到底，不出现「有新消息」", async () => {
    const state = { top: 0 };
    const view = renderPanel([message("m1")]);
    const viewport = await installViewport(view.container, state);
    scrollTo(viewport, state, 700);
    view.rerender([message("m1"), message("m2")]);
    await waitFor(() => expect(state.top).toBe(1000));
    expect(screen.queryByRole("button", { name: "有新消息" })).not.toBeInTheDocument();
  });

  it("玩家上翻时新消息不拽回底部，出现「有新消息」，点击回到底部", async () => {
    const state = { top: 0 };
    const view = renderPanel([message("m1")]);
    const viewport = await installViewport(view.container, state);
    scrollTo(viewport, state, 100);
    view.rerender([message("m1"), message("m2")]);
    const jump = await screen.findByRole("button", { name: "有新消息" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(state.top).toBe(100);
    fireEvent.click(jump);
    expect(state.top).toBe(1000);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "有新消息" })).not.toBeInTheDocument()
    );
  });

  it("上翻后自己手动回到底部，提示消失", async () => {
    const state = { top: 0 };
    const view = renderPanel([message("m1")]);
    const viewport = await installViewport(view.container, state);
    scrollTo(viewport, state, 100);
    view.rerender([message("m1"), message("m2")]);
    await screen.findByRole("button", { name: "有新消息" });
    scrollTo(viewport, state, 690);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "有新消息" })).not.toBeInTheDocument()
    );
  });

  it("自己发的消息即使上翻中也贴底，且不提示", async () => {
    const state = { top: 0 };
    const view = renderPanel([message("m1")]);
    const viewport = await installViewport(view.container, state);
    scrollTo(viewport, state, 100);
    view.rerender([message("m1"), message("m2", "p-me")]);
    await waitFor(() => expect(state.top).toBe(1000));
    expect(screen.queryByRole("button", { name: "有新消息" })).not.toBeInTheDocument();
  });

  it("窗口满后条数不再变化，仍按最后一条的标识判断新消息", async () => {
    const state = { top: 0 };
    const view = renderPanel([message("m1"), message("m2")]);
    const viewport = await installViewport(view.container, state);
    scrollTo(viewport, state, 700);
    view.rerender([message("m2"), message("m3")]);
    await waitFor(() => expect(state.top).toBe(1000));
    scrollTo(viewport, state, 100);
    view.rerender([message("m3"), message("m4")]);
    expect(await screen.findByRole("button", { name: "有新消息" })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(state.top).toBe(100);
  });
});

describe("ChatPanel 并发发送的失败回写", () => {
  const players = [
    { id: "p-me", name: "我" },
    { id: "p-other", name: "对手" },
  ];
  /** 手动控制成败的发送：每次调用返回一个可由测试决定结果的 promise。 */
  function controllableSend() {
    const calls: { text: string; resolve: () => void; reject: (error: Error) => void }[] = [];
    const send = vi.fn(
      (text: string) =>
        new Promise<void>((resolve, reject) => {
          calls.push({ text, resolve, reject: (error) => reject(error) });
        })
    );
    return { send, calls };
  }
  const type = (input: HTMLElement, value: string) =>
    fireEvent.change(input, { target: { value } });

  it("减弱动效下，前一条失败回写不覆盖玩家已经打出的新草稿", async () => {
    stubMatchMedia(true);
    try {
      const { send, calls } = controllableSend();
      render(<ChatPanel messages={[]} players={players} myPlayerId="p-me" onSendMessage={send} />);
      const input = screen.getByRole("combobox", { name: "聊天消息" });
      type(input, "第一条");
      fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
      type(input, "第二条打到一半");
      calls[0].reject(new Error("断线"));
      await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(input).toHaveValue("第二条打到一半");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("减弱动效下，输入框是空的才把失败的原文放回去", async () => {
    stubMatchMedia(true);
    try {
      const { send, calls } = controllableSend();
      render(<ChatPanel messages={[]} players={players} myPlayerId="p-me" onSendMessage={send} />);
      const input = screen.getByRole("combobox", { name: "聊天消息" });
      type(input, "第一条");
      fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
      calls[0].reject(new Error("断线"));
      await waitFor(() => expect(input).toHaveValue("第一条"));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("两条都在途时，前一条失败不收回后一条的胶囊，原文直接回到空输入框", async () => {
    const { send, calls } = controllableSend();
    render(<ChatPanel messages={[]} players={players} myPlayerId="p-me" onSendMessage={send} />);
    const input = screen.getByRole("combobox", { name: "聊天消息" });
    type(input, "甲");
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    type(input, "乙");
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    expect(send).toHaveBeenCalledTimes(2);
    calls[0].reject(new Error("断线"));
    // 甲没有胶囊可收：当场回到输入框；乙的胶囊仍悬停在途，没被借去播收回动画
    await waitFor(() => expect(input).toHaveValue("甲"), { timeout: 150 });
    expect(screen.getByText("乙").closest("[aria-hidden='true']")).not.toBeNull();
    calls[1].resolve();
  });
});
