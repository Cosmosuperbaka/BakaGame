import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen, userEvent, within } from "storybook/test";
import { fn } from "storybook/test";
import { dropFocus } from "@/stories/PlayHelpers";
import {
  roundPlayers,
  WIF_HISTORY_FRAME,
  WIF_PEOPLE,
  WIF_PLAYER_PANEL,
  wifHistory,
  wifPlayer,
  wifPrivate,
  waitingPlayers,
} from "@/stories/fixtures/WhoIsFaker";
import { PlayerList } from "./PlayerList";

const { host, me, peach, azumi, kita, long, spectator } = WIF_PEOPLE;

const meta = {
  title: "谁是卧底/PlayerList",
  component: PlayerList,
  args: {
    players: waitingPlayers(),
    hostPlayerId: host.id,
    myPlayerId: me.id,
    isHost: false,
    phase: "waiting",
    allowSpectators: true,
    roleConfig: { undercoverCount: 2, hasAngel: true, hasBlank: true },
    playerMarks: {},
    onMarkChange: fn(),
  },
  decorators: [
    // 展开发言历史时房间页会把玩家栏扩到整段，组件故事按同一宽度取景，
    // 否则发言列会被 16rem 的面板裁掉。
    (Story, { args }) => (
      <div className={args.history ? WIF_HISTORY_FRAME : WIF_PLAYER_PANEL}><Story /></div>
    ),
  ],
} satisfies Meta<typeof PlayerList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WaitingReady: Story = {
  name: "等待阶段 · 已准备与未准备",
};

export const InGame: Story = {
  name: "局内 · 存活与出局",
  args: { players: roundPlayers("day2"), phase: "description" },
};

export const QuestionerView: Story = {
  name: "主持人视角 · 真实身份",
  args: {
    players: roundPlayers("day2"),
    phase: "description",
    myPlayerId: host.id,
    isHost: true,
    privateState: wifPrivate("host", "day2"),
  },
};

export const SpectatorView: Story = {
  name: "旁观视角 · 全员身份",
  args: {
    players: roundPlayers("day2"),
    phase: "description",
    myPlayerId: spectator.id,
    privateState: wifPrivate("spectator", "day2"),
  },
};

export const GameOver: Story = {
  name: "结算 · 身份公开",
  args: {
    players: roundPlayers("over"),
    phase: "gameOver",
    revealedRoles: new Map(wifPrivate("host", "over").questionerView!.map((entry) => [entry.playerId, entry.role])),
  },
};

export const DeadAndOffline: Story = {
  name: "出局 · 断线 · 人机",
  args: {
    players: roundPlayers("day3").map((player) =>
      player.id === kita.id ? wifPlayer(kita, { roundStatus: "alive", isBot: true })
        : player.id === azumi.id ? wifPlayer(azumi, { online: false, roundStatus: "dead" })
          : player),
    phase: "voting",
  },
};

export const SpectatorsDisabled: Story = {
  name: "等待阶段 · 禁止观战",
  args: { players: waitingPlayers(), allowSpectators: false },
};

export const EmbeddedHistory: Story = {
  name: "展开发言历史 · 嵌入表格",
  args: { players: roundPlayers("day2"), phase: "description", history: wifHistory("day2") },
};

export const EmbeddedHistorySupplement: Story = {
  name: "展开历史 · 补充发言与平票列",
  args: { players: roundPlayers("day3"), phase: "description", history: wifHistory("day3") },
};

export const HostManagePopover: Story = {
  name: "房主操作菜单",
  tags: ["overlay"],
  args: {
    players: roundPlayers("day2"),
    phase: "description",
    myPlayerId: host.id,
    isHost: true,
    privateState: wifPrivate("host", "day2"),
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: `${peach.name} 操作` }));
    await screen.findByRole("button", { name: /转移房主/ });
    dropFocus();
  },
};

export const MarkPrediction: Story = {
  name: "身份预测 · 已标记",
  args: {
    players: roundPlayers("day2"),
    phase: "description",
    playerMarks: { [peach.id]: "undercover", [kita.id]: "blank", [long.id]: "civilian" },
  },
};
