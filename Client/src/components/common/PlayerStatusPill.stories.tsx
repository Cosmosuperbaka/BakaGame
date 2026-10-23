import type { Meta, StoryObj } from "@storybook/react-vite";
import { Bot, Crown, Skull, WifiOff } from "lucide-react";
import { STORY_PLAYERS, STORY_SPECTATORS } from "@/stories/fixtures/Common";
import { PlayerRow } from "./PlayerRow";
import {
  PlayerStatusIcon,
  PlayerStatusPill,
  PlayerGroupTitle,
  type PlayerStatusTone,
} from "./PlayerStatusPill";

const meta = {
  title: "公共组件/PlayerStatusPill",
  component: PlayerStatusPill,
  args: { label: "准备", tone: "success" },
} satisfies Meta<typeof PlayerStatusPill>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = { name: "调试", tags: ["no-shot"] };

// 各游戏实际出现的状态文案与色调；红色用于卧底身份徽章，与状态胶囊共用同一基底。
const TONES: Array<{ label: string; tone: PlayerStatusTone }> = [
  { label: "等待", tone: "default" },
  { label: "旁观", tone: "default" },
  { label: "完成", tone: "default" },
  { label: "准备", tone: "success" },
  { label: "猜中", tone: "success" },
  { label: "主持", tone: "questioner" },
  { label: "出题", tone: "questioner" },
  { label: "猜歌", tone: "warning" },
  { label: "卧底", tone: "danger" },
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

/**
 * 玩家栏实际用的图标档：同一批状态名收成图标，字形由 `PLAYER_STATUS_ICONS` 按名字给。
 * 认不出的名字回退成问号圆，不会留下「有底块没图标」的空格。
 */
export const StatusIcons: Story = {
  name: "状态图标",
  render: () => (
    <div className="flex w-[30rem] flex-wrap items-center gap-2 rounded-md border bg-panel p-4">
      {TONES.map(({ label, tone }) => (
        <PlayerStatusIcon key={label} label={label} tone={tone} />
      ))}
      <PlayerStatusIcon label="房主" tone="warning" icon={<Crown aria-hidden="true" />} />
      <PlayerStatusIcon label="离线" tone="danger" icon={<WifiOff aria-hidden="true" />} />
      <PlayerStatusIcon label="已出局" tone="default" icon={<Skull aria-hidden="true" />} />
      <PlayerStatusIcon label="测试人机" tone="questioner" icon={<Bot aria-hidden="true" />} />
      <PlayerStatusIcon label="没登记的新状态" tone="default" />
    </div>
  ),
};

const [host, me, peach, azumi, kanade, , longName] = STORY_PLAYERS;

/** 分组标题与行内徽章在真实面板宽度下的排布，与三个游戏的玩家栏取同一套尺寸。 */
export const Groups: Story = {
  name: "分组标题与玩家行",
  render: () => (
    <div className="h-[36rem] w-[16rem] overflow-hidden rounded-md border bg-panel">
      <div className="min-w-0 px-2">
        <div className="relative flex w-full min-w-0 flex-col py-3">
          <PlayerGroupTitle label="玩家" count={6} />
          <div className="flex flex-col gap-px">
            <PlayerRow
              name={host.name}
              score={12}
              host
              badges={<PlayerStatusPill label="出题" tone="questioner" />}
            />
            <PlayerRow
              name={peach.name}
              score={9}
              badges={<PlayerStatusPill label="猜中" tone="success" />}
            />
            <PlayerRow
              name={me.name}
              score={7}
              me
              badges={<PlayerStatusPill label="猜歌" tone="warning" />}
            />
            <PlayerRow
              name={longName.name}
              score={6}
              badges={<PlayerStatusPill label="猜中" tone="success" />}
            />
            <PlayerRow
              name={kanade.name}
              score={3}
              badges={<PlayerStatusPill label="猜歌" tone="warning" />}
            />
            <PlayerRow
              name={azumi.name}
              score={0}
              online={false}
              badges={<PlayerStatusPill label="完成" tone="default" />}
            />
          </div>
          {/* 旁观分组的标题已经说明身份，行内不再重复「旁观」徽章。 */}
          <PlayerGroupTitle label="旁观" count={1} withRule />
          <div className="flex flex-col gap-px">
            <PlayerRow name={STORY_SPECTATORS[0].name} score={0} />
          </div>
        </div>
      </div>
    </div>
  ),
};
