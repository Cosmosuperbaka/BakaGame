import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within } from "storybook/test";
import { STORY_EPOCH } from "@/stories/fixtures/Common";
import {
  ANIME_ANSWER,
  ANIME_SEARCH_RESULTS,
  guesserPrivate,
  noPending,
  pendingOn,
  playingPlayers,
  playingSnapshot,
  SONG_ATTEMPTS,
  SONG_PEOPLE,
  SONG_ROOM_ATTEMPTS,
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

/** 倒计时只看是否存在截止时间，秒数由 `secondsLeft` 决定；这里取固定值保证截图稳定。 */
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
    secondsLeft: 42,
    volume: 0.65,
    onVolumeChange: fn(),
    audioStatus: "ready",
    audioPlaybackState: "idle",
    onPlayAudio: fn(),
    onRetryAudio: fn(),
    openSearch: fn(),
    searchMode: null,
    closeSearch: fn(),
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

export const AudioPreparing: Story = {
  name: "音频准备中",
  args: { audioStatus: "loading", privateState: guesserPrivate(DEADLINE, { canGuess: false }) },
};

export const TimerUrgent: Story = { name: "倒计时告急", args: { secondsLeft: 8 } };

export const GivingUp: Story = { name: "正在投降", args: { isPending: pendingOn("song.game.giveUp") } };

export const GaveUp: Story = {
  name: "已投降",
  args: {
    audioPlaybackState: "completed",
    privateState: songPrivate({ remainingGuesses: 2, visibleAttempts: [SONG_ATTEMPTS.meWrong, SONG_ATTEMPTS.meGaveUp] }),
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
export const Instrumental: Story = {
  name: "纯音乐 · 无歌词",
  args: {
    snapshot: playingSnapshot({
      currentRound: { roundNumber: 3, submitterPlayerId: peach.id, audioUrl: "", lyricClip: { startTime: 60_000, endTime: 90_000, lines: [] } },
    }),
  },
};

export const LyricsHidden: Story = {
  name: "房间关闭歌词提示",
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
  },
};

export const RomanLyrics: Story = {
  name: "歌词注音",
  args: { snapshot: playingSnapshot({ currentRound: { roundNumber: 3, submitterPlayerId: peach.id, audioUrl: "", lyricClip: songLyricClip("roman") } }) },
};

export const AttemptResults: Story = {
  name: "猜测记录 · 全部结果类型",
  render: () => (
    <div className="space-y-5">
      <AttemptList attempts={[...SONG_ROOM_ATTEMPTS, SONG_ATTEMPTS.meGaveUp]} title="全房猜测" showPlayerName />
      <AttemptList attempts={[ANIME_ATTEMPTS.meWrong, ANIME_ATTEMPTS.hostCorrect]} title="全房猜测" showPlayerName />
    </div>
  ),
};

// ==================== 游戏区外壳 ====================

/** 测试房间号：游戏区底部叠加测试控制器，同时展开内嵌搜索面板。 */
export const GameAreaTestMode: Story = {
  name: "游戏区 · 测试房 · 猜番搜索",
  args: {
    snapshot: animeSnapshot(),
    searchMode: "guess",
  },
  beforeEach: () => stubSongActions({ searchBangumi: () => Promise.resolve(ANIME_SEARCH_RESULTS) }),
  render: (args) => (
    <div className="flex h-[52rem] w-[36rem] flex-col overflow-hidden rounded-md border bg-panel">
      <SongGameArea {...args} snapshot={{ ...args.snapshot, roomId: ROOM_ID_TEST_MODE, testMode: true }} />
    </div>
  ),
  parameters: { bare: true },
  play: async ({ canvasElement }) => {
    await waitForLyrics(canvasElement);
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByPlaceholderText("输入番剧名称"), "夏空");
    await canvas.findAllByRole("button", { name: "猜这部" });
  },
};
