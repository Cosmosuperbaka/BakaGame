import type { Meta, StoryObj } from "@storybook/react-vite";
import { SONG_EVENING_CLIP, songLyricClip, waitForLyrics } from "@/stories/fixtures/SonGuessr";
import { SongLyricPlayer } from "./SongLyricPlayer";

// 不接音频：未播放时停在首句，播放结束进入总览。截图前等原生排版与字体测量完成。
const meta = {
  title: "猜歌/SongLyricPlayer",
  component: SongLyricPlayer,
  args: { lines: songLyricClip().lines, audioPlaybackState: "idle", audioStatus: "ready" },
  decorators: [(Story) => <div className="w-[32rem] rounded-md bg-muted p-4"><Story /></div>],
  play: async ({ canvasElement }) => waitForLyrics(canvasElement),
} satisfies Meta<typeof SongLyricPlayer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Translated: Story = { name: "未播放 · 逐字歌词与翻译" };

export const Overview: Story = { name: "播放结束 · 总览", args: { audioPlaybackState: "completed" } };

export const Roman: Story = { name: "未播放 · 注音", args: { lines: songLyricClip("roman").lines } };

export const Harmony: Story = { name: "播放结束 · 和声", args: { lines: songLyricClip("harmony").lines, audioPlaybackState: "completed" } };

export const Chinese: Story = { name: "播放结束 · 中文歌词", args: { lines: SONG_EVENING_CLIP.lines, audioPlaybackState: "completed" } };

export const Instrumental: Story = { name: "纯音乐", args: { lines: [] }, play: async ({ canvasElement }) => waitForLyrics(canvasElement, 0) };
