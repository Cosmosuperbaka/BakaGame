import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen, userEvent, within } from "storybook/test";
import { dropFocus } from "@/stories/PlayHelpers";
import {
  betweenRoundPlayers,
  playingPlayers,
  SONG_PEOPLE,
  SONG_PLAYER_PANEL,
  songBot,
  stubSongCommand,
  waitingPlayers,
  withHost,
} from "@/stories/fixtures/SonGuessr";
import type { SonGuessrPhase, SonGuessrPlayerView } from "@/types";
import { PlayerList } from "./PlayerList";

const { host, me, peach, spectator } = SONG_PEOPLE;

const meta = {
  title: "猜歌/PlayerList",
  component: PlayerList,
  args: { players: withHost(waitingPlayers()), myPlayerId: me.id, isHost: false, phase: "waiting", allowSpectators: true },
  decorators: [
    (Story, { parameters }) => (parameters.bare ? <Story /> : <div className={SONG_PLAYER_PANEL}><Story /></div>),
  ],
} satisfies Meta<typeof PlayerList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WaitingPlayer: Story = { name: "等待阶段 · 玩家" };

export const WaitingHost: Story = {
  name: "等待阶段 · 房主 · 含人机",
  args: { players: withHost([...waitingPlayers(), songBot("A"), songBot("B")]), myPlayerId: host.id, isHost: true },
};

export const Submitting: Story = {
  name: "出题阶段 · 回合状态未开始",
  args: { players: withHost(betweenRoundPlayers()), phase: "submittingSong" },
};

export const Playing: Story = {
  name: "猜歌阶段 · 出题 / 猜歌 / 猜中 / 完成",
  args: { players: withHost(playingPlayers()), phase: "playing" },
};

export const HostManage: Story = {
  name: "房主操作菜单",
  tags: ["overlay"],
  args: { players: withHost(playingPlayers()), myPlayerId: host.id, isHost: true, phase: "playing" },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: `${peach.name} 操作` }));
    await screen.findByRole("button", { name: /转移房主/ });
    dropFocus();
  },
};

/** 同一玩家在不同阶段与排队状态下的旁观切换入口。 */
function toggleCase(key: string, phase: SonGuessrPhase, mine: Partial<SonGuessrPlayerView>, myId: string = me.id) {
  const players = (phase === "waiting" ? waitingPlayers() : playingPlayers()).map((player) =>
    player.id === myId ? { ...player, ...mine } : player);
  return { key, phase, players: withHost(players), myId };
}

/** 依次为：等待阶段加入旁观、对局中排队旁观、已排队、旁观者取消旁观、旁观者已排队下轮加入。 */
const TOGGLE_CASES = [
  toggleCase("join-waiting", "waiting", {}),
  toggleCase("join-playing", "playing", {}),
  toggleCase("join-queued", "playing", { nextRoundMembership: "spectator" }),
  toggleCase("leave-waiting", "waiting", {}, spectator.id),
  toggleCase("leave-queued", "playing", { nextRoundMembership: "active" }, spectator.id),
];

export const SpectatorToggles: Story = {
  name: "旁观切换入口",
  parameters: { bare: true },
  render: (args) => (
    <div className="grid w-max grid-cols-3 gap-3">
      {TOGGLE_CASES.map(({ key, phase, players, myId }) => (
        <div key={key} className="h-[34rem] w-[16rem] overflow-hidden rounded-md border bg-panel">
          <PlayerList {...args} players={players} myPlayerId={myId} phase={phase} />
        </div>
      ))}
    </div>
  ),
};

/** 本地切换旁观：核对行、分组标题与入口在两组之间连续滑动（不截图，供手动与逐帧检查）。 */
export const SpectatorToggleLive: Story = {
  name: "旁观切换 · 交互",
  tags: ["no-shot"],
  render: function Render(args) {
    const [spectating, setSpectating] = useState(false);
    const players = args.players.map((player) =>
      player.id === me.id ? { ...player, membership: spectating ? "spectator" as const : "active" as const } : player);
    useEffect(() => stubSongCommand(async (_type, payload) => { setSpectating(Boolean(payload?.spectator)); return {}; }), []);
    return <PlayerList {...args} players={players} />;
  },
};
