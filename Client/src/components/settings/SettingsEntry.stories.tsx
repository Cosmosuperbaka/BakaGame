import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { SettingsDialog } from "./SettingsDialog";
import { SettingsEntry } from "./SettingsEntry";

const meta = {
  title: "公共组件/SettingsEntry",
  component: SettingsEntry,
  decorators: [
    (Story) => (
      <div className="flex items-center justify-end rounded-md border bg-panel p-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SettingsEntry>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 入口只有一枚齿轮，打开后才是完整设置面板（见下一条故事）。 */
export const Entry: Story = { name: "入口", tags: ["no-shot"] };

function OpenSettings() {
  const [open, setOpen] = useState(true);
  return <SettingsDialog open={open} onOpenChange={setOpen} />;
}

/** 统一设置面板：MCP、外观、提示音与云同步在同一处。 */
export const DialogOpen: Story = {
  name: "设置面板",
  render: () => <OpenSettings />,
  tags: ["overlay"],
};
