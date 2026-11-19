import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "@/components/ui/Button";
import { ReadyProgress } from "./ReadyProgress";

const meta = {
  title: "公共组件/ReadyProgress",
  component: ReadyProgress,
  args: { ready: 2, total: 3, variant: "host" },
  decorators: [
    (Story) => (
      <div className="w-[28rem] rounded-md border bg-panel p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ReadyProgress>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 无人准备、部分准备与全员准备。 */
const STEPS = [0, 2, 3] as const;

/** 房主看到带标题的整宽进度条。 */
export const Host: Story = {
  name: "房主视角",
  render: () => (
    <div className="space-y-5">
      {STEPS.map((ready) => (
        <ReadyProgress key={ready} ready={ready} total={3} variant="host" />
      ))}
    </div>
  ),
};

/** 其他玩家看到居中的一句摘要与短进度条。 */
export const Guest: Story = {
  name: "玩家视角",
  render: () => (
    <div className="space-y-5">
      {STEPS.map((ready) => (
        <ReadyProgress key={ready} ready={ready} total={3} variant="guest" />
      ))}
    </div>
  ),
};

/** 准备人数变化：进度条伸缩到新比例、人数滚到新值（核对补间与圆角端头）。 */
export const Changing: Story = {
  name: "人数变化",
  tags: ["no-shot"],
  render: function Render() {
    const [ready, setReady] = useState(1);
    return (
      <div className="space-y-4">
        <ReadyProgress ready={ready} total={3} variant="host" />
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setReady((value) => Math.min(3, value + 1))}
          >
            有人准备
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setReady((value) => Math.max(0, value - 1))}
          >
            有人取消
          </Button>
        </div>
      </div>
    );
  },
};
