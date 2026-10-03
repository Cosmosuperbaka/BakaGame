import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { Eye, UserCheck } from "lucide-react";
import { STORY_PLAYERS, STORY_SPECTATORS } from "@/stories/fixtures/Common";
import { CandidateGrid, SectionHeader } from "./CandidateGrid";

const [host, me, peach, azumi, , , longName] = STORY_PLAYERS;
const CANDIDATES = [host, me, peach, azumi];

const meta = {
  title: "公共组件/CandidateGrid",
  component: CandidateGrid,
  args: { candidates: CANDIDATES, tone: "default", nameWrap: "truncate", onPick: fn() },
  argTypes: {
    tone: { control: "inline-radio", options: ["default", "recommended"] },
    nameWrap: { control: "inline-radio", options: ["truncate", "wrap"] },
  },
  decorators: [(Story) => <div className="w-full max-w-xl"><Story /></div>],
} satisfies Meta<typeof CandidateGrid>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 卧底阶段的「玩家」区块：默认色调。 */
export const Default: Story = { name: "默认色调" };

/** 旁观的推荐项：整块带主色描边与浅底，图标也换成旁观标记。 */
export const Recommended: Story = {
  name: "推荐旁观",
  args: { candidates: [...STORY_SPECTATORS, ...CANDIDATES], tone: "recommended" },
};

/** 换行策略是逐调用点声明的：截断保持行高一致（卧底），换行把长名字整行铺开（猜歌）。 */
export const LongName: Story = {
  name: "长名字截断与换行",
  render: (args) => (
    <div className="flex flex-col gap-4">
      {(["truncate", "wrap"] as const).map((nameWrap) => (
        <div key={nameWrap} className="flex flex-col gap-1">
          <p className="px-1 text-xs text-muted-foreground">nameWrap=&quot;{nameWrap}&quot;</p>
          <CandidateGrid {...args} nameWrap={nameWrap} candidates={[longName, host, me]} />
        </div>
      ))}
    </div>
  ),
};

/** 候选为空时的占位。 */
export const Empty: Story = { name: "空候选", args: { candidates: [] } };

/** 同文件的区块小标题：右侧 hint 是补充说明，缺省时右侧留空；不传图标时用缺省图标。 */
export const SectionHeaders: Story = {
  name: "区块小标题",
  render: () => (
    <div className="flex flex-col gap-5">
      <SectionHeader icon={<Eye className="h-3.5 w-3.5" />} title="旁观玩家" hint="推荐：玩家全员参战" />
      <SectionHeader icon={<UserCheck className="h-3.5 w-3.5" />} title="玩家" />
      <SectionHeader title="不传图标时的缺省图标" />
    </div>
  ),
};
