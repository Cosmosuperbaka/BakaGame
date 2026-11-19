import type { Meta, StoryObj } from "@storybook/react-vite";
import { RoomRestoreFallback } from "./RoomRestoreFallback";

const meta = {
  title: "公共组件/RoomRestoreFallback",
  component: RoomRestoreFallback,
} satisfies Meta<typeof RoomRestoreFallback>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 等待页套用上次房间设置期间的占位：游戏区里居中一枚主色转圈。 */
export const Restoring: Story = {
  name: "恢复设置中",
  render: () => (
    <div className="w-[36rem] max-w-full rounded-md border bg-panel">
      <RoomRestoreFallback />
    </div>
  ),
};
