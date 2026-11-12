import type { Meta, StoryObj } from "@storybook/react-vite";
import { STORY_PROFILE, presetAccount } from "@/stories/fixtures/Account";
import AdminPage from "./AdminPage";

/**
 * 管理后台外壳：顶栏与按账号状态切换的门禁。进入后台后的各面板接后台接口，
 * 由「Admin/」下的零件与面板故事分别覆盖；这里只截门禁与外壳。
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
