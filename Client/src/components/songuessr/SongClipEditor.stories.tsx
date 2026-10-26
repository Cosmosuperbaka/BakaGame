import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SongClipPreview } from "@bakagame/shared";
import { placeholderImage } from "@/stories/fixtures/Common";
import { waitForLyrics } from "@/stories/fixtures/SonGuessr";
import { SongClipEditor } from "./SongClipEditor";

// 极短静音 WAV：故事不依赖外网，音频控件能进入就绪态又不打扰截图。
const SILENT_AUDIO =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

const SONG: SongClipPreview = {
  id: "story-song",
  title: "夜に駆ける",
  artist: "YOASOBI",
  album: "THE BOOK",
  pictureUrl: placeholderImage("夜", 215, 160, 160),
  durationMs: 261_000,
  audioUrl: SILENT_AUDIO,
  chorus: { startTime: 60_000, endTime: 90_000 },
  suggestedClip: { startTime: 69_000, endTime: 84_000 },
  lyrics: [
    {
      time: 12_000,
      endTime: 15_000,
      text: "沈むように溶けてゆくように",
      translatedLyric: "仿佛渐渐溶化，沉入夜色",
      words: [
        { startTime: 12_000, endTime: 12_800, word: "沈むように", romanWord: "shi zu mu yo u ni" },
        { startTime: 12_800, endTime: 13_700, word: "溶けて", romanWord: "to ke te" },
        { startTime: 13_700, endTime: 15_000, word: "ゆくように", romanWord: "yu ku yo u ni" },
      ],
    },
    {
      time: 15_000,
      endTime: 18_500,
      text: "二人だけの空が広がる夜に",
      romanLyric: "fu ta ri da ke no so ra ga hi ro ga ru yo ru ni",
    },
    { time: 19_000, endTime: 22_000, text: "「さよなら」だけだった" },
    { time: 22_000, endTime: 26_000, text: "その一言で全てが分かった" },
    {
      time: 27_000,
      endTime: 31_000,
      text: "日が沈み出した空と君の姿",
      isBG: true,
      words: [
        { startTime: 27_000, endTime: 28_500, word: "日が沈み出した" },
        { startTime: 28_500, endTime: 29_500, word: "空と" },
        { startTime: 29_500, endTime: 31_000, word: "君の姿" },
      ],
    },
    { time: 60_000, endTime: 64_000, text: "フェンス越しに重なっていた" },
    { time: 64_000, endTime: 69_000, text: "初めて会った日から" },
    {
      time: 69_000,
      endTime: 73_000,
      text: "僕の心の全てを奪った",
      words: [
        { startTime: 69_000, endTime: 69_700, word: "僕の" },
        { startTime: 69_700, endTime: 70_400, word: "心の" },
        { startTime: 70_400, endTime: 71_200, word: "全てを" },
        { startTime: 71_200, endTime: 73_000, word: "奪った" },
      ],
    },
    {
      time: 73_000,
      endTime: 78_000,
      text: "どこか儚い空気を纏う君は",
      words: [
        { startTime: 73_000, endTime: 74_000, word: "どこか" },
        { startTime: 74_000, endTime: 75_000, word: "儚い" },
        { startTime: 75_000, endTime: 76_200, word: "空気を" },
        { startTime: 76_200, endTime: 77_000, word: "纏う" },
        { startTime: 77_000, endTime: 78_000, word: "君は" },
      ],
    },
    {
      time: 79_000,
      endTime: 84_000,
      text: "寂しい目をしてたんだ",
      words: [
        { startTime: 79_000, endTime: 80_500, word: "寂しい" },
        { startTime: 80_500, endTime: 81_500, word: "目を" },
        { startTime: 81_500, endTime: 84_000, word: "してたんだ" },
      ],
    },
    { time: 130_000, endTime: 134_000, text: "アンコールが止む前に" },
    { time: 134_000, endTime: 138_000, text: "僕らは音を確かめる" },
  ],
};

const meta = {
  title: "猜歌/SongClipEditor",
  component: SongClipEditor,
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
  play: async ({ canvasElement, args }) =>
    waitForLyrics(canvasElement, args.song.lyrics.length > 0 ? 1 : 0),
} satisfies Meta<typeof SongClipEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { name: "逐字与普通歌词 · 统一剪辑台" };

export const NoSuggestion: Story = {
  name: "无建议区间 · 回退副歌",
  args: {
    song: { ...SONG, suggestedClip: undefined },
  },
};

export const LineOnly: Story = {
  name: "纯行级歌词 · 普通回退",
  args: {
    song: {
      ...SONG,
      lyrics: SONG.lyrics.map((line) => ({ ...line, words: undefined })),
    },
  },
};

export const LongTitle: Story = {
  name: "超长曲名 · 信息截断",
  args: {
    song: {
      ...SONG,
      title: "在海风吹过的第七个夏天里我们终于学会了告别",
      artist: "北岸电台 / 苏木",
      album: "潮汐时刻表",
    },
  },
};

export const Instrumental: Story = {
  name: "纯音乐 · 空歌词",
  args: {
    song: { ...SONG, lyrics: [], chorus: undefined, suggestedClip: undefined, durationMs: 180_000 },
  },
};

export const Mobile: Story = {
  name: "移动端 · 逐字与回退",
  tags: ["mobile"],
  globals: { viewport: { value: "mobile", isRotated: false } },
};
