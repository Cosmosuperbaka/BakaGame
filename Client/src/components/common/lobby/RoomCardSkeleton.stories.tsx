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

/** 窄屏下卡片分三行：房名；房号与人数；分隔线下的阶段与观战。 */
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
