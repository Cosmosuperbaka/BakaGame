import type { Meta, StoryObj } from "@storybook/react-vite";
import { BadgeList, EquippedBadge } from "./BadgeList";

const meta = {
  title: "公共组件/身份徽章",
  component: BadgeList,
  args: {
    badges: [
      { kind: "owner", serial: null },
      { kind: "contributor", serial: null },
      { kind: "pioneer", serial: 42 },
    ],
  },
} satisfies Meta<typeof BadgeList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = { name: "调试", tags: ["no-shot"] };

/** 玩家行只展示佩戴中的一枚；悬停任意徽章可看到描述。 */
export const Equipped: Story = {
  name: "佩戴中的徽章",
  render: () => (
    <div className="flex w-[30rem] flex-wrap items-center gap-2 rounded-md border bg-panel p-4">
      <EquippedBadge
        badges={[
          { kind: "owner", serial: null },
          { kind: "contributor", serial: null },
          { kind: "pioneer", serial: 42 },
        ]}
        equipped="pioneer"
      />
      <EquippedBadge badges={[{ kind: "contributor", serial: null }]} equipped="contributor" />
      <EquippedBadge badges={[{ kind: "pioneer", serial: 7 }]} equipped={null} />
    </div>
  ),
};
