import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen } from "storybook/test";
import { IDLE_SEARCH_MS } from "@/hooks/UseIdleSearch";
import { dropFocus } from "@/stories/PlayHelpers";
import { ADMIN_USERS, adminPanelFrame, installAdmin } from "@/stories/fixtures/Admin";
import { UsersPanel } from "./UsersPanel";

/** 用户列表：搜索、角色与状态筛选、分页；点名字打开用户详情（详情各态见 UserDetailDialog）。 */
const meta = {
  title: "Admin/UsersPanel",
  component: UsersPanel,
  tags: ["overlay"],
  decorators: [adminPanelFrame],
} satisfies Meta<typeof UsersPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

const ready = () => screen.findByText(ADMIN_USERS[1].name);

export const WithData: Story = {
  name: "有数据",
  beforeEach: () => installAdmin(),
  play: async () => {
    await ready();
  },
};

export const LastPage: Story = {
  name: "末页",
  beforeEach: () => installAdmin(),
  play: async ({ userEvent }) => {
    await ready();
    // 搜索框的停输计时在挂载时也会跑一次并把页码归零，等它过去再翻页。
    await new Promise((resolve) => setTimeout(resolve, IDLE_SEARCH_MS + 100));
    await userEvent.click(screen.getByRole("button", { name: "下一页" }));
    await screen.findByText("21–40 / 57");
    await userEvent.click(screen.getByRole("button", { name: "下一页" }));
    await screen.findByText("41–57 / 57");
    dropFocus();
  },
};

/** 搜索框已填、没有匹配：空态与筛选值同时可见。 */
export const NoMatch: Story = {
  name: "搜索无结果",
  beforeEach: () => installAdmin({ "admin/users/list": { items: [], total: 0 } }),
  play: async ({ userEvent }) => {
    await userEvent.type(await screen.findByLabelText("搜索"), "不存在的昵称");
    await screen.findByText("没有符合条件的用户");
    dropFocus();
  },
};

export const Loading: Story = {
  name: "加载中",
  beforeEach: () => installAdmin({ "admin/users/list": "pending" }),
};

export const Failed: Story = {
  name: "读取失败",
  beforeEach: () => installAdmin({ "admin/users/list": "error" }),
  play: async () => {
    await screen.findByText("用户列表加载失败");
  },
};
