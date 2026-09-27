import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within } from "storybook/test";
import { Music2, Settings } from "lucide-react";
import { dropFocus } from "@/stories/PlayHelpers";
import { songSettings, songSnapshot, stubSongCommand } from "@/stories/fixtures/SonGuessr";
import {
  AnimeAutoFilterSummary,
  CountStepper,
  SettingsAccordion,
  SongAutoFilterSummary,
  SongGameSettings,
  SongQuestionSettings,
  SongRoomSettings,
  SongSettingsPreview,
} from "./SongSettingsPanels";

// 设置面板在等待阶段改动后才会自动保存；故事只渲染初始值，不触发保存请求。
const meta = {
  title: "猜歌/SongSettingsPanels",
  decorators: [(Story) => <div className="w-[28rem] rounded-md bg-panel p-6"><Story /></div>],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const panel = "rounded-md border px-4 py-4";

const PLAYLIST = { id: "3778678", name: "夏夜城市流行精选", songCount: 128 };
const ARTISTS = [{ id: "artist-yakou", name: "夜行ラジオ" }, { id: "artist-chenyu", name: "陈屿" }];

/** 与房主等待面板相同的三个折叠分组，开合由故事自持。 */
function AccordionGroup({ initiallyOpen }: { initiallyOpen: string | null }) {
  const [open, setOpen] = useState(initiallyOpen);
  const snapshot = songSnapshot();
  const sections = [
    { key: "question", title: "题目设置", icon: <Music2 className="h-4 w-4 text-muted-foreground" />, body: <SongQuestionSettings snapshot={snapshot} /> },
    { key: "game", title: "猜测设置", icon: <Settings className="h-4 w-4 text-muted-foreground" />, body: <SongGameSettings snapshot={snapshot} /> },
    { key: "room", title: "房间设置", icon: <Settings className="h-4 w-4 text-muted-foreground" />, body: <SongRoomSettings snapshot={snapshot} /> },
  ];
  return (
    <div className="space-y-5">
      {sections.map((section) => (
        <SettingsAccordion
          key={section.key}
          icon={section.icon}
          title={section.title}
          open={open === section.key}
          onOpenChange={(next) => setOpen(next ? section.key : null)}
        >
          {section.body}
        </SettingsAccordion>
      ))}
    </div>
  );
}

export const AccordionClosed: Story = { name: "折叠分组 · 收起", render: () => <AccordionGroup initiallyOpen={null} /> };

export const AccordionOpen: Story = { name: "折叠分组 · 展开猜测设置", render: () => <AccordionGroup initiallyOpen="game" /> };

export const QuestionManual: Story = {
  name: "题目设置 · 手动出题",
  render: () => <div className={panel}><SongQuestionSettings snapshot={songSnapshot({ settings: songSettings({ autoRotateSubmitter: true }) })} /></div>,
};

export const QuestionAutoSong: Story = {
  name: "题目设置 · 自动出题 · 歌单与歌手",
  render: () => (
    <div className={panel}>
      <SongQuestionSettings snapshot={songSnapshot({
        settings: songSettings({ questionMode: "automatic", autoFilters: { playlist: PLAYLIST, artists: ARTISTS, minPopularity: 10_000 } }),
      })} />
    </div>
  ),
};

export const QuestionAutoDefault: Story = {
  name: "题目设置 · 自动出题 · 未设筛选",
  render: () => <div className={panel}><SongQuestionSettings snapshot={songSnapshot({ settings: songSettings({ questionMode: "automatic" }) })} /></div>,
};
export const QuestionArtistSearch: Story = {
  name: "题目设置 · 搜索歌手",
  beforeEach: () => stubSongCommand((type) => (type === "song.music.artist.search"
    ? Promise.resolve({ results: [{ id: "artist-yakou", name: "夜行ラジオ" }, { id: "artist-yakou-band", name: "夜行バス" }, { id: "artist-yeyou", name: "夜游乐队" }] })
    : Promise.resolve({}))),
  render: () => (
    <div className={panel}>
      <SongQuestionSettings snapshot={songSnapshot({
        settings: songSettings({ questionMode: "automatic", autoFilters: { artists: [ARTISTS[0]], minPopularity: 0 } }),
      })} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByPlaceholderText("输入歌手名后搜索"), "夜行");
    await userEvent.click(canvas.getByRole("button", { name: "搜索" }));
    await canvas.findByText("夜游乐队");
    dropFocus();
  },
};

