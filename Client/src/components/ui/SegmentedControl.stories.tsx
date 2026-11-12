import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { SegmentedControl } from "./SegmentedControl";

const THEMES = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];

const meta = {
  title: "基础控件/SegmentedControl",
  component: SegmentedControl,
  args: { value: "system", options: THEMES, onValueChange: fn(), "aria-label": "主题" },
} satisfies Meta<typeof SegmentedControl>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 两档尺寸：default 与 Button 默认高度对齐，sm 用于设置面板、工具条等密集区域；各段等宽取最长一段。 */
export const Sizes: Story = {
  name: "尺寸",
  render: (args) => (
    <div className="flex flex-col items-start gap-3">
      <SegmentedControl {...args} />
      <SegmentedControl {...args} size="sm" />
    </div>
  ),
};

/** 不可选的一段整段变淡，指示器不落在它上面。 */
export const Disabled: Story = {
  name: "含禁用项",
  args: {
    value: "auto",
    options: [
      { value: "auto", label: "自动出题" },
      { value: "host", label: "房主出题" },
      { value: "catalog", label: "目录出题", disabled: true },
    ],
  },
};

/** 撑满整行：调用处传 `w-full`。 */
export const FullWidth: Story = {
  name: "撑满",
  render: (args) => (
    <div className="w-96">
      <SegmentedControl {...args} className="w-full" />
    </div>
  ),
};
