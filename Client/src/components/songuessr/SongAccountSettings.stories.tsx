import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SonGuessrMusicPoolView } from "@bakagame/shared";
import { STORY_EPOCH } from "@/stories/fixtures/Common";
import { userEvent, within } from "storybook/test";
import { clearStoredSongMusicSession } from "@/lib/SonGuessrMusicSession";
import { dropFocus } from "@/stories/PlayHelpers";
import {
  pending,
  seedMusicSession,
  seedOwnMusicAccounts,
  SONG_ACCOUNTS,
  SONG_PEOPLE,
  SONG_QR,
  songSnapshot,
  stubSongCommand,
} from "@/stories/fixtures/SonGuessr";
import { SongAccountSettings } from "./SongAccountSettings";
import { rejectedProtocol } from "@/lib/ProtocolFailure";

// 折叠态不发请求；只有在未登录时展开才会请求登录二维码，故事里用替身应答。
const meta = {
  title: "猜歌/SongAccountSettings",
  component: SongAccountSettings,
  args: { snapshot: songSnapshot({ musicAccountReady: false }) },
  beforeEach: () => clearStoredSongMusicSession(),
  decorators: [
    (Story) => (
      <div className="w-[28rem] rounded-md bg-panel p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SongAccountSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

const expand = async (canvasElement: HTMLElement) => {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: /音乐账号配置/ }));
  return canvas;
};

/** 二维码创建成功；轮询保持未返回，状态文案停在“请扫码”。 */
const qrWaiting = (type: string) =>
  type === "song.auth.qr.create" ? Promise.resolve(SONG_QR) : pending();

export const LoggedOut: Story = { name: "未登录" };

export const LocalOnly: Story = {
  name: "正在连接（本机有凭据，未加载到房间）",
  beforeEach: () => seedMusicSession(SONG_ACCOUNTS.vip),
};

export const RoomConnected: Story = {
  name: "已登录 · 收起",
  args: { snapshot: songSnapshot() },
  beforeEach: () => seedMusicSession(SONG_ACCOUNTS.vip),
};

// 原「单人模式 · 已登录」与「已登录 · 收起」逐像素相同：组件没有单人专属分支，那条故事不呈现任何新状态，
// 换成账号池（B4）带来的几种真实状态——共享开关、开局后锁定、被服务端暂停后重新登录、QQ 扫码方式。
const poolMe = songSnapshot().players.find((player) => player.id === SONG_PEOPLE.me.id);
const myPoolEntry = (overrides: Partial<SonGuessrMusicPoolView> = {}): SonGuessrMusicPoolView => ({
  playerId: SONG_PEOPLE.me.id,
  playerName: SONG_PEOPLE.me.name,
  platform: "netease",
  account: { ...SONG_ACCOUNTS.vip, platform: "netease" },
  enabled: true,
  inFlight: 0,
  recentOk: 4,
  recentTotal: 4,
  ...overrides,
});
const expandUntilLogout = async (canvasElement: HTMLElement) => {
  const canvas = await expand(canvasElement);
  await canvas.findByRole("button", { name: "退出登录" });
  dropFocus();
};

export const PoolSharing: Story = {
  name: "账号池 · 共享开关",
  args: { snapshot: songSnapshot({ musicPool: [myPoolEntry()] }), me: poolMe },
  beforeEach: () => seedOwnMusicAccounts({ netease: SONG_ACCOUNTS.vip }),
  play: async ({ canvasElement }) => expandUntilLogout(canvasElement),
};

export const PoolLocked: Story = {
  name: "账号池 · 开局后锁定共享",
  args: { snapshot: songSnapshot({ phase: "playing", musicPool: [myPoolEntry()] }), me: poolMe },
  beforeEach: () => seedOwnMusicAccounts({ netease: SONG_ACCOUNTS.vip }),
  play: async ({ canvasElement }) => expandUntilLogout(canvasElement),
};

