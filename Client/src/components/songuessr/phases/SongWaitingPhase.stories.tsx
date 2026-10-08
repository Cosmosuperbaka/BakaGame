import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import {
  noPending,
  pendingOn,
  soloPlayer,
  soloSnapshot,
  SONG_PEOPLE,
  SONG_STAGE_FRAME,
  songPlayer,
  songSnapshot,
  teamWaitingPlayers,
  waitingPlayers,
} from "@/stories/fixtures/SonGuessr";
import { SongWaitingPhase } from "./SongWaitingPhase";

const { host, me } = SONG_PEOPLE;

const snapshot = songSnapshot();
const find = (id: string) => snapshot.players.find((player) => player.id === id);

// 房间页未覆盖的等待阶段子状态：准备中、开始中、只有房主一人、单人模式未登录。
const meta = {
  title: "猜歌/SongWaitingPhase",
  component: SongWaitingPhase,
  args: { snapshot, me: find(me.id), isHost: false, run: fn(async () => {}), isPending: noPending },
  decorators: [(Story) => <div className={SONG_STAGE_FRAME}><Story /></div>],
} satisfies Meta<typeof SongWaitingPhase>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ReadyPending: Story = {
  name: "玩家 · 正在准备",
  args: {
    snapshot: songSnapshot({ players: waitingPlayers().map((player) => (player.id === me.id ? songPlayer(me) : player)) }),
    me: songPlayer(me),
    isPending: pendingOn("song.player.setReady"),
  },
};

export const HostAlone: Story = {
  name: "房主 · 只有房主一人",
  args: { snapshot: songSnapshot({ players: [songPlayer(host, { isReady: true })] }), me: find(host.id), isHost: true },
};

export const HostStarting: Story = {
  name: "房主 · 正在开始游戏",
  args: {
    snapshot: songSnapshot({ players: waitingPlayers().map((player) => ({ ...player, isReady: true })) }),
    me: find(host.id),
    isHost: true,
    isPending: pendingOn("song.game.start"),
  },
};

export const TeamPicking: Story = {
  name: "玩家 · 选择队伍",
  args: { snapshot: songSnapshot({ players: teamWaitingPlayers() }), me: teamWaitingPlayers().find((player) => player.id === me.id) },
};

export const HostNoCandidate: Story = {
  name: "房主 · 组队后暂无可选出题人",
  args: {
    // 两人同队：谁出题都会让队友一起观战，留不下猜歌的人
    snapshot: songSnapshot({ players: [songPlayer(host, { isReady: true, team: 1 }), songPlayer(me, { isReady: true, team: 1 })] }),
    me: songPlayer(host, { isReady: true, team: 1, isHost: true }),
    isHost: true,
    submitterCandidateIds: [],
  },
};

export const SoloLoggedOut: Story = {
  name: "单人模式 · 未登录网易云",
  args: { snapshot: soloSnapshot({ musicAccountReady: false }), me: soloPlayer(), isHost: true },
};
