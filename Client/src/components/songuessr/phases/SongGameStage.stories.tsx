import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, screen, userEvent, within } from "storybook/test";
import { STORY_EPOCH } from "@/stories/fixtures/Common";
import {
  ANIME_ANSWER,
  choosingSnapshot,
  ANIME_SEARCH_RESULTS,
  ANIME_SONG_CANDIDATES,
  guesserPrivate,
  noPending,
  pending,
  pendingOn,
  playingPlayers,
  playingSnapshot,
  SONG_ATTEMPTS,
  SONG_PEOPLE,
  SONG_ROOM_ATTEMPTS,
  SONG_SEARCH_RESULTS,
  SONG_STAGE_FRAME,
  songAttempt,
  songLyricClip,
  songSettings,
  stubSongActions,
  submitterPrivate,
  submittingSnapshot,
  songPrivate,
  waitForLyrics,
} from "@/stories/fixtures/SonGuessr";
import { ROOM_ID_TEST_MODE } from "@/types";
import { AttemptList, GameStage, SongGameArea } from "./SongGameStage";

const { host, me, peach, azumi } = SONG_PEOPLE;
const meView = playingPlayers().find((player) => player.id === me.id);

/** 倒计时基于共享回合截止时间，使用固定故事时钟保证截图稳定。 */
const DEADLINE = STORY_EPOCH + 60_000;

const ANIME_ATTEMPTS = {
  meWrong: songAttempt(me, 1, 9, "wrong", { guessedAnime: ANIME_SEARCH_RESULTS[1] }),
  hostCorrect: songAttempt(host, 1, 13, "correct", { guessedAnime: ANIME_ANSWER }),
};

const animeSnapshot = (questionMode: "manual" | "automatic" = "manual") =>
  playingSnapshot({ settings: songSettings({ questionType: "anime", questionMode }) });

// 猜歌阶段的子状态：音频就绪 / 重播 / 失败、倒计时告急、投降、纯音乐、关闭歌词、自动出题与猜番。
const meta = {
  title: "猜歌/SongGameStage",
  component: GameStage,
  args: {
    snapshot: playingSnapshot(),
    privateState: guesserPrivate(DEADLINE),
    me: meView,
    isHost: false,
    guessDeadlineAt: DEADLINE,
    volume: 0.65,
    onVolumeChange: fn(),
    audioStatus: "ready",
    audioPlaybackState: "idle",
    onPlayAudio: fn(),
    onRetryAudio: fn(),
    onSelectSearchSong: fn(async () => {}),
    run: fn(async () => {}),
    isPending: noPending,
  },
  decorators: [(Story, { parameters }) => (parameters.bare ? <Story /> : <div className={SONG_STAGE_FRAME}><Story /></div>)],
  play: async ({ canvasElement }) => waitForLyrics(canvasElement),
} satisfies Meta<typeof GameStage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AudioReady: Story = { name: "音频就绪 · 等待播放" };

export const AudioCompleted: Story = { name: "播放结束 · 歌词总览", args: { audioPlaybackState: "completed" } };

export const AudioError: Story = { name: "音频加载失败", args: { audioStatus: "error" } };

export const AudioPlaying: Story = { name: "播放中", args: { audioPlaybackState: "playing" } };

export const AudioPreparing: Story = {
  name: "音频准备中",
  args: { audioStatus: "loading", privateState: guesserPrivate(DEADLINE, { canGuess: false }) },
};

export const TimerUrgent: Story = { name: "倒计时告急", args: { guessDeadlineAt: DEADLINE } };

export const GivingUp: Story = { name: "正在投降", args: { isPending: pendingOn("song.game.giveUp") } };

export const GaveUp: Story = {
  name: "已投降",
  args: {
    audioPlaybackState: "completed",
    privateState: songPrivate({ remainingGuesses: 2, visibleAttempts: [SONG_ATTEMPTS.meWrong, SONG_ATTEMPTS.meGaveUp] }),
  },
};

