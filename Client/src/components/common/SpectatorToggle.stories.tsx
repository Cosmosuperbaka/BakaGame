import type { ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { SpectatorToggle } from "./SpectatorToggle";

type ToggleProps = Omit<ComponentProps<typeof SpectatorToggle>, "onToggle">;

/** 三个游戏里实际出现的组合；排队态目前只有猜歌使用。 */
const CASES: Array<{ name: string; props: ToggleProps }> = [
  { name: "等待阶段 · 玩家", props: { spectator: true } },
  { name: "等待阶段 · 旁观者", props: { spectator: false } },
  { name: "对局中 · 排队旁观", props: { spectator: true, queued: true } },
  { name: "对局中 · 已排队旁观", props: { spectator: true, queued: true, selected: true } },
  { name: "对局中 · 已排队回到游戏", props: { spectator: false, queued: true, selected: true } },
  { name: "命令进行中", props: { spectator: true, disabled: true } },
];

const meta = {
  title: "公共组件/SpectatorToggle",
  component: SpectatorToggle,
  args: { spectator: true, onToggle: fn() },
  decorators: [
    (Story) => (
      <div className="w-[16rem] rounded-md border bg-panel p-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SpectatorToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = { name: "调试", tags: ["no-shot"] };

/** 按玩家栏实际宽度排布，核对长文案截断与已选择底色。 */
export const AllStates: Story = {
  name: "全部状态",
  render: (args) => (
    <div className="flex flex-col gap-2">
      {CASES.map(({ name, props }) => (
        <div key={name} className="flex flex-col">
          <p className="px-2 font-sans text-2xs text-muted-foreground">{name}</p>
          <SpectatorToggle {...props} onToggle={args.onToggle} />
        </div>
      ))}
    </div>
  ),
};
