import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { RoomLinkShare } from "./RoomLinkShare";

const meta = {
  title: "公共组件/RoomLinkShare",
  component: RoomLinkShare,
  args: { path: "/songuessr/room/4821", onCopyError: fn() },
  decorators: [
    (Story) => (
      <div className="w-[28rem] rounded-md border bg-panel p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RoomLinkShare>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 三个游戏等待页顶部的房间链接。 */
export const Default: Story = { name: "默认" };

/** 窄容器里地址截断，复制按钮保持原宽，不被挤压。 */
export const Narrow: Story = {
  name: "窄容器 · 地址截断",
  decorators: [
    (Story) => (
      <div className="w-64">
        <Story />
      </div>
    ),
  ],
};
