import type { Meta, StoryObj } from "@storybook/react-vite";
import { Spinner } from "./Spinner";

const meta = {
  title: "基础控件/Spinner",
  component: Spinner,
} satisfies Meta<typeof Spinner>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 尺寸与颜色由调用处决定：行内 16px 随文字色，面板内 24px 取次要色，页面级 32px 取 primary。 */
export const Sizes: Story = {
  name: "尺寸与颜色",
  render: () => (
    <div className="flex items-center gap-8">
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        正在查询
      </span>
      <Spinner className="size-6 text-muted-foreground" />
      <Spinner className="size-8 text-primary" />
    </div>
  ),
};
