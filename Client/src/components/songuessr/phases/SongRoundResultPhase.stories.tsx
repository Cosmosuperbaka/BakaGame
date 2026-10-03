import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import {
  ANIME_ANSWER,
  animeRoundSummary,
  noPending,
  pendingOn,
  roundResultPlayers,
  roundResultSnapshot,
  soloPlayer,
  soloResultSnapshot,
  SONG_ANSWER_DETAILS,
  SONG_EVENING_DETAILS,
  SONG_PEOPLE,
  SONG_ROUND_SCORES,
  SONG_STAGE_FRAME,
  songPrivate,
  songRoundSummary,
  songSettings,
} from "@/stories/fixtures/SonGuessr";
import { SongRoundResultPhase, SongScoreTable, SongSettlementDetails } from "./SongRoundResultPhase";

const { host, long, me } = SONG_PEOPLE;
const hostView = roundResultPlayers().find((player) => player.id === host.id);

// 房间页已覆盖歌曲结算（房主 / 玩家）；这里补充番剧、单人未答对与进行中的按钮状态。
const meta = {
  title: "猜歌/SongRoundResultPhase",
  component: SongRoundResultPhase,
  args: {
    snapshot: roundResultSnapshot(),
    privateState: songPrivate({ playerId: host.id }),
    me: hostView,
    isHost: true,
    run: fn(async () => {}),
    isPending: noPending,
  },
  decorators: [(Story) => <div className={SONG_STAGE_FRAME}><Story /></div>],
} satisfies Meta<typeof SongRoundResultPhase>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Anime: Story = {
  name: "听歌猜番 · 番剧与关联歌曲",
  args: { snapshot: roundResultSnapshot({ settings: songSettings({ questionType: "anime" }), roundSummary: animeRoundSummary() }) },
};

export const AnimeWithoutImages: Story = {
  name: "听歌猜番 · 无封面",
  args: {
    snapshot: roundResultSnapshot({
      settings: songSettings({ questionType: "anime" }),
      roundSummary: animeRoundSummary({
        anime: { ...ANIME_ANSWER, imageUrl: undefined, rating: undefined },
        song: { ...animeRoundSummary().song, pictureUrl: undefined },
        animeTrack: { title: "夏空メロディー", artist: "コトノハ", kind: "ending" },
      }),
    }),
  },
};

export const NextRoundPending: Story = {
  name: "房主 · 正在准备下一轮",
  args: { isPending: pendingOn("song.game.nextRound") },
};

export const AutomaticLoggedOut: Story = {
  name: "自动出题 · 网易云账号未连接",
  args: { snapshot: roundResultSnapshot({ musicAccountReady: false, settings: songSettings({ questionMode: "automatic" }) }) },
};

export const SoloMissed: Story = {
  name: "单人模式 · 本轮未答对",
  args: {
    snapshot: soloResultSnapshot({
      players: [soloPlayer({ score: 1, correctGuesses: 1, totalGuesses: 6, roundStatus: "finished", guessesUsed: 3 })],
      roundSummary: songRoundSummary({ song: SONG_EVENING_DETAILS, submitterPlayerId: "", correctPlayerIds: [], attempts: [], scores: [] }),
    }),
    privateState: songPrivate({ playerId: me.id }),
    me: soloPlayer({ score: 1, correctGuesses: 1, totalGuesses: 6, roundStatus: "finished", guessesUsed: 3 }),
  },
};

export const Settlement: Story = {
  name: "歌曲信息 · 无封面与简介",
  render: () => (
    <section className="rounded-md bg-muted p-4">
      <SongSettlementDetails song={{ ...SONG_ANSWER_DETAILS, pictureUrl: undefined, album: undefined, encyclopedia: { tags: [] } }} />
    </section>
  ),
};

export const Scores: Story = {
  name: "得分统计 · 长名字",
  render: () => <SongScoreTable scores={SONG_ROUND_SCORES} contributors={[host.id, long.id]} />,
};
