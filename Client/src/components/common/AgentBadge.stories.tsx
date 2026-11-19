import type { Meta, StoryObj } from "@storybook/react-vite";
import { PlayerStatusPill } from "./PlayerStatusPill";
import { AgentBadge, McpControlledBadge } from "./AgentBadge";

const meta = {
  title: "公共组件/AgentBadge",
  component: AgentBadge,
} satisfies Meta<typeof AgentBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 两枚徽标与状态胶囊并排：同一行高，读作同一层级的行内标记。 */
export const WithStatus: Story = {
  name: "与状态胶囊并排",
  render: () => (
    <div className="flex items-center gap-1.5 rounded-md border bg-panel p-4 text-sm">
      <span className="font-medium">BakaAgent</span>
      <AgentBadge />
      <PlayerStatusPill label="准备" tone="success" />
      <span className="ml-4 font-medium">小布丁</span>
      <McpControlledBadge />
      <PlayerStatusPill label="等待" tone="default" />
    </div>
  ),
};
