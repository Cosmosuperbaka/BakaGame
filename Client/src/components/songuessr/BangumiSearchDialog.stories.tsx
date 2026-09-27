import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within } from "storybook/test";
import { dropFocus } from "@/stories/PlayHelpers";
import { ANIME_SEARCH_RESULTS, pending, stubSongActions } from "@/stories/fixtures/SonGuessr";
import { BangumiSearchDialog } from "./BangumiSearchDialog";

// 与歌曲搜索相同，内嵌在游戏区阶段内容下方，按游戏区宽度取景。
const meta = {
  title: "猜歌/BangumiSearchDialog",
  component: BangumiSearchDialog,
  args: {
    open: true,
    onOpenChange: fn(),
    title: "提交你的番剧猜测",
    description: "番剧信息只会在回合结束后公开。",
    actionLabel: "猜这部",
    onSelect: fn(),
  },
  beforeEach: () => stubSongActions({ searchBangumi: () => Promise.resolve(ANIME_SEARCH_RESULTS) }),
  decorators: [(Story) => <div className="w-[36rem] rounded-md bg-panel px-6 pb-6 pt-2"><Story /></div>],
} satisfies Meta<typeof BangumiSearchDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

const search = async (canvasElement: HTMLElement, keyword: string) => {
  const canvas = within(canvasElement);
  await userEvent.type(canvas.getByPlaceholderText("输入番剧名称"), keyword);
  return canvas;
};

export const Initial: Story = { name: "初始" };

export const Results: Story = {
  name: "搜索结果",
  play: async ({ canvasElement }) => {
    const canvas = await search(canvasElement, "夏空");
    await canvas.findAllByRole("button", { name: "猜这部" });
  },
};

export const Searching: Story = {
  name: "查询中",
  beforeEach: () => stubSongActions({ searchBangumi: () => pending() }),
  play: async ({ canvasElement }) => {
    const canvas = await search(canvasElement, "夏空");
    await canvas.findByText("正在查询 Bangumi");
  },
};

export const NoResults: Story = {
  name: "无匹配番剧",
  beforeEach: () => stubSongActions({ searchBangumi: () => Promise.resolve([]) }),
  play: async ({ canvasElement }) => {
    const canvas = await search(canvasElement, "不存在的番剧");
    await canvas.findByText("没有找到匹配番剧");
  },
};

export const Submitting: Story = {
  name: "提交中",
  args: { title: "选择本回合番剧", actionLabel: "设为答案", onSelect: fn(() => pending<void>()) },
  play: async ({ canvasElement }) => {
    const canvas = await search(canvasElement, "夏空");
    const [first] = await canvas.findAllByRole("button", { name: "设为答案" });
    await userEvent.click(first);
    dropFocus();
  },
};
