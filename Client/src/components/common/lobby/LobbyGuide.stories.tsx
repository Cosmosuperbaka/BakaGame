import type { Meta, StoryObj } from "@storybook/react-vite";
import { LobbyGuide } from "./LobbyGuide";

/** 大厅底部的玩法说明：默认收起；文字取自 PageMeta，与静态外壳同一份。 */
const meta = {
  title: "公共组件/LobbyGuide",
  component: LobbyGuide,
  args: { path: "/whoisfaker" },
  decorators: [
    (Story) => (
      <div className="w-[42rem] max-w-full px-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LobbyGuide>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Collapsed: Story = { name: "收起" };

export const Expanded: Story = {
  name: "展开 · 谁是卧底",
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "玩法说明" }));
    await canvas.findByText("怎么算赢");
  },
};

export const ExpandedSong: Story = {
  name: "展开 · 听歌猜歌",
  args: { path: "/songuessr" },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "玩法说明" }));
    await canvas.findByText("两种题型");
  },
};
