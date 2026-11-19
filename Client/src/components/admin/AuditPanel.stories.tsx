import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen } from "storybook/test";
import { dropFocus } from "@/stories/PlayHelpers";
import { adminPanelFrame, installAdmin } from "@/stories/fixtures/Admin";
import { AuditPanel } from "./AuditPanel";

/** 审计日志：按操作筛选、每页 30 条，对象列悬停看全文，详情平铺参数。 */
const meta = {
  title: "Admin/AuditPanel",
  component: AuditPanel,
  tags: ["overlay"],
  decorators: [adminPanelFrame],
} satisfies Meta<typeof AuditPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithData: Story = {
  name: "有数据",
  beforeEach: () => installAdmin(),
  play: async () => {
    await screen.findByText("1–30 / 95");
  },
};

export const LastPage: Story = {
  name: "末页",
  beforeEach: () => installAdmin(),
  play: async ({ userEvent }) => {
    for (const range of ["31–60 / 95", "61–90 / 95", "91–95 / 95"]) {
      await userEvent.click(await screen.findByRole("button", { name: "下一页" }));
      await screen.findByText(range);
    }
    dropFocus();
  },
};

export const Empty: Story = {
  name: "没有记录",
  beforeEach: () => installAdmin({ "admin/audit/list": { items: [], total: 0 } }),
  play: async () => {
    await screen.findByText("没有审计记录");
  },
};

export const Loading: Story = {
  name: "加载中",
  beforeEach: () => installAdmin({ "admin/audit/list": "pending" }),
};

export const Failed: Story = {
  name: "读取失败",
  beforeEach: () => installAdmin({ "admin/audit/list": "error" }),
  play: async () => {
    await screen.findByText("审计日志加载失败");
  },
};
