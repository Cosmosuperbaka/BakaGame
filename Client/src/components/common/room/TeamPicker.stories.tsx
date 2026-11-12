import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { STORY_PLAYERS } from "@/stories/fixtures/Common";
import { TeamPicker } from "./TeamPicker";

const [host, me, peach, azumi, kanade, kitagawa, long] = STORY_PLAYERS;

const meta = {
  title: "公共组件/TeamPicker",
  component: TeamPicker,
  args: {
    selfId: me.id,
    switching: false,
    hint: "同队共享猜测次数",
    onPick: fn(),
    players: [
      { ...host, team: 1 },
      { ...me, team: 1 },
      { ...peach, team: 2 },
      { ...azumi, team: null },
      { ...kanade, team: 1 },
      { ...kitagawa, team: 1 },
      { ...long, team: 1 },
    ],
  },
  decorators: [
    (Story) => (
      <div className="w-[28rem] max-w-full rounded-md border bg-panel p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TeamPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = { name: "调试", tags: ["no-shot"] };

/** 本人在 1 队：底块落在 1 队格，五人叠四枚头像加「+1」；空队写「空」。 */
export const Default: Story = { name: "已选队伍" };

/** 个人游玩：底块落在「个人」格。 */
export const Solo: Story = {
  name: "个人游玩",
  args: {
    players: [
      { ...me, team: null },
      { ...peach, team: 2 },
    ],
  },
};

/** 换队请求在途：整组禁用，光标为等待。 */
export const Switching: Story = { name: "切换中", args: { switching: true } };
