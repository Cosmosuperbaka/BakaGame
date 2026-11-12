import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen } from "storybook/test";
import { ADMIN_OVERVIEW, ADMIN_SENTRY_OFF, adminPanelFrame, installAdmin } from "@/stories/fixtures/Admin";
import { OverviewPanel } from "./OverviewPanel";

/** 后台概览：数字卡、待复核条、每日数据、板块浏览与 Sentry 卡片，接口由共享夹具桩住。 */
const meta = {
  title: "Admin/OverviewPanel",
  component: OverviewPanel,
  tags: ["overlay"],
  decorators: [adminPanelFrame],
} satisfies Meta<typeof OverviewPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithData: Story = {
  name: "有数据",
  beforeEach: () => installAdmin(),
  play: async () => {
    await screen.findByRole("table", { name: "接口耗时" });
  },
};

/** 选 30 天：每日表 30 行。 */
export const ThirtyDays: Story = {
  name: "30 天",
  beforeEach: () => installAdmin(),
  play: async ({ userEvent }) => {
    await screen.findByRole("table", { name: "每日数据" });
    await userEvent.click(screen.getByRole("radio", { name: "30 天" }));
    await screen.findByText("12-02");
  },
};

/** Sentry 未配置、所选时段没有浏览记录、待复核为 0。 */
export const Sparse: Story = {
  name: "Sentry 未配置 · 无浏览",
  beforeEach: () =>
    installAdmin({
      "admin/stats/overview": { ...ADMIN_OVERVIEW, daily: ADMIN_OVERVIEW.daily.slice(-3), pages: [] },
      "admin/stats/sentry": ADMIN_SENTRY_OFF,
      "admin/antiCheat/list": { items: [], total: 0 },
    }),
  play: async () => {
    await screen.findByText("所选时段内没有浏览记录");
  },
};

export const Loading: Story = {
  name: "加载中",
  beforeEach: () =>
    installAdmin({
      "admin/stats/overview": "pending",
      "admin/stats/sentry": "pending",
      "admin/antiCheat/list": "pending",
    }),
};

export const Failed: Story = {
  name: "读取失败",
  beforeEach: () =>
    installAdmin({
      "admin/stats/overview": "error",
      "admin/stats/sentry": "error",
      "admin/antiCheat/list": "error",
    }),
  play: async () => {
    await screen.findByText("概览加载失败");
  },
};
