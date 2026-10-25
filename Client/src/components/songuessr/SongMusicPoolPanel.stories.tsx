import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import type { SonGuessrMusicPoolView } from "@bakagame/shared";
import { STORY_EPOCH, placeholderImage } from "@/stories/fixtures/Common";
import { dropFocus } from "@/stories/PlayHelpers";
import { SONG_ACCOUNTS, SONG_PEOPLE, songSnapshot } from "@/stories/fixtures/SonGuessr";
import { SongMusicPoolPanel } from "./SongMusicPoolPanel";

const { host, me, peach, azumi } = SONG_PEOPLE;

// 两个平台各两个号：会员、非会员、状态未知与冷却中的号都占一条，检查平台分组与徽章回退。
const POOL: SonGuessrMusicPoolView[] = [
  {
    playerId: host.id,
    playerName: host.name,
    platform: "qq",
    account: {
      platform: "qq",
      userId: "20001",
      nickname: "夜航绿钻",
      avatarUrl: placeholderImage("绿", 150, 80, 80),
      vipStatus: "vip",
      vipTier: "svip",
      vipLevel: 8,
      vipYear: true,
    },
    enabled: true,
    inFlight: 1,
    recentOk: 12,
    recentTotal: 13,
  },
  {
    playerId: me.id,
    playerName: me.name,
    platform: "qq",
    account: { platform: "qq", userId: "20002", nickname: "白噪音收藏家", vipStatus: "nonVip" },
    enabled: false,
    cooldownUntil: STORY_EPOCH + 86_400_000,
    inFlight: 0,
    recentOk: 0,
    recentTotal: 0,
    lastFailureReason: "上游请求超时",
  },
  {
    playerId: peach.id,
    playerName: peach.name,
    platform: "netease",
    account: { ...SONG_ACCOUNTS.vip, platform: "netease" },
    enabled: true,
    inFlight: 0,
    recentOk: 7,
    recentTotal: 8,
  },
  {
    playerId: azumi.id,
    playerName: azumi.name,
    platform: "netease",
    account: { ...SONG_ACCOUNTS.unknown, platform: "netease" },
    enabled: true,
    inFlight: 2,
    recentOk: 3,
    recentTotal: 5,
  },
];

const meta = {
  title: "猜歌/SongMusicPoolPanel",
  component: SongMusicPoolPanel,
  args: { snapshot: songSnapshot({ musicPool: POOL }) },
  decorators: [
    (Story) => (
      <div className="w-[28rem] rounded-md bg-panel p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SongMusicPoolPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Collapsed: Story = { name: "收起 · 账号总览" };

export const Expanded: Story = {
  name: "展开 · 按平台分组的账号",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "账号池" }));
    await canvas.findByRole("button", { name: "账号池", expanded: true });
    dropFocus();
  },
};
