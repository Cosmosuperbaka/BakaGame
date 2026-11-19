import type { Meta, StoryObj } from "@storybook/react-vite";
import NotFoundPage from "./NotFoundPage";

/** 站内没有的地址：明说页面不存在，给一个回首页的真链接（中键可在新标签页打开）。 */
const meta = {
  title: "页面/页面不存在",
  component: NotFoundPage,
  tags: ["page"],
  parameters: { layout: "fullscreen", router: { route: "/no-such-page", path: "*" } },
} satisfies Meta<typeof NotFoundPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  name: "默认",
  play: async ({ canvas }) => {
    await canvas.findByRole("heading", { name: "页面不存在" });
  },
};
