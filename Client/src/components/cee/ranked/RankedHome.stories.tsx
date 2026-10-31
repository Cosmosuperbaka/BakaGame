import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { RANKED_IDLE_STATE, rankedProfile, rankedQueuedState } from "@/stories/fixtures/CEERanked";
import { RankedGate } from "./RankedGate";
import { RankedHome } from "./RankedHome";

const meta = {
  title: "CEE/Ranked/首页",
  component: RankedHome,
  args: {
    profile: rankedProfile("rated"),
    state: RANKED_IDLE_STATE,
    placementTotal: 5,
    pending: {},
    onQueue: fn(),
    onCancel: fn(),
    onPlayBot: fn(),
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[64rem] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RankedHome>;

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
export const Narrow: Story = {
  name: "窄屏",
  globals: { viewport: { value: "mobile", isRotated: false } },
};

/** 准入说明：网页端与未登录各一张。 */
export const GateClient: Story = {
  name: "网页端准入说明",
  render: () => <RankedGate reason="client" onLogin={fn()} />,
};
export const GateLogin: Story = {
  name: "客户端未登录",
  render: () => <RankedGate reason="login" onLogin={fn()} />,
};