export const PoolPaused: Story = {
  name: "账号池 · 凭据失效需重新登录",
  args: {
    snapshot: songSnapshot({
      musicPool: [
        myPoolEntry({
          enabled: false,
          cooldownUntil: STORY_EPOCH + 86_400_000,
          lastFailureReason: "网易云登录状态已失效",
        }),
      ],
    }),
    me: poolMe,
  },
  beforeEach: () => seedOwnMusicAccounts({ netease: SONG_ACCOUNTS.vip }),
  play: async ({ canvasElement }) => {
    const canvas = await expand(canvasElement);
    await canvas.findByRole("button", { name: "重新登录" });
    dropFocus();
  },
};

export const QqScanTypes: Story = {
  name: "扫码登录 · QQ 音乐选择扫码方式",
  beforeEach: () => stubSongCommand(qrWaiting),
  play: async ({ canvasElement }) => {
    const canvas = await expand(canvasElement);
    await userEvent.click(canvas.getByRole("radio", { name: /QQ音乐/ }));
    await canvas.findByAltText("QQ音乐登录二维码");
    dropFocus();
  },
};

export const VipExpanded: Story = {
  name: "展开 · 会员账号",
  args: { snapshot: songSnapshot() },
  beforeEach: () => seedMusicSession(SONG_ACCOUNTS.vip),
  play: async ({ canvasElement }) => {
    const canvas = await expand(canvasElement);
    // 展开后标题行换回普通标题（账号行随之撤走），等展开卡独有的“退出登录”按钮出现再截图。
    await canvas.findByRole("button", { name: "退出登录" });
    dropFocus();
  },
};

export const NonVipExpanded: Story = {
  name: "展开 · 非会员账号",
  args: { snapshot: songSnapshot() },
  beforeEach: () => seedMusicSession(SONG_ACCOUNTS.nonVip),
  play: async ({ canvasElement }) => {
    const canvas = await expand(canvasElement);
    await canvas.findByText("非会员账号也能出题，会员专享歌曲会自动匹配可用音源。");
    dropFocus();
  },
};

export const UnknownVipExpanded: Story = {
  name: "展开 · 会员状态未知",
  args: { snapshot: songSnapshot() },
  beforeEach: () => seedMusicSession(SONG_ACCOUNTS.unknown),
  play: async ({ canvasElement }) => {
    const canvas = await expand(canvasElement);
    // “会员状态未知”只在展开卡里有（标题行已换回普通标题），等它出现再截图。
    await canvas.findByRole("button", { name: "退出登录" });
    dropFocus();
  },
};

export const QrWaiting: Story = {
  name: "扫码登录 · 等待扫码",
  beforeEach: () => stubSongCommand(qrWaiting),
  play: async ({ canvasElement }) => {
    const canvas = await expand(canvasElement);
    await canvas.findByAltText("网易云登录二维码");
    dropFocus();
  },
};

export const QrCreating: Story = {
  name: "扫码登录 · 正在生成二维码",
  beforeEach: () => stubSongCommand(() => pending()),
  play: async ({ canvasElement }) => {
    const canvas = await expand(canvasElement);
    await canvas.findByText("正在准备登录二维码…");
    dropFocus();
  },
};

export const QrFailed: Story = {
  name: "扫码登录 · 二维码生成失败",
  beforeEach: () =>
    stubSongCommand(() =>
      rejectedProtocol({ code: "MUSIC_LOGIN_FAILED", message: "无法生成登录二维码" })
    ),
  play: async ({ canvasElement }) => {
    const canvas = await expand(canvasElement);
    await canvas.findByText("无法生成登录二维码");
    dropFocus();
  },
};

export const Logout: Story = {
  name: "退出登录后重新扫码",
  args: { snapshot: songSnapshot() },
  beforeEach: () => {
    stubSongCommand((type) => (type === "song.auth.clear" ? Promise.resolve({}) : qrWaiting(type)));
    return seedMusicSession(SONG_ACCOUNTS.vip);
  },
  play: async ({ canvasElement }) => {
    const canvas = await expand(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "退出登录" }));
    await canvas.findByAltText("网易云登录二维码");
    dropFocus();
  },
};
