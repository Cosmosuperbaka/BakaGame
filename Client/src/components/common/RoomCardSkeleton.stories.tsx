import type { Meta, StoryObj } from "@storybook/react-vite";
import { RoomCardSkeleton } from "./RoomCardSkeleton";

const meta = {
  title: "公共组件/RoomCardSkeleton",
  component: RoomCardSkeleton,
  args: { count: 3 },
} satisfies Meta<typeof RoomCardSkeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  name: "加载中",
  render: (args) => (
    <div className="w-[46rem]">
      <RoomCardSkeleton {...args} />
    </div>
  ),
};

/** 窄屏下卡片改为上下两段，右侧信息换到分隔线下方。 */
export const LoadingMobile: Story = {
  name: "加载中 · 手机",
  tags: ["page", "mobile"],
  parameters: { layout: "fullscreen" },
  render: (args) => (
    <div className="h-full bg-background px-4 py-6">
      <RoomCardSkeleton {...args} />
    </div>
  ),
};
