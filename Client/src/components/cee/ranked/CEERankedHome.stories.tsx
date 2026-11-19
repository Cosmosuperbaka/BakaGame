import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within } from "storybook/test";
import {
  RANKED_IDLE_STATE,
  rankedLeaderboard,
  rankedProfile,
  rankedQueuedState,
} from "@/stories/fixtures/CEERanked";
import { CEERankedGate } from "./CEERankedGate";
import { CEERankedHome } from "./CEERankedHome";

const meta = {
  title: "CEE/Ranked/首页",
  component: CEERankedHome,
  args: {
    profile: rankedProfile("rated"),
    state: RANKED_IDLE_STATE,
    placementTotal: 5,
    pending: {},
    leaderboard: rankedLeaderboard(),
    onQueue: fn(),
    onCancel: fn(),
    onPlayBot: fn(),
    onLoadMoreHistory: fn(),
    onOpenLeaderboard: fn(),
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[64rem] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CEERankedHome>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Rated: Story = { name: "已定级 · 空闲" };
export const Placement: Story = {
  name: "定级中 · 空闲",
  args: { profile: rankedProfile("placement") },
};
export const FirstVisit: Story = { name: "首次进入", args: { profile: rankedProfile("empty") } };
export const Loading: Story = { name: "读取中", args: { profile: null } };
export const Queued: Story = {
  name: "排队中 · 刚开始",
  args: { state: rankedQueuedState(3_000) },
};
export const QueuedBotReady: Story = {
  name: "排队满 10 秒 · 可先打人机",
  args: { state: rankedQueuedState(12_000) },
};

/** 战绩列表在面板内固定高度滚动：滚到底才看得到末尾的翻页按钮或到底提示。 */
async function scrollHistoryToEnd({ canvasElement }: { canvasElement: HTMLElement }) {
  const list = await within(canvasElement).findByLabelText("全部战绩");
  list.scrollTop = list.scrollHeight;
}

/** 排行榜在第二个标签页里，切过去才渲染。 */
async function openLeaderboard({ canvasElement }: { canvasElement: HTMLElement }) {
  await userEvent.click(within(canvasElement).getByRole("tab", { name: "排行榜" }));
  (document.activeElement as HTMLElement | null)?.blur();
}

export const HistoryEnd: Story = {
  name: "战绩翻到底",
  args: { profile: { ...rankedProfile("rated"), recentHasMore: false } },
  play: scrollHistoryToEnd,
};
export const HistoryLoading: Story = {
  name: "战绩翻页中",
  args: { historyLoading: true },
  play: scrollHistoryToEnd,
};
export const Leaderboard: Story = {
  name: "已定级看排行榜",
  play: openLeaderboard,
};
export const LeaderboardLoading: Story = {
  name: "排行榜读取中",
  args: { leaderboard: null },
  play: openLeaderboard,
};
export const LeaderboardUnplaced: Story = {
  name: "定级中看排行榜",
  args: {
    profile: rankedProfile("placement"),
    // 定级中的本人不上榜：榜单里也不能有标着「你」的那一行。
    leaderboard: (() => {
      const board = rankedLeaderboard();
      return {
        ...board,
        self: null,
        entries: board.entries.map((entry) => ({ ...entry, self: false })),
      };
    })(),
  },
  play: openLeaderboard,
};
export const RulesOpen: Story = {
  name: "规则展开",
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "规则" }));
    (document.activeElement as HTMLElement | null)?.blur();
  },
};
/** `mobile` 标签让截图脚本按 390 宽视口拍：只设 Storybook 的视口全局量，脚本仍按 1440 截图。 */
export const Narrow: Story = {
  name: "窄屏",
  tags: ["mobile"],
  globals: { viewport: { value: "mobile", isRotated: false } },
};

/** 准入说明：网页端与未登录各一张。 */
export const GateClient: Story = {
  name: "网页端准入说明",
  render: () => <CEERankedGate reason="client" onLogin={fn()} />,
};
export const GateLogin: Story = {
  name: "客户端未登录",
  render: () => <CEERankedGate reason="login" onLogin={fn()} />,
};
