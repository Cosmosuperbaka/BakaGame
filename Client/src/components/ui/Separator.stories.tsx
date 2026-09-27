import type { Meta, StoryObj } from "@storybook/react-vite";
import { Separator } from "./Separator";

const meta = {
  title: "基础控件/Separator",
  component: Separator,
} satisfies Meta<typeof Separator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Orientations: Story = {
  name: "横向与纵向",
  render: () => (
    <div className="w-80 rounded-md border bg-panel p-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">题目设置</h3>
        <p className="text-xs text-muted-foreground">设置在开局后固定，仅对下一局生效。</p>
      </div>
      <Separator className="my-4" />
      <div className="flex h-5 items-center gap-3 text-xs text-muted-foreground">
        <span className="font-mono">#4821</span>
        <Separator orientation="vertical" />
        <span>5 玩家</span>
        <Separator orientation="vertical" />
        <span>1 旁观</span>
      </div>
    </div>
  ),
};
