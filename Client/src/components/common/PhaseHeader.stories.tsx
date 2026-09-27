import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  CircleHelp,
  Film,
  Gamepad2,
  Headphones,
  MessageSquarePlus,
  MessageSquareText,
  Moon,
  PenLine,
  Scale,
  Trophy,
  UserCheck,
  Vote,
} from "lucide-react";
import { PhaseHeader } from "./PhaseHeader";

const meta = {
  title: "公共组件/PhaseHeader",
  component: PhaseHeader,
  args: { icon: Gamepad2, title: "等待玩家加入" },
  argTypes: { icon: { control: false } },
} satisfies Meta<typeof PhaseHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

// 各游戏阶段实际使用的图标、标题与色调组合。
const PHASES = [
  { key: "waiting", icon: Gamepad2, title: "等待玩家加入" },
  { key: "assign", icon: UserCheck, title: "指定主持人" },
  { key: "word", icon: PenLine, title: "提交词语" },
  { key: "description", icon: MessageSquareText, title: "描述阶段" },
  { key: "supplement", icon: MessageSquarePlus, title: "补充发言", iconClassName: "text-sky-600" },
  { key: "tie", icon: Scale, title: "平票 PK", iconClassName: "text-amber-600" },
  { key: "vote", icon: Vote, title: "投票阶段" },
  { key: "night", icon: Moon, title: "夜晚降临", iconClassName: "text-indigo-500" },
  { key: "blank", icon: CircleHelp, title: "白板猜词", iconClassName: "text-amber-600" },
  { key: "win", icon: Trophy, title: "好人阵营胜利", iconClassName: "text-amber-600", titleClassName: "text-amber-600" },
  { key: "listen", icon: Headphones, title: "听歌猜番" },
  { key: "reveal", icon: Film, title: "答案揭晓" },
];

export const Single: Story = {
  name: "等待阶段",
  render: (args) => (
    <div className="w-full max-w-2xl rounded-md border bg-panel p-6 md:p-8">
      <PhaseHeader {...args} />
    </div>
  ),
};

export const Gallery: Story = {
  name: "各游戏阶段",
  render: () => (
    <div className="grid w-[56rem] grid-cols-4 gap-3">
      {PHASES.map(({ key, ...phase }) => (
        <div key={key} className="rounded-md border bg-panel p-6">
          <PhaseHeader {...phase} />
        </div>
      ))}
    </div>
  ),
};
