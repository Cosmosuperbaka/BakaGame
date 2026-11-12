import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen } from "storybook/test";
import { dropFocus } from "@/stories/PlayHelpers";
import { QQ_DOWN, adminPanelFrame, installAdmin } from "@/stories/fixtures/Admin";
import { QQLookupPanel } from "./QQLookupPanel";

/** QQ 昵称来源：查询号在线状态、批量刷新昵称与结果说明。 */
const meta = {
  title: "Admin/QQLookupPanel",
  component: QQLookupPanel,
  tags: ["overlay"],
  decorators: [adminPanelFrame],
} satisfies Meta<typeof QQLookupPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Active: Story = {
  name: "可用",
  beforeEach: () => installAdmin(),
  play: async () => {
    await screen.findByText("可用");
  },
};

export const Unavailable: Story = {
  name: "不可用",
  beforeEach: () => installAdmin({ "admin/qq/status": QQ_DOWN }),
  play: async () => {
    await screen.findByText("不可用");
  },
};

export const Refreshed: Story = {
  name: "刷新完成",
  beforeEach: () => installAdmin(),
  play: async ({ userEvent }) => {
    await userEvent.click(await screen.findByRole("button", { name: "刷新全部昵称" }));
    await screen.findByRole("status");
    dropFocus();
  },
};

export const Refreshing: Story = {
  name: "刷新中",
  beforeEach: () => installAdmin({ "admin/qq/refreshNames": "pending" }),
  play: async ({ userEvent }) => {
    await userEvent.click(await screen.findByRole("button", { name: "刷新全部昵称" }));
    dropFocus();
  },
};

export const RefreshFailed: Story = {
  name: "刷新失败",
  beforeEach: () => installAdmin({ "admin/qq/refreshNames": "error" }),
  play: async ({ userEvent }) => {
    await userEvent.click(await screen.findByRole("button", { name: "刷新全部昵称" }));
    await screen.findByRole("alert");
    dropFocus();
  },
};

export const Loading: Story = {
  name: "加载中",
  beforeEach: () => installAdmin({ "admin/qq/status": "pending" }),
};

export const Failed: Story = {
  name: "读取失败",
  beforeEach: () => installAdmin({ "admin/qq/status": "error" }),
  play: async () => {
    await screen.findByText("查询号状态加载失败");
  },
};
