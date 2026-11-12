import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen, within } from "storybook/test";
import { dropFocus } from "@/stories/PlayHelpers";
import { ADMIN_ROOMS, adminPanelFrame, installAdmin } from "@/stories/fixtures/Admin";
import { RoomsPanel } from "./RoomsPanel";

/** 实时房间：房间卡、玩家胶囊与关房、移人的二次确认。 */
const meta = {
  title: "Admin/RoomsPanel",
  component: RoomsPanel,
  tags: ["overlay"],
  decorators: [adminPanelFrame],
} satisfies Meta<typeof RoomsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithData: Story = {
  name: "有数据",
  beforeEach: () => installAdmin(),
  play: async () => {
    await screen.findByText(ADMIN_ROOMS[1].name);
  },
};

export const Empty: Story = {
  name: "没有房间",
  beforeEach: () => installAdmin({ "admin/rooms/list": [] }),
  play: async () => {
    await screen.findByText("当前没有房间");
  },
};

export const Loading: Story = {
  name: "加载中",
  beforeEach: () => installAdmin({ "admin/rooms/list": "pending" }),
};

export const Failed: Story = {
  name: "读取失败",
  beforeEach: () => installAdmin({ "admin/rooms/list": "error" }),
  play: async () => {
    await screen.findByText("房间列表加载失败");
  },
};

export const ConfirmClose: Story = {
  name: "关闭房间确认",
  beforeEach: () => installAdmin(),
  play: async ({ userEvent }) => {
    await screen.findByText(ADMIN_ROOMS[1].name);
    await userEvent.click(screen.getAllByRole("button", { name: "关闭房间" })[0]);
    await screen.findByRole("dialog");
    dropFocus();
  },
};

/** 移人确认后请求一直不回：确认钮转圈、取消禁用。 */
export const KickRunning: Story = {
  name: "移出玩家 · 执行中",
  beforeEach: () => installAdmin({ "admin/rooms/kick": "pending" }),
  play: async ({ userEvent }) => {
    await screen.findByText(ADMIN_ROOMS[1].name);
    await userEvent.click(screen.getByRole("button", { name: `移出 ${ADMIN_ROOMS[0].players[1].name}` }));
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.click(dialog.getByRole("button", { name: "移出" }));
    dropFocus();
  },
};

export const ConfirmFailed: Story = {
  name: "关闭房间 · 失败",
  beforeEach: () => installAdmin({ "admin/rooms/close": "error" }),
  play: async ({ userEvent }) => {
    await screen.findByText(ADMIN_ROOMS[1].name);
    await userEvent.click(screen.getAllByRole("button", { name: "关闭房间" })[1]);
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.click(dialog.getByRole("button", { name: "关闭房间" }));
    await dialog.findByRole("alert");
    dropFocus();
  },
};
