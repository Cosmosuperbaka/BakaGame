import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen, userEvent, within } from "storybook/test";
import { Music2, Search, Settings } from "lucide-react";
import { SettingsAccordion, SettingsStack } from "@/components/common/room/SettingsAccordion";
import { dropFocus } from "@/stories/PlayHelpers";
import { songSettings, songSnapshot, stubSongActions } from "@/stories/fixtures/SonGuessr";
import {
  AnimeAutoFilterSummary,
  SongAutoFilterSummary,
  SongGameSettings,
  SongQuestionSettings,
  SongRoomSettings,
  songSettingsSummary,
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

/** 与等待面板相同的三个折叠分组，开合由故事自持；`readOnly` 即非房主看到的样子。 */
function AccordionGroup({ initiallyOpen, readOnly = false, snapshot = songSnapshot() }: {
  initiallyOpen: string | null;
  readOnly?: boolean;
  snapshot?: ReturnType<typeof songSnapshot>;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const summary = songSettingsSummary(snapshot);
  const sections = [
    { key: "question", title: "题目设置", icon: Music2, summary: summary.question, body: <SongQuestionSettings snapshot={snapshot} readOnly={readOnly} /> },
    { key: "game", title: "猜测设置", icon: Search, summary: summary.game, body: <SongGameSettings snapshot={snapshot} readOnly={readOnly} /> },
    { key: "room", title: "房间设置", icon: Settings, summary: summary.room, body: <SongRoomSettings snapshot={snapshot} readOnly={readOnly} /> },
  ];
  return (
    <SettingsStack>
      {sections.map((section) => (
        <SettingsAccordion
          key={section.key}
          icon={section.icon}
          title={section.title}
          summary={section.summary}
          readOnly={readOnly}
          open={open === section.key}
          onOpenChange={(next) => setOpen(next ? section.key : null)}
        >
          {section.body}
        </SettingsAccordion>
      ))}
    </SettingsStack>
  );
}

export const AccordionClosed: Story = { name: "折叠分组 · 收起", render: () => <AccordionGroup initiallyOpen={null} /> };

export const AccordionOpen: Story = { name: "折叠分组 · 展开猜测设置", render: () => <AccordionGroup initiallyOpen="game" /> };

/** 非房主：同一份结构，字段只显示取值。 */
export const ReadOnlyQuestion: Story = {
  name: "只读 · 展开题目设置 · 自动出题",
  render: () => <AccordionGroup initiallyOpen="question" readOnly snapshot={songSnapshot({
    settings: songSettings({ questionMode: "automatic", autoFilters: { playlist: PLAYLIST, artists: ARTISTS, minPopularity: 10_000 } }),
  })} />,
};

export const ReadOnlyGame: Story = {
  name: "只读 · 展开猜测设置",
  render: () => <AccordionGroup initiallyOpen="game" readOnly />,
};

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
  // 歌手搜索在 store 里直接走 WebSocket，不经 sendCommand，故事替换的是 searchArtist 本身。
  beforeEach: () => stubSongActions({
    searchArtist: async () => [{ id: "artist-yakou", name: "夜行ラジオ" }, { id: "artist-yakou-band", name: "夜行バス" }, { id: "artist-yeyou", name: "夜游乐队" }],
  }),
  render: () => (
    <div className={panel}>
      <SongQuestionSettings snapshot={songSnapshot({
        settings: songSettings({ questionMode: "automatic", autoFilters: { artists: [ARTISTS[0]], minPopularity: 0 } }),
      })} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // 停止输入后自动搜索，不再有搜索按钮。
    await userEvent.type(canvas.getByRole("combobox", { name: "搜索歌手" }), "夜行");
    // 结果浮在下方，走 Portal，不在画布里。
    await screen.findByRole("listbox", { name: "搜索歌手结果" });
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
