import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen } from "storybook/test";
import { dropFocus } from "@/stories/PlayHelpers";
import LandingPage from "./LandingPage";

const meta = {
  title: "页面/主页",
  component: LandingPage,
  tags: ["page"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof LandingPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { name: "默认" };

export const Changelog: Story = {
  name: "版本信息 · 更新日志",
  tags: ["overlay"],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: /^V/ }));
    await screen.findByRole("tabpanel", { name: "更新日志" });
    dropFocus();
  },
};

export const Commits: Story = {
  name: "版本信息 · 提交历史",
  tags: ["overlay"],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: /^V/ }));
    await userEvent.click(await screen.findByRole("tab", { name: "提交历史" }));
    await screen.findByRole("tabpanel", { name: "提交历史" });
    dropFocus();
  },
};
