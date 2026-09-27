import type { Meta, StoryObj } from "@storybook/react-vite";
import { STORY_PLAYERS } from "@/stories/fixtures/Common";
import { PlayerAvatar } from "./PlayerAvatar";
import { PLAYER_ROW_BASE, PLAYER_ROW_HEIGHT } from "./PlayerStatusPill";
import { cn } from "@/lib/Utils";

const meta = {
  title: "公共组件/PlayerAvatar",
  component: PlayerAvatar,
} satisfies Meta<typeof PlayerAvatar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { name: "默认" };

export const WithName: Story = {
  name: "与昵称并排",
  render: () => (
    <div className="w-[16rem] rounded-md border bg-panel px-2 py-3">
      {[STORY_PLAYERS[0], STORY_PLAYERS[6]].map((player) => (
        <div key={player.id} className={cn(PLAYER_ROW_BASE, PLAYER_ROW_HEIGHT)}>
          <PlayerAvatar />
          <span className="min-w-0 flex-1 truncate font-medium" title={player.name}>
            {player.name}
          </span>
        </div>
      ))}
    </div>
  ),
};
