import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { clearStoredSongMusicSession } from "@/lib/SonGuessrMusicSession";
import { dropFocus } from "@/stories/PlayHelpers";
import { pending, seedMusicSession, SONG_ACCOUNTS, SONG_QR, songSnapshot, stubSongCommand } from "@/stories/fixtures/SonGuessr";
import { SongAccountSettings } from "./SongAccountSettings";

// 折叠态不发请求；只有在未登录时展开才会请求登录二维码，故事里用替身应答。
const meta = {
  title: "猜歌/SongAccountSettings",
  component: SongAccountSettings,
  args: { snapshot: songSnapshot({ musicAccountReady: false }) },
  beforeEach: () => clearStoredSongMusicSession(),
  decorators: [(Story) => <div className="w-[28rem] rounded-md bg-panel p-6"><Story /></div>],
} satisfies Meta<typeof SongAccountSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

const expand = async (canvasElement: HTMLElement) => {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: /网易云账号/ }));
  return canvas;
};

/** 二维码创建成功；轮询保持未返回，状态文案停在“请扫码”。 */
const qrWaiting = (type: string) => (type === "song.auth.qr.create" ? Promise.resolve(SONG_QR) : pending());

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

export const SoloConnected: Story = {
  name: "单人模式 · 已登录",
  args: { snapshot: songSnapshot({ solo: true }) },
  beforeEach: () => seedMusicSession(SONG_ACCOUNTS.vip),
};

export const VipExpanded: Story = {
  name: "展开 · 会员账号",
  args: { snapshot: songSnapshot() },
  beforeEach: () => seedMusicSession(SONG_ACCOUNTS.vip),
  play: async ({ canvasElement }) => {
    const canvas = await expand(canvasElement);
    // 昵称与会员信息在收起单行里也有一份，等展开卡独有的“退出登录”按钮出现再截图。
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
    // “会员状态未知”在收起单行里也已出现，等展开卡独有的“退出登录”按钮出现再截图。
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
  beforeEach: () => stubSongCommand(() => Promise.reject({ code: "MUSIC_LOGIN_FAILED", message: "无法生成登录二维码" })),
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