/** 猜中后搜索栏换成回执卡，等其他玩家作答。 */
export const GuessedCorrect: Story = {
  name: "已猜中 · 等待其他玩家",
  args: {
    audioPlaybackState: "completed",
    me: playingPlayers().find((player) => player.id === host.id),
    privateState: songPrivate({ playerId: host.id, remainingGuesses: 2, visibleAttempts: [SONG_ATTEMPTS.hostCorrect] }),
  },
};

export const GuessesUsedUp: Story = {
  name: "猜测次数用尽",
  args: {
    audioPlaybackState: "completed",
    me: playingPlayers().find((player) => player.id === azumi.id),
    privateState: songPrivate({
      playerId: azumi.id, remainingGuesses: 0,
      visibleAttempts: [SONG_ATTEMPTS.azumiWrong, SONG_ATTEMPTS.azumiTimeout, SONG_ATTEMPTS.azumiLast],
    }),
  },
};
/** 首次提交前没有猜测记录，记录区整块收起。 */
export const NoAttempts: Story = {
  name: "尚无猜测",
  args: { privateState: guesserPrivate(DEADLINE, { visibleAttempts: [] }) },
};

export const ChoosingSubmitterPending: Story = {
  name: "指定出题人 · 房主 · 提交中",
  play: async ({ canvasElement }) => waitForLyrics(canvasElement, 0),
  args: {
    snapshot: choosingSnapshot(),
    privateState: songPrivate({ playerId: host.id }),
    isHost: true,
    isPending: pendingOn("song.game.chooseSubmitter"),
  },
};

export const Instrumental: Story = {
  name: "纯音乐 · 无歌词",
  play: async ({ canvasElement }) => waitForLyrics(canvasElement, 0),
  args: {
    snapshot: playingSnapshot({
      currentRound: { roundNumber: 3, submitterPlayerId: peach.id, audioUrl: "", lyricClip: { startTime: 60_000, endTime: 90_000, lines: [] } },
    }),
  },
};

export const LyricsHidden: Story = {
  name: "房间关闭歌词提示",
  play: async ({ canvasElement }) => waitForLyrics(canvasElement, 0),
  args: { snapshot: playingSnapshot({ settings: songSettings({ showLyrics: false }) }) },
};

export const AutomaticSong: Story = {
  name: "自动出题 · 歌曲",
  args: {
    snapshot: playingSnapshot({
      settings: songSettings({
        questionMode: "automatic",
        autoFilters: { playlist: { id: "3778678", name: "夏夜城市流行精选", songCount: 128 }, artists: [], minPopularity: 10_000 },
      }),
    }),
  },
};

export const AnimeGuesser: Story = {
  name: "听歌猜番 · 猜题玩家",
  args: { snapshot: animeSnapshot(), privateState: guesserPrivate(DEADLINE, { visibleAttempts: [ANIME_ATTEMPTS.meWrong] }) },
};

export const AnimeSubmitter: Story = {
  name: "听歌猜番 · 出题人",
  args: {
    snapshot: animeSnapshot(),
    privateState: submitterPrivate({ submittedSong: undefined, submittedAnime: ANIME_ANSWER, visibleAttempts: [ANIME_ATTEMPTS.meWrong, ANIME_ATTEMPTS.hostCorrect] }),
    me: playingPlayers().find((player) => player.id === peach.id),
  },
};

export const AnimeAutomatic: Story = {
  name: "听歌猜番 · 自动出题",
  args: { snapshot: animeSnapshot("automatic") },
};

export const SubmittingAnime: Story = {
  name: "出题阶段 · 选番",
  args: {
    snapshot: submittingSnapshot({ settings: songSettings({ questionType: "anime" }) }),
    privateState: songPrivate({ playerId: peach.id, isSubmitter: true, canSubmitSong: true }),
    me: submittingSnapshot().players.find((player) => player.id === peach.id),
    isHost: false,
  },  play: async ({ canvasElement }) => waitForLyrics(canvasElement, 0),
};

export const RomanLyrics: Story = {
  name: "歌词注音",
  args: { snapshot: playingSnapshot({ currentRound: { roundNumber: 3, submitterPlayerId: peach.id, audioUrl: "", lyricClip: songLyricClip("roman") } }) },
};