export const QuestionAutoAnime: Story = {
  name: "题目设置 · 自动出题 · 番剧",
  render: () => (
    <div className={panel}>
      <SongQuestionSettings snapshot={songSnapshot({
        settings: songSettings({
          questionType: "anime", questionMode: "automatic",
          animeAutoFilters: { startYear: 2015, endYear: 2024, ranking: "year", subjectLimit: 30, songMinPopularity: 1_000 },
        }),
      })} />
    </div>
  ),
};

export const QuestionSolo: Story = {
  name: "题目设置 · 单人模式",
  render: () => <div className={panel}><SongQuestionSettings snapshot={songSnapshot({ settings: songSettings({ questionMode: "automatic" }) })} solo /></div>,
};

export const GameDefault: Story = {
  name: "猜测设置 · 默认",
  render: () => <div className={panel}><SongGameSettings snapshot={songSnapshot()} /></div>,
};

export const GameMinimal: Story = {
  name: "猜测设置 · 关闭歌词与时限 · 血战模式",
  render: () => (
    <div className={panel}>
      <SongGameSettings snapshot={songSnapshot({ settings: songSettings({ showLyrics: false, showGuessTimer: false, bloodMode: true, maxGuessesPerRound: 1 }) })} />
    </div>
  ),
};

export const GameSolo: Story = {
  name: "猜测设置 · 单人模式",
  render: () => <div className={panel}><SongGameSettings snapshot={songSnapshot()} solo /></div>,
};

export const RoomPublic: Story = {
  name: "房间设置 · 公开",
  render: () => <div className={panel}><SongRoomSettings snapshot={songSnapshot()} /></div>,
};

export const RoomPrivate: Story = {
  name: "房间设置 · 私密 · 禁止旁观",
  render: () => (
    <div className={panel}>
      <SongRoomSettings snapshot={songSnapshot({ name: "周五夜听歌会", visibility: "private", hasPassword: true, allowSpectators: false })} />
    </div>
  ),
};

export const Preview: Story = {
  name: "设置概览",
  render: () => (
    <div className="space-y-4">
      <SongSettingsPreview snapshot={songSnapshot()} />
      <SongSettingsPreview snapshot={songSnapshot({ settings: songSettings({ autoRotateSubmitter: true, bloodMode: true }) })} />
      <SongSettingsPreview snapshot={songSnapshot({
        visibility: "private", allowSpectators: false,
        settings: songSettings({ questionMode: "automatic", showLyrics: false, showGuessTimer: false, maxGuessesPerRound: 5 }),
      })} />
    </div>
  ),
};

export const AutoFilterSummaries: Story = {
  name: "自动出题筛选摘要",
  render: () => (
    <div className="space-y-3">
      <SongAutoFilterSummary snapshot={songSnapshot({ settings: songSettings({ questionMode: "automatic" }) })} />
      <SongAutoFilterSummary snapshot={songSnapshot({
        settings: songSettings({ questionMode: "automatic", autoFilters: { playlist: PLAYLIST, artists: ARTISTS, minPopularity: 100_000 } }),
      })} />
      <AnimeAutoFilterSummary snapshot={songSnapshot({
        settings: songSettings({
          questionType: "anime", questionMode: "automatic",
          animeAutoFilters: { startYear: 2015, endYear: 2024, ranking: "year", subjectLimit: 30, songMinPopularity: 1_000, trackKinds: ["opening", "ending"] },
        }),
      })} />
    </div>
  ),
};

export const Steppers: Story = {
  name: "数值步进器",
  render: () => (
    <div className={`${panel} space-y-4`}>
      <CountStepper label="歌词行数" value={1} minimum={1} maximum={10} onChange={fn()} />
      <CountStepper label="猜测次数" value={3} minimum={1} maximum={10} onChange={fn()} />
      <CountStepper label="每次猜测时限" value={180} minimum={10} maximum={180} step={10} onChange={fn()} />
      <CountStepper label="猜测次数" value={3} minimum={1} maximum={10} onChange={fn()} disabled />
    </div>
  ),
};
