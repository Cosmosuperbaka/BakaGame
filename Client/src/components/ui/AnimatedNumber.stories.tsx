import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./Button";
import { AnimatedNumber } from "./AnimatedNumber";

const meta = {
  title: "基础控件/AnimatedNumber",
  component: AnimatedNumber,
  args: { value: 12 },
} satisfies Meta<typeof AnimatedNumber>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 手动加减，看逐位滚动、跨过 9/0 的进位与「+N」浮标。截图只拍得到终态。 */
function Stepper() {
  const [value, setValue] = useState(8);
  return (
    <div className="flex items-center gap-4">
      <AnimatedNumber value={value} gain="above" className="text-2xl font-semibold" />
      <div className="flex gap-2">
        {[-5, -1, 1, 3, 95].map((step) => (
          <Button key={step} size="sm" variant="outline" onClick={() => setValue((current) => current + step)}>
            {step > 0 ? `+${step}` : step}
          </Button>
        ))}
      </div>
    </div>
  );
}

export const Rolling: Story = {
  name: "加减滚动",
  render: () => <Stepper />,
};

/** 结算表的用法：挂载时从赛前分滚到赛后分，增量列带符号。截图是滚完的终值。 */
export const FromValue: Story = {
  name: "挂载时从起点滚到终值",
  render: () => (
    <div className="flex items-baseline gap-6 text-lg">
      <AnimatedNumber value={11} from={8} gain="before" />
      <AnimatedNumber value={4} from={0} signed />
      <AnimatedNumber value={-1} from={0} signed />
      <AnimatedNumber value={120} from={95} gain="before" />
    </div>
  ),
};

export const Playground: Story = { name: "调试", tags: ["no-shot"] };
