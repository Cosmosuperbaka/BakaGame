import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen } from "storybook/test";
import { STORY_PROFILE, presetAccount } from "@/stories/fixtures/Account";
import { installAdmin } from "@/stories/fixtures/Admin";
import AdminPage from "./AdminPage";

/**
 * 管理后台外壳：顶栏与按账号状态切换的门禁，以及管理员进入后的标签栏。各面板的
 * 各种状态由「Admin/」下的面板故事分别覆盖，接口桩在 `stories/fixtures/Admin.ts`。
 */
const meta = {
  title: "页面/管理后台",
  component: AdminPage,
  tags: ["page"],
  parameters: { layout: "fullscreen", router: { route: "/admin" } },
} satisfies Meta<typeof AdminPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  name: "读取账号中",
  beforeEach: () => presetAccount({ status: "loading" }),
};

export const Guest: Story = {
  name: "请先登录",
  beforeEach: () => presetAccount({ status: "guest" }),
};

export const Forbidden: Story = {
  name: "没有访问权限",
  beforeEach: () => presetAccount({ status: "signedIn", profile: STORY_PROFILE }),
};

export const Unavailable: Story = {
  name: "账号系统未启用",
  beforeEach: () => presetAccount({ status: "unavailable" }),
};

/** 管理员进入后台，默认落在概览；手机宽度下 11 个标签横向滚动。 */
export const AdminOverview: Story = {
  name: "管理员 · 概览",
  beforeEach: () => installAdmin(),
  play: async () => {
    await screen.findByRole("table", { name: "每日数据" });
  },
};

/** 直链到靠后的标签（审计）：手机宽度下当前标签应在可见范围内。 */
export const AdminLaterTab: Story = {
  name: "管理员 · 靠后的标签",
  parameters: { router: { route: "/admin?tab=audit", path: "/admin" } },
  beforeEach: () => installAdmin(),
  play: async () => {
    await screen.findByText("1–30 / 95");
  },
};
