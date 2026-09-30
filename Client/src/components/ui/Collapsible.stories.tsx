import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge } from "./Badge";
import { Collapsible } from "./Collapsible";

const meta = {
  title: "基础控件/Collapsible",
  component: Collapsible,
  args: {
    title: "角色简介",
    children: <p className="whitespace-pre-wrap text-sm leading-relaxed">乐队的鼓手兼队长，性格开朗、很会照顾人，是乐队里调和气氛的存在。</p>,
  },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Collapsible>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = { name: "调试", tags: ["no-shot"] };

/** 答案卡里的角色简介：标题与同区域的 text-sm 正文同字号，收起与展开各一份。 */
export const Default: Story = {
  name: "收起与展开",
  render: (args) => (
    <div className="space-y-6">
      {[false, true].map((open) => (
        <div key={String(open)} className="space-y-4 rounded-md border bg-muted/30 p-4">
          <p className="text-sm">声优：示例声优</p>
          <Collapsible {...args} defaultOpen={open} />
        </div>
      ))}
    </div>
  ),
};

/** CCB 反馈表这类 text-xs 的密集区域用 `size="sm"`，标题与箭头随之收小，不比周围的标签更醒目。 */
export const Small: Story = {
  name: "密集区域 · 小号",
  args: {
    title: "游戏专属标签",
    size: "sm",
    children: (
      <div className="flex flex-wrap gap-1 text-xs">
        <Badge size="sm" variant="matched">吉他</Badge>
        <Badge size="sm" variant="muted">作曲</Badge>
      </div>
    ),
  },
  render: (args) => (
    <div className="space-y-6">
      {[false, true].map((open) => (
        <div key={String(open)} className="space-y-2 rounded-md border p-3">
          <p className="text-xs text-success">共同作品：示例作品</p>
          <div className="flex flex-wrap gap-1">
            <Badge size="sm" variant="muted">鼓手</Badge>
            <Badge size="sm" variant="matched">队长</Badge>
          </div>
          <Collapsible {...args} defaultOpen={open} />
        </div>
      ))}
    </div>
  ),
};
