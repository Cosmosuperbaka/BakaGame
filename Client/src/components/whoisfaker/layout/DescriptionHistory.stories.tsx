import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  WIF_PEOPLE,
  WIF_STAGE_FRAME,
  roundPlayers,
  waitingPlayers,
  wifSnapshot,
} from "@/stories/fixtures/WhoIsFaker";
import { DescriptionTable } from "./DescriptionHistory";

const meta = {
  title: "谁是卧底/DescriptionHistory",
  component: DescriptionTable,
  args: { descriptions: wifSnapshot("day3").descriptions, players: wifSnapshot("day3").players },
  decorators: [(Story) => <div className={WIF_STAGE_FRAME}><Story /></div>],
} satisfies Meta<typeof DescriptionTable>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FullRound: Story = {
  name: "整局发言回顾",
};

export const Compact: Story = {
  name: "紧凑模式",
  args: { compact: true },
};

export const AfterRoundEnd: Story = {
  name: "结算 · 只读姓名列",
  args: {
    descriptions: wifSnapshot("over").descriptions,
    players: undefined,
  },
};

export const Empty: Story = {
  name: "暂无发言",
  args: { descriptions: [], players: waitingPlayers() },
};

export const DepartedPlayer: Story = {
  name: "含已离场玩家的发言",
  args: {
    // 石头在第 1 天后离场：玩家列表里没有他，但第 1 轮的发言必须仍在表里。
    descriptions: wifSnapshot("day3").descriptions,
    players: roundPlayers("day3").filter((player) => player.id !== WIF_PEOPLE.stone.id),
  },
};
