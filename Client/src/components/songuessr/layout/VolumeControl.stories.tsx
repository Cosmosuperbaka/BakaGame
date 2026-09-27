import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { VolumeControl } from "./VolumeControl";

/** 故事内自持音量，拖动滑块能看到百分比随之变化。 */
function StatefulVolume({ volume: initial, onVolumeChange }: { volume: number; onVolumeChange: (value: number) => void }) {
  const [volume, setVolume] = useState(initial);
  return (
    <VolumeControl
      volume={volume}
      onVolumeChange={(value) => {
        setVolume(value);
        onVolumeChange(value);
      }}
    />
  );
}

// 取景为房间页顶栏右侧：顶栏高 h-14，控件右对齐。
const meta = {
  title: "猜歌/VolumeControl",
  component: VolumeControl,
  args: { volume: 0.65, onVolumeChange: fn() },
  render: (args) => <StatefulVolume {...args} />,
  decorators: [(Story) => <div className="flex h-14 w-[28rem] items-center justify-end bg-background px-4"><Story /></div>],
} satisfies Meta<typeof VolumeControl>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { name: "默认音量" };

export const Muted: Story = { name: "静音", args: { volume: 0 } };

export const Max: Story = { name: "最大音量", args: { volume: 1 } };
