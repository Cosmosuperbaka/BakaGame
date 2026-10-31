import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { rankedSeries } from "@/stories/fixtures/CEERanked";
import { CEERankedResultCard } from "./CEERankedResultCard";

const meta = {
  title: "CEE/Ranked/结算",
  component: CEERankedResultCard,
  args: {
    series: rankedSeries("won"),
    placementTotal: 5,
    onRequeue: fn(),
    onLeave: fn(),
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[32rem] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CEERankedResultCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Won: Story = { name: "胜利 · 分数上涨" };
export const Lost: Story = { name: "惜败 · 分数下降", args: { series: rankedSeries("lost") } };
export const Drawn: Story = { name: "平局", args: { series: rankedSeries("drawn") } };
export const Pending: Story = { name: "结算中", args: { series: rankedSeries("pending") } };
export const PlacementProgress: Story = {
  name: "定级赛进行中",
  args: { series: rankedSeries("placementProgress") },
};
export const PlacementDone: Story = {
  name: "定级完成",
  args: { series: rankedSeries("placementDone") },
};
export const Unrated: Story = {
  name: "人机额度用完不计分",
  args: { series: rankedSeries("unrated") },
};
export const Failed: Story = { name: "写库失败不计分", args: { series: rankedSeries("failed") } };
export const OpponentExited: Story = {
  name: "对手退出",
  args: {
    series: (() => {
      const series = rankedSeries("won");
      return { ...series, result: series.result && { ...series.result, reason: "exit" as const } };
    })(),
  },
};
