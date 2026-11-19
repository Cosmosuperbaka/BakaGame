import type { Meta, StoryObj } from "@storybook/react-vite";
import { PageLoadingFallback } from "./PageLoadingFallback";

const meta = {
  title: "公共组件/PageLoadingFallback",
  component: PageLoadingFallback,
  tags: ["page"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PageLoadingFallback>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = { name: "加载中" };
