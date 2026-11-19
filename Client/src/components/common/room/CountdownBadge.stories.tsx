import type { Meta, StoryObj } from "@storybook/react-vite";
import { CountdownBadge } from "./CountdownBadge";

const meta = {
  title: "公共组件/CountdownBadge",
  component: CountdownBadge,
  args: { secondsLeft: 42 },
} satisfies Meta<typeof CountdownBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 常态描边、末段（10 秒及以下）转为危险实底，归零仍保留徽章。 */
export const States: Story = {
  name: "常态、末段与归零",
  args: { secondsLeft: 42 },
  render: () => (
    <div className="flex items-center gap-3">
      <CountdownBadge secondsLeft={120} />
      <CountdownBadge secondsLeft={42} />
      <CountdownBadge secondsLeft={8} />
      <CountdownBadge secondsLeft={0} />
    </div>
  ),
};
