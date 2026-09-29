import type { Meta, StoryObj } from "@storybook/react-vite";
import { CloseButton } from "./CloseButton";

const meta = {
  title: "基础控件/CloseButton",
  component: CloseButton,
} satisfies Meta<typeof CloseButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 弹窗与内嵌面板各放一个，核对低强调的图标色在两种底色上的可读性。 */
export const Surfaces: Story = {
  name: "弹窗与面板底色",
  render: () => (
    <div className="flex gap-4">
      <div className="relative h-24 w-56 rounded-md border bg-popover p-4 text-sm">
        弹窗
        <CloseButton className="absolute right-3 top-3" />
      </div>
      <div className="relative h-24 w-56 rounded-md bg-muted p-4 text-sm">
        内嵌面板
        <CloseButton className="absolute right-3 top-3 h-7 w-7" />
      </div>
    </div>
  ),
};
