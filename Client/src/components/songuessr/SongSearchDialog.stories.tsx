import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within } from "storybook/test";
import { dropFocus } from "@/stories/PlayHelpers";
import { pending, SONG_SEARCH_RESULTS, stubSongActions } from "@/stories/fixtures/SonGuessr";
import { SongSearchDialog } from "./SongSearchDialog";

// 搜索面板内嵌在游戏区阶段内容下方（不是 Portal 弹窗），按游戏区宽度取景。
const meta = {
  title: "猜歌/SongSearchDialog",
  component: SongSearchDialog,
  args: {
    open: true,
    onOpenChange: fn(),
    title: "提交你的猜测",
    description: "每次错误猜测会提供年代、热度、语种与标签反馈。",
    actionLabel: "猜这首",
    onSelect: fn(),
  },
  beforeEach: () => stubSongActions({ searchMusic: () => Promise.resolve(SONG_SEARCH_RESULTS) }),
  decorators: [(Story) => <div className="w-[36rem] rounded-md bg-panel px-6 pb-6 pt-2"><Story /></div>],
} satisfies Meta<typeof SongSearchDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

const search = async (canvasElement: HTMLElement, keyword: string) => {
  const canvas = within(canvasElement);
  await userEvent.type(canvas.getByPlaceholderText("输入歌名、歌手或专辑"), keyword);
  return canvas;
};

export const Initial: Story = { name: "初始" };

export const Results: Story = {
  name: "搜索结果",
  play: async ({ canvasElement }) => {
    const canvas = await search(canvasElement, "夏夜");
    await canvas.findAllByRole("button", { name: "猜这首" });
  },
};

export const Searching: Story = {
  name: "查询中",
  beforeEach: () => stubSongActions({ searchMusic: () => pending() }),
  play: async ({ canvasElement }) => {
    const canvas = await search(canvasElement, "夏夜");
    await canvas.findByText("正在查询网易云音乐");
  },
};

export const NoResults: Story = {
  name: "无匹配歌曲",
  beforeEach: () => stubSongActions({ searchMusic: () => Promise.resolve([]) }),
  play: async ({ canvasElement }) => {
    const canvas = await search(canvasElement, "不存在的歌名");
    await canvas.findByText("没有找到匹配歌曲");
  },
};

export const Submitting: Story = {
  name: "提交中",
  args: {
    title: "选择本回合答案",
    description: "歌曲信息只会在回合结束后公开。",
    actionLabel: "设为答案",
    onSelect: fn(() => pending<void>()),
  },
  play: async ({ canvasElement }) => {
    const canvas = await search(canvasElement, "夜行ラジオ");
    const [first] = await canvas.findAllByRole("button", { name: "设为答案" });
    await userEvent.click(first);
    dropFocus();
  },
};
