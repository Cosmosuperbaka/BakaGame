import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Volume2 } from "lucide-react";
import { Slider } from "./Slider";

const meta = {
  title: "基础控件/Slider",
  component: Slider,
} satisfies Meta<typeof Slider>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 滑块本身不显示数值，这里并排给出百分比，拖动时同步变化。 */
function VolumeRow({ initial, disabled = false }: { initial: number; disabled?: boolean }) {
  const [volume, setVolume] = useState(initial);
  return (
    <div className="flex items-center gap-3">
      <Volume2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <Slider
        value={[volume]}
        min={0}
        max={1}
        step={0.01}
        disabled={disabled}
        onValueChange={([value]) => setVolume(value)}
        aria-label="播放音量"
      />
      <span className="min-w-10 text-right text-sm font-semibold tabular-nums">{Math.round(volume * 100)}%</span>
    </div>
  );
}

export const Values: Story = {
  name: "取值",
  render: () => (
    <div className="w-72 space-y-4">
      <VolumeRow initial={0} />
      <VolumeRow initial={0.64} />
      <VolumeRow initial={1} />
    </div>
  ),
};

export const Disabled: Story = {
  name: "禁用",
  render: () => (
    <div className="w-72">
      <VolumeRow initial={0.4} disabled />
    </div>
  ),
};
