import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, screen, userEvent, within } from "storybook/test";
import type { SongAudioQualityPreference } from "@bakagame/shared";
import type { SongAudioQualityState } from "@/hooks/UseSongAudioQuality";
import { dropFocus } from "@/stories/PlayHelpers";
import type { AudioQualityControlProps } from "./SongAudioQualityMenu";
import { SongVolumeControl } from "./SongVolumeControl";

/** 故事内自持音量与音质，拖动滑块能看到百分比随之变化，选档后胶囊上的字跟着换。 */
function StatefulVolume({
  volume: initial,
  onVolumeChange,
  audioQuality,
}: {
  volume: number;
  onVolumeChange: (value: number) => void;
  audioQuality?: AudioQualityControlProps;
}) {
  const [volume, setVolume] = useState(initial);
  const [quality, setQuality] = useState(audioQuality?.quality ?? "auto");
  return (
    <SongVolumeControl
      volume={volume}
      onVolumeChange={(value) => {
        setVolume(value);
        onVolumeChange(value);
      }}
      audioQuality={
        audioQuality
          ? {
              ...audioQuality,
              quality,
              onQualityChange: (value) => {
                setQuality(value);
                audioQuality.onQualityChange(value);
              },
            }
          : undefined
      }
    />
  );
}

const withQuality = (
  quality: SongAudioQualityPreference,
  qualityState?: SongAudioQualityState
): AudioQualityControlProps => ({ quality, qualityState, onQualityChange: fn() });

/** 点开胶囊右端的音质选单，等选项出来再截图。 */
const openQualityMenu = async (canvasElement: HTMLElement) => {
  await userEvent.click(within(canvasElement).getByRole("combobox", { name: /^播放音质/ }));
  await screen.findByRole("listbox");
};

// 取景为房间页顶栏右侧：顶栏高 h-14，控件右对齐；手机宽度下收窄到视口内。
const meta = {
  title: "猜歌/VolumeControl",
  component: SongVolumeControl,
  args: { volume: 0.65, onVolumeChange: fn() },
  render: (args) => <StatefulVolume {...args} />,
  decorators: [
    (Story) => (
      <div className="flex h-14 w-full max-w-[28rem] items-center justify-end bg-background px-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SongVolumeControl>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { name: "默认音量" };

export const Muted: Story = { name: "静音", args: { volume: 0 } };

export const Max: Story = { name: "最大音量", args: { volume: 1 } };

/**
 * 键盘聚焦时轨道变粗、滑块显出（与悬停同一组样式，`group-focus-within`）。
 * 合成的 hover 事件触发不了 CSS `:hover`，原先的「悬停」故事截出来与默认态一模一样；
 * 鼠标悬停由交互实拍覆盖，这里用聚焦把粗轨与拇指稳定地留在截图里。
 */
export const Focused: Story = {
  name: "键盘聚焦 · 轨道变粗",
  play: async ({ canvasElement }) => {
    within(canvasElement).getByRole("slider", { name: "播放音量" }).focus();
  },
};

/** 点图标静音，读数滚到 0、图标换成静音。 */
export const MuteToggle: Story = {
  name: "点图标静音",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "静音" }));
    await expect(canvas.getByRole("button", { name: "取消静音" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
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

/** 房间里的样子：读数之后隔一道细竖线，接写着当前档位的小字按钮。 */
export const WithQuality: Story = {
  name: "带音质选择",
  args: { audioQuality: withQuality("auto") },
};

/** 选单按「立体声 / 空间音频」分组，右侧是规格；这台设备解不了的档置灰并注明。 */
export const QualityMenu: Story = {
  name: "音质选单 · 展开",
  tags: ["overlay"],
  args: {
    audioQuality: withQuality("lossless", {
      kind: "ready",
      requested: "lossless",
      actual: "lossless",
      format: "flac",
    }),
  },
  play: async ({ canvasElement }) => {
    await openQualityMenu(canvasElement);
  },
};

/** 上游降档：选的是母带，本房拿到的最高是极高，胶囊上写实际在放的档，选单顶部说明原因。 */
export const QualityDowngraded: Story = {
  name: "音质选单 · 上游降档",
  tags: ["overlay"],
  args: {
    audioQuality: withQuality("master", {
      kind: "ready",
      requested: "master",
      actual: "exhigh",
      format: "mp3",
    }),
  },
  play: async ({ canvasElement }) => {
    await openQualityMenu(canvasElement);
    await expect(screen.getByText("这首歌在本房最高到「极高」")).toBeVisible();
  },
};

/** 换档途中：胶囊上先写要换去的档并压暗，新地址到手前接着放当前那一档。 */
export const QualityResolving: Story = {
  name: "音质 · 换档中",
  args: { audioQuality: withQuality("hires", { kind: "resolving", requested: "hires" }) },
};

/** 这一档本回合用不上：胶囊回到「自动」，选单顶部说清楚是拿不到还是放不出来。 */
export const QualityFallback: Story = {
  name: "音质选单 · 回到默认档",
  tags: ["overlay"],
  args: {
    audioQuality: withQuality("surround", {
      kind: "fallback",
      requested: "surround",
      reason: "unavailable",
    }),
  },
  play: async ({ canvasElement }) => {
    await openQualityMenu(canvasElement);
  },
};

/** 手机上音质跟音量在同一个弹出胶囊里。 */
export const MobilePopoverWithQuality: Story = {
  name: "移动端 · 弹出音量与音质",
  tags: ["overlay", "mobile"],
  globals: { viewport: { value: "mobile", isRotated: false } },
  args: { audioQuality: withQuality("exhigh") },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "调节音量与音质" }));
    const panel = await screen.findByRole("dialog", { name: "播放音量与音质" });
    await expect(within(panel).getByRole("combobox", { name: /^播放音质/ })).toBeVisible();
    dropFocus();
  },
};
