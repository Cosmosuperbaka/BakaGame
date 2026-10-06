import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, screen, userEvent, within } from "storybook/test";
import { dropFocus } from "@/stories/PlayHelpers";
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

// 取景为房间页顶栏右侧：顶栏高 h-14，控件右对齐；手机宽度下收窄到视口内。
const meta = {
  title: "猜歌/VolumeControl",
  component: VolumeControl,
  args: { volume: 0.65, onVolumeChange: fn() },
  render: (args) => <StatefulVolume {...args} />,
  decorators: [(Story) => <div className="flex h-14 w-full max-w-[28rem] items-center justify-end bg-background px-4"><Story /></div>],
} satisfies Meta<typeof VolumeControl>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { name: "默认音量" };

export const Muted: Story = { name: "静音", args: { volume: 0 } };

export const Max: Story = { name: "最大音量", args: { volume: 1 } };

/** 悬停时轨道变粗、滑块显出；截图停在悬停态，便于对照细轨与粗轨。 */
export const Hovered: Story = {
  name: "悬停 · 轨道变粗",
  play: async ({ canvasElement }) => {
    await userEvent.hover(within(canvasElement).getByRole("slider", { name: "播放音量" }));
  },
};

/** 点图标静音，读数滚到 0、图标换成静音。 */
export const MuteToggle: Story = {
  name: "点图标静音",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "静音" }));
    await expect(canvas.getByRole("button", { name: "取消静音" })).toHaveAttribute("aria-pressed", "true");
    dropFocus();
  },
};

/** `sm` 以下只剩图标按钮，点开后在按钮下方弹出滑块。 */
export const MobilePopover: Story = {
  name: "移动端 · 弹出滑块",
  tags: ["overlay", "mobile"],
  globals: { viewport: { value: "mobile", isRotated: false } },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "调节音量" }));
    const panel = await screen.findByRole("dialog", { name: "播放音量" });
    await expect(within(panel).getByRole("slider", { name: "播放音量" })).toBeVisible();
    dropFocus();
  },
};
