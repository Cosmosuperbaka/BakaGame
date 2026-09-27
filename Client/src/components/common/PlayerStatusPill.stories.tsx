import type { Meta, StoryObj } from "@storybook/react-vite";
import { Crown, WifiOff } from "lucide-react";
import { STORY_PLAYERS, STORY_SPECTATORS } from "@/stories/fixtures/Common";
import { cn } from "@/lib/Utils";
import { PlayerAvatar } from "./PlayerAvatar";
import {
  PLAYER_ME_MARK,
  PLAYER_ROW_BASE,
  PLAYER_ROW_HEIGHT,
  PlayerGroupTitle,
  PlayerStatusPill,
  type PlayerStatusTone,
} from "./PlayerStatusPill";

const meta = {
  title: "公共组件/PlayerStatusPill",
  component: PlayerStatusPill,
  args: { label: "准备", tone: "emerald" },
} satisfies Meta<typeof PlayerStatusPill>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = { name: "调试", tags: ["no-shot"] };

// 各游戏实际出现的状态文案与色调；红色用于卧底身份徽章，与状态胶囊共用同一基底。
const TONES: Array<{ label: string; tone: PlayerStatusTone }> = [
  { label: "等待", tone: "default" },
  { label: "旁观", tone: "default" },
  { label: "完成", tone: "default" },
  { label: "准备", tone: "emerald" },
  { label: "猜中", tone: "emerald" },
  { label: "主持", tone: "violet" },
  { label: "出题", tone: "violet" },
  { label: "猜歌", tone: "amber" },
  { label: "卧底", tone: "red" },
];

export const Tones: Story = {
  name: "全部色调",
  render: () => (
    <div className="flex w-[30rem] flex-wrap items-center gap-2 rounded-md border bg-panel p-4">
      {TONES.map(({ label, tone }) => (
        <PlayerStatusPill key={label} label={label} tone={tone} />
      ))}
    </div>
  ),
};

interface RowProps {
  name: string;
  status: { label: string; tone: PlayerStatusTone };
  score?: number;
  me?: boolean;
  host?: boolean;
  offline?: boolean;
}

function PlayerRow({ name, status, score, me, host, offline }: RowProps) {
  return (
    <div className={cn(PLAYER_ROW_BASE, PLAYER_ROW_HEIGHT, me && "bg-primary/10", offline && "opacity-60")}>
      {me ? <span className={PLAYER_ME_MARK} /> : null}
      <PlayerAvatar />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate font-medium" title={name}>
            {name}
          </span>
          {host ? <Crown className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label="房主" /> : null}
        </span>
        <span className="flex min-h-4 items-center gap-1">
          <PlayerStatusPill {...status} />
          {offline ? <WifiOff className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label="已断线" /> : null}
        </span>
      </span>
      {score !== undefined ? (
        <span className="shrink-0 whitespace-nowrap font-sans text-xs font-normal tabular-nums text-muted-foreground">
          {score}
          <span className="ml-0.5 text-[10px]">分</span>
        </span>
      ) : null}
    </div>
  );
}

const [host, me, peach, azumi, kanade, , longName] = STORY_PLAYERS;

export const Groups: Story = {
  name: "分组标题与玩家行",
  render: () => (
    <div className="h-[36rem] w-[16rem] overflow-hidden rounded-md border bg-panel">
      <div className="min-w-0 px-2">
        <div className="relative flex w-full min-w-0 flex-col py-3">
          <PlayerGroupTitle label="玩家" count={6} />
          <div className="flex flex-col gap-px">
            <PlayerRow name={host.name} host status={{ label: "出题", tone: "violet" }} score={12} />
            <PlayerRow name={peach.name} status={{ label: "猜中", tone: "emerald" }} score={9} />
            <PlayerRow name={me.name} me status={{ label: "猜歌", tone: "amber" }} score={7} />
            <PlayerRow name={longName.name} status={{ label: "猜中", tone: "emerald" }} score={6} />
            <PlayerRow name={kanade.name} status={{ label: "猜歌", tone: "amber" }} score={3} />
            <PlayerRow name={azumi.name} offline status={{ label: "完成", tone: "default" }} score={0} />
          </div>
          <PlayerGroupTitle label="旁观" count={1} withRule />
          <div className="flex flex-col gap-px">
            <PlayerRow name={STORY_SPECTATORS[0].name} status={{ label: "旁观", tone: "default" }} />
          </div>
        </div>
      </div>
    </div>
  ),
};
