import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { Badge } from "@/components/ui/Badge";
import { Music, Settings2, Users } from "lucide-react";
import { SettingsAccordion, SettingsStack } from "./SettingsAccordion";
import { SettingStepper, SettingSwitchRow, SettingsFields } from "./SettingFields";

const fields = (
  <SettingsFields>
    <SettingSwitchRow label="允许旁观" icon={Users} checked onCheckedChange={fn()} />
    <SettingStepper label="猜测次数" value={10} minimum={1} maximum={100} onChange={fn()} />
  </SettingsFields>
);

const meta = {
  title: "公共组件/SettingsAccordion",
  component: SettingsAccordion,
  args: {
    icon: Settings2,
    title: "房间设置",
    summary: ["允许旁观", "猜测 10 次", "限时 60 秒"],
    open: false,
    onOpenChange: fn(),
    children: fields,
  },
  decorators: [
    (Story) => (
      <div className="w-[28rem] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SettingsAccordion>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = { name: "调试", tags: ["no-shot"] };

/** 等待页的一列折叠组：收起时标题下一行摘要，展开的那一组字段在边框内。 */
export const Stack: Story = {
  name: "收起与展开",
  render: (args) => (
    <SettingsStack>
      <SettingsAccordion {...args} />
      <SettingsAccordion
        {...args}
        icon={Music}
        title="题目设置"
        summary={["OP", "ED", "热度 1000 以上"]}
        open
      />
    </SettingsStack>
  ),
};

/** 标题后的状态标与只读：非房主看到同一份结构，字段换成右侧的取值。 */
export const BadgeAndReadOnly: Story = {
  name: "状态标 · 只读",
  args: {
    badge: (
      <Badge variant="restricted" size="xs">
        会员专享
      </Badge>
    ),
    readOnly: true,
    open: true,
  },
};

/** 窄容器里的长摘要：只在「·」处换行，超过一行的单项截断。 */
export const LongSummary: Story = {
  name: "长摘要 · 窄容器",
  args: {
    summary: ["歌单：周五夜听歌会精选二〇二四年度动画歌曲合集", "OP", "ED", "插曲", "限时 60 秒"],
  },
  decorators: [
    (Story) => (
      <div className="w-64">
        <Story />
      </div>
    ),
  ],
};
