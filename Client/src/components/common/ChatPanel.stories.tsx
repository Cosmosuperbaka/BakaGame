import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { fireEvent, fn } from "storybook/test";
import { loadStickerPacks } from "@/lib/Stickers";
import { STORY_EPOCH, STORY_PLAYERS, STORY_SPECTATORS, storyChat } from "@/stories/fixtures/Common";
import type { ChatMessage } from "@/types";
import { ChatPanel } from "./ChatPanel";

const [host, me, peach, azumi, kanade, kitagawa, longName] = STORY_PLAYERS;
const [spectator] = STORY_SPECTATORS;
const ROOM_MEMBERS = [...STORY_PLAYERS, ...STORY_SPECTATORS];

const meta = {
  title: "公共组件/ChatPanel",
  component: ChatPanel,
  args: {
    messages: [],
    players: [...STORY_PLAYERS],
    myPlayerId: me.id,
    onSendMessage: fn(),
  },
  // 与房间页右栏一致：固定宽度的面板，聊天区撑满高度。
  decorators: [
    (Story) => (
      <div className="flex h-[36rem] w-80 flex-col overflow-hidden rounded-md border bg-panel">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ChatPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

let sequence = 0;

/** 本文件的定制对话，与 storyChat 共用时间原点，保证每次截图一致。 */
function say(
  player: { id: string; name: string },
  text: string,
  offsetSeconds: number,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  sequence += 1;
  return {
    id: `chat-panel-${sequence}`,
    playerId: player.id,
    playerName: player.name,
    text,
    createdAt: STORY_EPOCH + offsetSeconds * 1000,
    system: false,
    ...extra,
  };
}

const notice = (text: string, offsetSeconds: number) =>
  say({ id: "system", name: "系统" }, text, offsetSeconds, { system: true });

const ghost = (
  player: { id: string; name: string },
  text: string,
  offsetSeconds: number,
  ghostRole: "dead" | "spectator",
) => say(player, text, offsetSeconds, { channel: "ghost", ghostRole });

// 旁观者视角：出局玩家与旁观者的发言只在观战频道可见，以虚线气泡区分。
const GHOST_CHAT: ChatMessage[] = [
  notice("第 2 天描述阶段", 0),
  say(peach, "阿澄这轮说得有点虚，先记一下", 12),
  ghost(kitagawa, "我第一轮就被投出去了，冤死", 20, "dead"),
  ghost(spectator, "别急，看他们这轮怎么说", 28, "spectator"),
  say(kanade, "我的描述没问题吧，别盯着我了", 36),
  ghost(kitagawa, `@${spectator.name} 你猜卧底是谁`, 44, "dead"),
  ghost(spectator, "我觉得是 Kanade，一直在绕圈子", 52, "spectator"),
  notice("第 2 天投票阶段", 64),
];

const LONG_CHAT: ChatMessage[] = [
  notice(`${host.name} 断线超时，房主已转移给 ${me.name}`, 0),
  say(azumi, "拉朋友一起来：https://game.baka.website/whoisfaker/room/4821", 10),
  say(peach, "6666666666666666666666666666666666666666666666666666666666666666666666", 22),
  say(me, "Kanade 第一轮说能拿在手里，第二轮又说要放在桌上用，两句放在一起很奇怪，我这轮先投 Kanade", 34),
  say(
    longName,
    "我也把前两轮的描述都过了一遍：第一轮大家都在说颜色和形状，第二轮开始有人突然改口说用途，前后对不上。卧底应该就在改口的两个人里面，投票前大家先各自说一下理由吧",
    46,
  ),
];

export const Empty: Story = { name: "空消息" };

/** 发送后由本地回显：服务端回包大约晚一拍到达，这里同样延后一点放进列表，回放完整的「胶囊掷出 → 回显接手落位」。 */
function EchoChat(props: React.ComponentProps<typeof ChatPanel>) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => [...props.messages]);
  return (
    <ChatPanel
      {...props}
      messages={messages}
      onSendMessage={async (text) => {
        await props.onSendMessage(text);
        await new Promise((resolve) => setTimeout(resolve, 80));
        setMessages((current) => [...current, say(me, text, 600 + current.length)]);
      }}
    />
  );
}

export const SendFlight: Story = {
  name: "发送动画",
  args: { messages: [say(peach, "说两句试试", 1), say(azumi, "我先来", 2)] },
  render: (args) => <EchoChat {...args} />,
};

export const Mentioned: Story = {
  name: "对话 · 被提及",
  // 以房主视角查看：海豹的「@小布丁」提及了本人，气泡带描边高亮。
  args: { messages: storyChat(), myPlayerId: host.id },
};

export const Sticker: Story = {
  name: "表情消息",
  loaders: [
    async () => {
      const [pack] = await loadStickerPacks();
      return { messages: storyChat(me.id, pack?.items[0]?.path) };
    },
  ],
  render: (args, { loaded }) => (
    <ChatPanel {...args} messages={(loaded as { messages: ChatMessage[] }).messages} />
  ),
};

export const GhostChannel: Story = {
  name: "观战频道",
  args: { messages: GHOST_CHAT, players: ROOM_MEMBERS, myPlayerId: spectator.id },
};

export const LongText: Story = {
  name: "超长文本",
  args: { messages: LONG_CHAT },
};

export const ChannelNotice: Story = {
  name: "频道说明",
  // CCB 原版房：聊天只在增强版玩家之间互通，说明固定为消息流第一行，与系统提示同样式。
  args: {
    notice: "聊天仅增强版玩家可见",
    messages: [say(kitagawa, "原版那边好像断了一下", 20), say(me, "等它重连上再开下一局", 28)],
  },
};

export const PickerOpen: Story = {
  name: "表情面板展开",
  args: { messages: storyChat() },
  play: async ({ canvas }) => {
    // 只派发 click：打开面板靠 onClick，脚本聚焦会在按钮上留下键盘焦点环。
    fireEvent.click(canvas.getByRole("button", { name: "发送表情" }));
    await canvas.findByRole("tablist", { name: "表情包分类" }, { timeout: 10_000 });
  },
};

export const MentionCandidates: Story = {
  name: "提及候选",
  args: { messages: storyChat() },
  play: async ({ canvas, userEvent }) => {
    await userEvent.type(canvas.getByPlaceholderText("请输入文本"), "@");
    await canvas.findByRole("listbox", { name: "提及玩家" });
  },
};