export const AttemptResults: Story = {
  name: "猜测记录 · 全部结果类型",
  play: async ({ canvasElement }) => waitForLyrics(canvasElement, 0),
  render: () => (
    <div className="space-y-5">
      <AttemptList attempts={[...SONG_ROOM_ATTEMPTS, SONG_ATTEMPTS.meGaveUp]} title="全房猜测" showPlayerName />
      <AttemptList attempts={[ANIME_ATTEMPTS.meWrong, ANIME_ATTEMPTS.hostCorrect]} title="全房猜测" showPlayerName />
    </div>
  ),
};

// ==================== 游戏区外壳 ====================

/** 测试房间号：游戏区底部叠加测试控制器；猜番搜索结果浮在猜测记录之上，不把内容往下挤。 */
export const GameAreaTestMode: Story = {
  name: "游戏区 · 测试房 · 猜番搜索",
  tags: ["overlay"],
  args: {
    snapshot: animeSnapshot(),
    privateState: guesserPrivate(DEADLINE, { visibleAttempts: [ANIME_ATTEMPTS.meWrong] }),
  },
  beforeEach: () => stubSongActions({ searchBangumi: () => Promise.resolve(ANIME_SEARCH_RESULTS) }),
  render: (args) => (
    <div className="flex h-[52rem] w-[36rem] max-w-full flex-col overflow-hidden rounded-md border bg-panel">
      <SongGameArea {...args} snapshot={{ ...args.snapshot, roomId: ROOM_ID_TEST_MODE, testMode: true }} />
    </div>
  ),
  parameters: { bare: true },
  play: async ({ canvasElement }) => {
    await waitForLyrics(canvasElement);
    await userEvent.type(within(canvasElement).getByRole("combobox", { name: "搜索番剧" }), "夏空");
    await screen.findByRole("listbox", { name: "搜索番剧结果" });
  },
};

/** 猜歌搜索：结果浮在猜测记录之上；本回合猜错过的歌保留在列表里并标「已猜过」。 */
export const SongSearchResults: Story = {
  name: "猜歌搜索 · 结果",
  tags: ["overlay"],
  args: { privateState: guesserPrivate(DEADLINE, { visibleAttempts: [SONG_ATTEMPTS.meWrong] }) },
  beforeEach: () => stubSongActions({ searchMusic: () => Promise.resolve(SONG_SEARCH_RESULTS) }),
  play: async ({ canvasElement }) => {
    await waitForLyrics(canvasElement);
    await userEvent.type(within(canvasElement).getByRole("combobox", { name: "搜索歌曲" }), "夏夜");
    await screen.findByRole("listbox", { name: "搜索歌曲结果" });
  },
};

export const SongSearchPending: Story = {
  name: "猜歌搜索 · 查询中",
  tags: ["overlay"],
  beforeEach: () => stubSongActions({ searchMusic: () => pending() }),
  play: async ({ canvasElement }) => {
    await waitForLyrics(canvasElement);
    await userEvent.type(within(canvasElement).getByRole("combobox", { name: "搜索歌曲" }), "夏夜");
    await screen.findByText("正在查询网易云音乐");
  },
};

/** 出题选番：点番剧进入关联曲列表，顶上一行可更换番剧。 */
export const SubmittingAnimeSongs: Story = {
  name: "出题阶段 · 选番 · 关联曲",
  tags: ["overlay"],
  args: SubmittingAnime.args,
  beforeEach: () => stubSongActions({
    searchBangumi: () => Promise.resolve(ANIME_SEARCH_RESULTS),
    resolveAnimeSongs: () => Promise.resolve(ANIME_SONG_CANDIDATES),
  }),
  play: async ({ canvasElement }) => {
    await userEvent.type(within(canvasElement).getByRole("combobox", { name: "搜索番剧" }), "夏空");
    await userEvent.click(await screen.findByRole("option", { name: new RegExp(ANIME_SEARCH_RESULTS[0]!.nameCn) }));
    await screen.findByRole("option", { name: /更换番剧/ });
  },
};
