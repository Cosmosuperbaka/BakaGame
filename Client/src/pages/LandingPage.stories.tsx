import type { Meta, StoryObj } from "@storybook/react-vite";
import LandingPage from "./LandingPage";

/**
 * 主页本身不再承载版本信息浮层：页脚的版本号是一个导航入口，
 * 点击后进入完整页面 `/abouts`（更新日志 / 提交历史 / 开源致谢 / 法务子页），
 * 各标签的展示在「页面/版本信息」的故事里单独截图。
 */
const meta = {
  title: "页面/主页",
  component: LandingPage,
  tags: ["page"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof LandingPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { name: "默认" };
