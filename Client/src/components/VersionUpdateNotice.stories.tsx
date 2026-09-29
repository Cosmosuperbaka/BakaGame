import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { VersionUpdateBanner } from "./VersionUpdateNotice";

/** 检测逻辑依赖真实部署的构建号，这里直接渲染展示层。 */
const meta = {
  title: "公共组件/VersionUpdateNotice",
  component: VersionUpdateBanner,
  tags: ["overlay"],
  parameters: { layout: "fullscreen" },
  args: { open: true, onReload: fn() },
} satisfies Meta<typeof VersionUpdateBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Available: Story = { name: "有新版本" };
