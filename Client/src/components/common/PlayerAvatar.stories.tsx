import type { Meta, StoryObj } from "@storybook/react-vite";
import { STORY_PLAYERS } from "@/stories/fixtures/Common";
import { PlayerAvatar } from "./PlayerAvatar";
import { PlayerRow } from "./PlayerRow";
import { PlayerStatusPill } from "./PlayerStatusPill";

const meta = {
  title: "公共组件/PlayerAvatar",
  component: PlayerAvatar,
} satisfies Meta<typeof PlayerAvatar>;

export default meta;
type Story = StoryObj<typeof meta>;

const [host, me, , , , , longName] = STORY_PLAYERS;

export const Default: Story = { name: "默认", args: { name: "小布丁" } };

export const Me: Story = { name: "本人", args: { name: "海豹", me: true } };

/** 首字取昵称第一个字；单字名与长名字都要保持方块尺寸不变。 */
export const Initials: Story = {
  name: "首字取值",
  args: { name: "小布丁" },
  render: () => (
    <div className="flex items-center gap-3 rounded-md border bg-panel p-4">
      {["小布丁", "海豹", "A", "🎵 音乐", longName.name].map((name) => (
        <span key={name} className="flex flex-col items-center gap-1">
          <PlayerAvatar name={name} />
          <span className="max-w-16 truncate font-sans text-2xs text-muted-foreground" title={name}>{name}</span>
        </span>
      ))}
    </div>
  ),
};

/** 与昵称并排时头像不参与截断，长名字先让位。 */
export const WithName: Story = {
  name: "与昵称并排",
  args: { name: "小布丁" },
  render: () => (
    <div className="w-[16rem] rounded-md border bg-panel p-2">
      <div className="flex flex-col gap-px">
        <PlayerRow name={host.name} score={12} host badges={<PlayerStatusPill label="准备" tone="success" />} />
        <PlayerRow name={me.name} score={9} me badges={<PlayerStatusPill label="猜歌" tone="warning" />} />
        <PlayerRow name={longName.name} score={0} badges={<PlayerStatusPill label="旁观" tone="default" />} />
      </div>
    </div>
  ),
};
