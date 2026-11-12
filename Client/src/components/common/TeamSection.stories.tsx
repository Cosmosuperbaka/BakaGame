import type { Meta, StoryObj } from "@storybook/react-vite";
import { CEEMarks } from "./CEEMarks";
import { PlayerRow } from "./PlayerRow";
import { TeamSection } from "./TeamSection";

const meta = {
  title: "公共组件/TeamSection",
  component: TeamSection,
  args: { team: 1, scores: [], detail: "", children: null },
} satisfies Meta<typeof TeamSection>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 玩家栏宽度里的队伍块：组队的人包在淡底里，个人游玩只有一行小标题。 */
export const Teams: Story = {
  name: "组队与个人",
  render: () => (
    <div className="w-72 space-y-1.5 rounded-md border bg-panel p-1.5">
      <TeamSection
        team={1}
        scores={[12, 7]}
        detail="2 人 · 3/10 次"
        extra={<CEEMarks name="1 队" marks="❌💡❌✔" />}
      >
        <PlayerRow name="小布丁" score={12} host me />
        <PlayerRow name="海豹" score={7} />
      </TeamSection>
      <TeamSection team={2} scores={[0]} detail="1 人 · 0/10 次">
        <PlayerRow name="桃子" score={0} />
      </TeamSection>
      <TeamSection team={null} scores={[5]} detail="">
        <PlayerRow name="Kanade" score={5} />
      </TeamSection>
    </div>
  ),
};

/** 队伍说明很长、合计分到三位数：说明截断，合计不被挤走。 */
export const LongDetail: Story = {
  name: "长说明与大分数",
  render: () => (
    <div className="w-72 rounded-md border bg-panel p-1.5">
      <TeamSection
        team={12}
        scores={[480, 333, 210]}
        detail="3 人 · 共享 9/10 次 · 已提交两次作品猜测"
      >
        <PlayerRow name="名称很长的玩家用于测试截断" score={480} />
        <PlayerRow name="阿澄" score={333} />
        <PlayerRow name="路人甲" score={210} />
      </TeamSection>
    </div>
  ),
};
