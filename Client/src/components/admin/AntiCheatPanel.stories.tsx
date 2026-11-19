import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen, within } from "storybook/test";
import { dropFocus } from "@/stories/PlayHelpers";
import { ADMIN_REVIEWS, adminPanelFrame, installAdmin } from "@/stories/fixtures/Admin";
import { AntiCheatPanel } from "./AntiCheatPanel";

/** 反作弊复核队列：列表、详情（命中依据、特征、同身份近窗记录）与处置按钮。 */
const meta = {
  title: "Admin/AntiCheatPanel",
  component: AntiCheatPanel,
  tags: ["overlay"],
  decorators: [adminPanelFrame],
} satisfies Meta<typeof AntiCheatPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

const first = ADMIN_REVIEWS[0];
const ready = () => screen.findAllByText(first.playerName);

export const WithData: Story = {
  name: "有数据",
  beforeEach: () => installAdmin(),
  play: async () => {
    await ready();
  },
};

export const Empty: Story = {
  name: "没有待复核",
  beforeEach: () => installAdmin({ "admin/antiCheat/list": { items: [], total: 0 } }),
  play: async () => {
    await screen.findByText("没有待复核的条目");
  },
};

export const Loading: Story = {
  name: "加载中",
  beforeEach: () => installAdmin({ "admin/antiCheat/list": "pending" }),
};

export const Failed: Story = {
  name: "读取失败",
  beforeEach: () => installAdmin({ "admin/antiCheat/list": "error" }),
  play: async () => {
    await screen.findByText("复核队列加载失败");
  },
};

const openFirst = async (userEvent: { click: (element: Element) => Promise<void> }) => {
  await userEvent.click((await ready())[0]);
  return within(await screen.findByRole("dialog"));
};

export const Detail: Story = {
  name: "详情",
  beforeEach: () => installAdmin(),
  play: async ({ userEvent }) => {
    const dialog = await openFirst(userEvent);
    await dialog.findByText("窗口内最高分：");
    dropFocus();
  },
};

/** 近窗记录读不到：只影响这一小块，处置按钮照常可用。 */
export const DetailHistoryFailed: Story = {
  name: "详情 · 近窗记录失败",
  beforeEach: () => installAdmin({ "admin/antiCheat/history": "error" }),
  play: async ({ userEvent }) => {
    const dialog = await openFirst(userEvent);
    await dialog.findByText("跨局条目读取失败");
    dropFocus();
  },
};

export const ActionFailed: Story = {
  name: "详情 · 处置失败",
  beforeEach: () => installAdmin({ "admin/antiCheat/setStatus": "error" }),
  play: async ({ userEvent }) => {
    const dialog = await openFirst(userEvent);
    await userEvent.click(await dialog.findByRole("button", { name: "标记放行" }));
    await dialog.findByRole("alert");
    dropFocus();
  },
};
