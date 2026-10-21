import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SongClipPreview } from "@bakagame/shared";
import { SongClipConfig } from "./SongClipConfig";

// 极短静音 WAV：故事不依赖外网，音频控件能进入就绪态又不打扰截图。
const SILENT_AUDIO =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

const SONG: SongClipPreview = {
  id: "story-song",
  title: "夜に駆ける",
  artist: "YOASOBI",
  album: "THE BOOK",
  durationMs: 261_000,
  audioUrl: SILENT_AUDIO,
  chorus: { startTime: 60_000, endTime: 90_000 },
  lyrics: [
    { time: 12_000, endTime: 15_000, text: "沈むように溶けてゆくように" },
    { time: 15_000, endTime: 18_500, text: "二人だけの空が広がる夜に" },
    { time: 19_000, endTime: 22_000, text: "「さよなら」だけだった" },
    { time: 22_000, endTime: 26_000, text: "その一言で全てが分かった" },
    { time: 27_000, endTime: 31_000, text: "日が沈み出した空と君の姿" },
    { time: 60_000, endTime: 64_000, text: "フェンス越しに重なっていた" },
    { time: 64_000, endTime: 69_000, text: "初めて会った日から" },
    { time: 69_000, endTime: 73_000, text: "僕の心の全てを奪った" },
    { time: 73_000, endTime: 78_000, text: "どこか儚い空気を纏う君は" },
    { time: 79_000, endTime: 84_000, text: "寂しい目をしてたんだ" },
    { time: 130_000, endTime: 134_000, text: "アンコールが止む前に" },
    { time: 134_000, endTime: 138_000, text: "僕らは音を確かめる" },
  ],
};

const meta = {
  title: "猜歌/SongClipConfig",
  component: SongClipConfig,
  args: {
    song: SONG,
    onConfirm: async () => {},
    onCancel: () => {},
  },
  decorators: [
    (Story) => (
      <div className="w-[42rem] max-w-full bg-background p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SongClipConfig>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { name: "带歌词 · 默认副歌区间" };

export const Instrumental: Story = {
  name: "纯音乐",
  args: {
    song: { ...SONG, lyrics: [], chorus: undefined, durationMs: 180_000 },
  },
};
