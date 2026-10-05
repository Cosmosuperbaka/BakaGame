import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";
import { sonGuessrWs } from "@/lib/SonGuessrWs";
import { fromNow } from "@/stories/fixtures/Common";
import { dropFocus } from "@/stories/PlayHelpers";
import {
  choosingSnapshot,
  guesserPrivate,
  playingSnapshot,
  presetSongRoom,
  roundResultSnapshot,
  seedSoloRoom,
  seedUsername,
  soloPlayingSnapshot,
  soloResultSnapshot,
  soloSnapshot,
  SONG_PEOPLE,
  SONG_ROOM_ROUTER,
  SONG_SEARCH_RESULTS,
  SONG_SOLO_ROUTER,
  songPlayer,
  songPrivate,
  songSnapshot,
  spectatorPrivate,
  stubSongActions,
  submitterPrivate,
  submittingSnapshot,
  waitForLyrics,
  waitingPlayers,
} from "@/stories/fixtures/SonGuessr";
import SonGuessrRoomPage from "./SonGuessrRoomPage";

const { host, me, peach } = SONG_PEOPLE;

const meta = {
  title: "页面/猜歌房间",
  component: SonGuessrRoomPage,
  tags: ["page"],
  parameters: { layout: "fullscreen", router: SONG_ROOM_ROUTER },
} satisfies Meta<typeof SonGuessrRoomPage>;

export default meta;
type Story = StoryObj<typeof meta>;

const MOBILE = { viewport: { value: "mobile", isRotated: false } };

/** 让入房流程越过“等待连接”：只替换连接就绪检查，不建立任何 WebSocket。 */
function connectInstantly() {
  Object.defineProperty(sonGuessrWs, "waitForConnection", { configurable: true, value: () => Promise.resolve() });
  return () => {
    Reflect.deleteProperty(sonGuessrWs, "waitForConnection");
  };
}

const allReady = () => waitingPlayers().map((player) => (player.membership === "active" ? { ...player, isReady: true } : player));
const asHost = songPrivate({ playerId: host.id });

// ==================== 入房 ====================

/** 未入房且连接尚未就绪：停在加载指示（8 秒连接超时后会返回大厅）。 */
export const Joining: Story = { name: "正在加入房间" };

export const NameDialog: Story = {
  name: "设置用户名",
  tags: ["!page", "overlay"],
  beforeEach: () => {
    const restoreName = seedUsername("");
    const restoreConnection = connectInstantly();
    return () => {
      restoreConnection();
      restoreName();
    };
  },
  play: async () => {
    await screen.findByRole("dialog", { name: "设置用户名" });
  },
};

export const PasswordDialog: Story = {
  name: "输入房间密码",
  tags: ["!page", "overlay"],
  beforeEach: () => {
    const restoreName = seedUsername(me.name);
    const restoreConnection = connectInstantly();
    stubSongActions({ joinRoom: () => Promise.reject({ code: "PASSWORD_REQUIRED", message: "该房间需要密码" }) });
    return () => {
      restoreConnection();
      restoreName();
    };
  },
  play: async () => {
    await screen.findByRole("dialog", { name: "输入房间密码" });
  },
};

// ==================== 等待阶段 ====================

export const WaitingHostLoggedOut: Story = {
  name: "等待阶段 · 房主 · 未登录网易云",
  beforeEach: () => presetSongRoom(songSnapshot({ musicAccountReady: false, players: allReady() }), asHost),
};

export const WaitingHostReady: Story = {
  name: "等待阶段 · 房主 · 可以开始",
  beforeEach: () => presetSongRoom(songSnapshot({ players: allReady() }), asHost),
};

export const WaitingHostNotReady: Story = {
  name: "等待阶段 · 房主 · 等待准备",
  beforeEach: () => presetSongRoom(songSnapshot(), asHost),
};

export const WaitingPlayer: Story = {
  name: "等待阶段 · 玩家",
  beforeEach: () => presetSongRoom(
    songSnapshot({ players: waitingPlayers().map((player) => (player.id === me.id ? songPlayer(me) : player)) }),
    songPrivate(),
  ),
};

export const WaitingPlayerReady: Story = {
  name: "等待阶段 · 玩家 · 已准备",
  beforeEach: () => presetSongRoom(songSnapshot(), songPrivate()),
};

export const WaitingSpectator: Story = {
  name: "等待阶段 · 旁观",
  beforeEach: () => presetSongRoom(songSnapshot(), spectatorPrivate({ submittedSong: undefined, visibleAttempts: [] })),
};

export const SettingsPanels: Story = {
  name: "设置面板 · 房主",
  beforeEach: () => presetSongRoom(songSnapshot({ players: allReady() }), asHost),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const name of [/题目设置/, /猜测设置/, /房间设置/]) {
      await userEvent.click(canvas.getByRole("button", { name }));
    }
    dropFocus();
  },
};

