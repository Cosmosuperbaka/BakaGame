import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, screen, userEvent, within } from "storybook/test";
import type { SongSearchResult } from "@bakagame/shared";
import { rejectedProtocol } from "@/lib/ProtocolFailure";
import {
  ANIME_SEARCH_RESULTS,
  ANIME_SONG_CANDIDATES,
  pending,
  SONG_SEARCH_RESULTS,
  stubSongActions,
} from "@/stories/fixtures/SonGuessr";
import { AnimeSearch, SongSearch } from "./SongSearch";

const [answer, rain, glass, evening, blue, long] = SONG_SEARCH_RESULTS;

/**
 * 真实结果的 id 带平台前缀（`netease:` / `qq:`），行尾据此挂品牌图标；
 * 聚合器给出两家音源时并排两枚，QQ 会员专享且池里没有会员时整行不可选、挂「不可播放」。
 * 页面故事里的搜索夹具没有前缀，这几种行尾从未入镜，这里补齐。
 */
const PLATFORM_RESULTS: SongSearchResult[] = [
  { ...answer, id: "netease:1001" },
  { ...rain, id: "qq:2002" },
  { ...glass, id: "netease:1003", sources: ["netease:1003", "qq:2003"] },
  {
    ...evening,
    id: "qq:2004",
    playable: false,
    unplayableReason: "QQ 音乐会员专享，账号池里没有会员账号",
  },
  { ...blue, id: "netease:1005" },
  { ...long, id: "qq:2006" },
];

/** 输入关键词并回车立即查询，等浮层出现。 */
async function search(canvasElement: HTMLElement, keyword: string, label = "搜索歌曲") {
  await userEvent.type(
    within(canvasElement).getByRole("combobox", { name: label }),
    `${keyword}{Enter}`
  );
}

/** 歌曲搜索：故事给足下方空间，浮层不必翻到上方。 */
const meta = {
  title: "猜歌/SongSearch",
  component: SongSearch,
  args: { mode: "guess", onSelect: fn(async () => {}) },
  beforeEach: () => stubSongActions({ searchMusic: () => Promise.resolve(PLATFORM_RESULTS) }),
  decorators: [
    (Story) => (
      <div className="mx-auto min-h-[30rem] w-[36rem] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SongSearch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = { name: "空" };

export const Disabled: Story = { name: "禁用（音频准备中）", args: { disabled: true } };

export const Results: Story = {
  name: "结果 · 平台图标、双源与不可播放",
  play: async ({ canvasElement }) => {
    await search(canvasElement, "夏夜");
    await screen.findByRole("listbox", { name: "搜索歌曲结果" });
  },
};

export const KeyboardHighlight: Story = {
  name: "结果 · 键盘高亮",
  play: async ({ canvasElement }) => {
    await search(canvasElement, "夏夜");
    await screen.findByRole("listbox", { name: "搜索歌曲结果" });
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
  },
};

export const Guessed: Story = {
  name: "结果 · 已猜过",
  args: { guessedIds: ["netease:1001", "qq:2002"] },
  play: async ({ canvasElement }) => {
    await search(canvasElement, "夏夜");
    await screen.findByRole("listbox", { name: "搜索歌曲结果" });
  },
};

export const Searching: Story = {
  name: "搜索中",
  beforeEach: () => stubSongActions({ searchMusic: () => pending() }),
  play: async ({ canvasElement }) => {
    await search(canvasElement, "夏夜");
    await screen.findByText("正在搜索歌曲");
  },
};

export const NoResult: Story = {
  name: "无结果",
  beforeEach: () => stubSongActions({ searchMusic: () => Promise.resolve([]) }),
  play: async ({ canvasElement }) => {
    await search(canvasElement, "不存在的歌");
    await screen.findByText("没有找到匹配歌曲");
  },
};

export const Failed: Story = {
  name: "搜索失败",
  beforeEach: () =>
    stubSongActions({
      searchMusic: () =>
        rejectedProtocol({ code: "MUSIC_UPSTREAM", message: "音乐服务暂时不可用" }),
    }),
  play: async ({ canvasElement }) => {
    await search(canvasElement, "夏夜");
    await screen.findByText("音乐服务暂时不可用");
  },
};

/** 猜番：番剧行是竖版海报，没有封面时退回胶片图标。 */
export const AnimeResults: StoryObj<typeof AnimeSearch> = {
  name: "番剧 · 结果",
  render: (args) => <AnimeSearch {...args} />,
  args: { mode: "guess", onSelect: fn(async () => {}) },
  beforeEach: () =>
    stubSongActions({
      searchBangumi: () => Promise.resolve(ANIME_SEARCH_RESULTS),
      sendCommand: (() => pending()) as never,
    }),
  play: async ({ canvasElement }) => {
    await search(canvasElement, "夏空", "搜索番剧");
    await screen.findByRole("listbox", { name: "搜索番剧结果" });
  },
};

/** 出题选番后关联曲为空：浮层顶上一行「更换番剧」，下方说明匹配不到。 */
export const AnimeNoSongs: StoryObj<typeof AnimeSearch> = {
  name: "番剧 · 出题 · 没有关联曲",
  render: (args) => <AnimeSearch {...args} />,
  args: { mode: "submit", onSelect: fn(async () => {}) },
  beforeEach: () =>
    stubSongActions({
      searchBangumi: () => Promise.resolve(ANIME_SEARCH_RESULTS),
      resolveAnimeSongs: () => Promise.resolve(ANIME_SONG_CANDIDATES.slice(0, 0)),
      sendCommand: (() => pending()) as never,
    }),
  play: async ({ canvasElement }) => {
    await search(canvasElement, "夏空", "搜索番剧");
    await userEvent.click(await screen.findByRole("option", { name: /夏空旋律/ }));
    await screen.findByText("该番剧未匹配到可播放的关联歌曲");
  },
};
