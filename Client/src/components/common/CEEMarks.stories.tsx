import type { Meta, StoryObj } from "@storybook/react-vite";
import { CEEMarks } from "./CEEMarks";

const meta = {
  title: "公共组件/CEEMarks",
  component: CEEMarks,
  args: { name: "小布丁", marks: "❌💡✔" },
} satisfies Meta<typeof CEEMarks>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 每种标记一枚：结果靠形状区分，命中与首猜着色，错误与超时取次要前景色。 */
export const AllMarks: Story = {
  name: "全部标记",
  render: () => (
    <div className="w-72 rounded-md border bg-panel p-3">
      <CEEMarks name="小布丁" marks="✔✅💡👑✌🏆❌⏱️💀🏳️" />
    </div>
  ),
};

/** 上游新增了不认识的标记：原样显示文字，不静默丢掉。 */
export const UnknownMark: Story = {
  name: "未知标记",
  render: () => (
    <div className="w-72 rounded-md border bg-panel p-3">
      <CEEMarks name="小布丁" marks="❌🎲✔" />
    </div>
  ),
};

/** 十次以上的进度在窄列里折行，行距与玩家行次行一致。 */
export const ManyMarks: Story = {
  name: "很多次猜测折行",
  render: () => (
    <div className="w-40 rounded-md border bg-panel p-3">
      <CEEMarks name="小布丁" marks="❌❌💡❌⏱️❌❌💡❌❌❌⏱️❌✔" />
    </div>
  ),
};