// ==================== 指定出题人与出题 ====================

export const ChoosingHost: Story = {
  name: "指定出题人 · 房主",
  beforeEach: () => presetSongRoom(choosingSnapshot(), asHost),
};

export const ChoosingPlayer: Story = {
  name: "指定出题人 · 玩家",
  beforeEach: () => presetSongRoom(choosingSnapshot(), songPrivate()),
};

export const SubmittingSubmitter: Story = {
  name: "出题阶段 · 出题人",
  beforeEach: () => presetSongRoom(submittingSnapshot(), songPrivate({ playerId: peach.id, isSubmitter: true, canSubmitSong: true })),
};

export const SubmittingSearch: Story = {
  name: "出题阶段 · 出题人 · 搜索歌曲",
  beforeEach: () => {
    presetSongRoom(submittingSnapshot(), songPrivate({ playerId: peach.id, isSubmitter: true, canSubmitSong: true }));
    stubSongActions({ searchMusic: () => Promise.resolve(SONG_SEARCH_RESULTS) });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole("combobox", { name: "搜索歌曲" }), "夜行ラジオ");
    await screen.findByRole("listbox", { name: "搜索歌曲结果" });
  },
};

export const SubmittingOthers: Story = {
  name: "出题阶段 · 其他玩家",
  beforeEach: () => presetSongRoom(submittingSnapshot(), songPrivate()),
};

// ==================== 猜歌阶段 ====================

export const PlayingGuesser: Story = {
  name: "猜歌阶段 · 猜歌玩家",
  beforeEach: () => presetSongRoom(playingSnapshot(), guesserPrivate(fromNow(47_000))),
  play: async ({ canvasElement }) => waitForLyrics(canvasElement),
};

export const PlayingSubmitter: Story = {
  name: "猜歌阶段 · 出题人",
  beforeEach: () => presetSongRoom(playingSnapshot(), submitterPrivate()),
  play: async ({ canvasElement }) => waitForLyrics(canvasElement),
};

export const PlayingSpectator: Story = {
  name: "猜歌阶段 · 旁观",
  beforeEach: () => presetSongRoom(playingSnapshot(), spectatorPrivate()),
  play: async ({ canvasElement }) => waitForLyrics(canvasElement),
};

// ==================== 结算 ====================

export const RoundResultHost: Story = {
  name: "答案揭晓 · 房主",
  beforeEach: () => presetSongRoom(roundResultSnapshot(), asHost),
};

export const RoundResultPlayer: Story = {
  name: "答案揭晓 · 玩家",
  beforeEach: () => presetSongRoom(roundResultSnapshot(), songPrivate()),
};

// ==================== 单人模式 ====================

const soloPrivate = songPrivate({ playerId: me.id });

export const SoloWaiting: Story = {
  name: "单人模式 · 准备开始",
  args: { solo: true },
  parameters: { router: SONG_SOLO_ROUTER },
  beforeEach: () => {
    presetSongRoom(soloSnapshot(), soloPrivate);
    return seedSoloRoom();
  },
};

export const SoloPlaying: Story = {
  name: "单人模式 · 猜歌",
  args: { solo: true },
  parameters: { router: SONG_SOLO_ROUTER },
  beforeEach: () => {
    presetSongRoom(soloPlayingSnapshot(), guesserPrivate(fromNow(52_000), { remainingGuesses: 3, visibleAttempts: [] }));
    return seedSoloRoom();
  },
  play: async ({ canvasElement }) => waitForLyrics(canvasElement),
};

export const SoloResult: Story = {
  name: "单人模式 · 答案揭晓",
  args: { solo: true },
  parameters: { router: SONG_SOLO_ROUTER },
  beforeEach: () => {
    presetSongRoom(soloResultSnapshot(), soloPrivate);
    return seedSoloRoom();
  },
};

// ==================== 移动端覆盖面板 ====================

export const MobilePlayers: Story = {
  name: "移动端 · 玩家列表",
  tags: ["mobile"],
  globals: MOBILE,
  beforeEach: () => presetSongRoom(playingSnapshot(), guesserPrivate(fromNow(47_000))),
  play: async ({ canvasElement }) => {
    await waitForLyrics(canvasElement);
    const toggle = within(canvasElement).getByRole("button", { name: "玩家列表" });
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-expanded", "true"));
    dropFocus();
  },
};

export const MobileChat: Story = {
  name: "移动端 · 聊天",
  tags: ["mobile"],
  globals: MOBILE,
  beforeEach: () => presetSongRoom(playingSnapshot(), guesserPrivate(fromNow(47_000))),
  play: async ({ canvasElement }) => {
    await waitForLyrics(canvasElement);
    const toggle = within(canvasElement).getByRole("button", { name: "聊天" });
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-expanded", "true"));
    dropFocus();
  },
};
