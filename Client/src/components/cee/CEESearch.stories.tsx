import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, screen, userEvent, within } from "storybook/test";
import type { CEECharacterSummary, CEESubjectSummary } from "@bakagame/shared";
import { presetCEE } from "@/stories/StorePresets";
import { CEE_CHARACTERS } from "@/stories/fixtures/CEE";
import { useCEEStore } from "@/stores/UseCEEStore";
import { CEESearch, CEESubjectSearch } from "./CEESearch";

const { nijika, hitori, ryo, ikuyo, kikuri } = CEE_CHARACTERS;
const CHARACTERS: CEECharacterSummary[] = [hitori, nijika, ryo, ikuyo, kikuri].map(
  ({ id, name, nameCn, imageUrl }) => ({ id, name, nameCn, imageUrl })
);
/** 封面留空：作品行退回条目类型图标，搜索下拉里两种媒体都看得到。 */
const subject = (id: number, name: string, nameCn: string, type: number, year: number) =>
  ({ id, name, nameCn, type, year, rating: 0, heat: 0 }) satisfies CEESubjectSummary;
const SUBJECTS: CEESubjectSummary[] = [
  subject(328609, "ぼっち・ざ・ろっく！", "孤独摇滚！", 2, 2022),
  subject(1424, "けいおん！", "轻音少女", 2, 2009),
  subject(9001, "ぼっち・ざ・ろっく！ アンソロジー", "", 1, 2023),
  subject(9002, "結束バンド", "结束乐队", 3, 2022),
];

/** 输入关键词并立即查询（等同回车），浮层出现后停下。 */
async function search(canvasElement: HTMLElement, keyword: string, mode = "搜角色") {
  const canvas = within(canvasElement);
  await userEvent.type(canvas.getByRole("combobox"), keyword);
  await userEvent.click(canvas.getByRole("button", { name: mode }));
}

/** 角色搜索：搜索栏、浮层结果与状态行。故事给足下方空间，浮层不必翻到上方。 */
const meta = {
  title: "CEE/CEESearch",
  component: CEESearch,
  args: { allowSubjects: true, onSelect: fn(async () => true) },
  beforeEach: () => {
    presetCEE({ connected: true });
    useCEEStore.setState({
      searchCharacters: async () => CHARACTERS,
      searchSubjects: async () => SUBJECTS,
      loadSubjectCharacters: async () => CHARACTERS.slice(0, 3),
    });
  },
  decorators: [
    (Story) => (
      <div className="mx-auto min-h-[26rem] w-[36rem] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CEESearch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = { name: "空" };

export const Disabled: Story = { name: "禁用", args: { disabled: true } };

export const Results: Story = {
  name: "角色结果 · 已被选择",
  args: { bannedIds: [nijika.id] },
  play: async ({ canvasElement }) => {
    await search(canvasElement, "结束乐队");
    await screen.findByRole("listbox");
  },
};

export const KeyboardHighlight: Story = {
  name: "角色结果 · 键盘高亮",
  play: async ({ canvasElement }) => {
    await search(canvasElement, "结束乐队");
    await screen.findByRole("listbox");
    await userEvent.click(within(canvasElement).getByRole("combobox"));
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
  },
};

export const Searching: Story = {
  name: "搜索中",
  beforeEach: () => {
    useCEEStore.setState({ searchCharacters: () => new Promise<never>(() => {}) });
  },
  play: async ({ canvasElement }) => {
    await search(canvasElement, "虹夏");
    await screen.findByText("正在搜索角色");
  },
};

export const NoResult: Story = {
  name: "无结果",
  beforeEach: () => {
    useCEEStore.setState({ searchCharacters: async () => [] });
  },
  play: async ({ canvasElement }) => {
    await search(canvasElement, "不存在的角色");
    await screen.findByText("没有找到符合条件的结果");
  },
};

export const SearchFailed: Story = {
  name: "搜索失败",
  beforeEach: () => {
    useCEEStore.setState({
      searchCharacters: () => Promise.reject(new Error("搜索服务暂时不可用")),
    });
  },
  play: async ({ canvasElement }) => {
    await search(canvasElement, "虹夏");
    await screen.findByText("搜索服务暂时不可用");
  },
};

export const SubjectResults: Story = {
  name: "作品结果",
  args: { defaultMode: "subject" },
  play: async ({ canvasElement }) => {
    await search(canvasElement, "孤独摇滚", "搜作品");
    await screen.findByRole("listbox");
  },
};

export const SubjectCast: Story = {
  name: "作品里的角色",
  args: { defaultMode: "subject" },
  play: async ({ canvasElement }) => {
    await search(canvasElement, "孤独摇滚", "搜作品");
    const listbox = await screen.findByRole("listbox");
    await userEvent.click(within(listbox).getAllByRole("option")[0]!);
    await screen.findByText("返回作品");
  },
};

/** 设置里的追加作品搜索：已加入的作品原地置灰并标「已添加」。 */
export const SubjectAdd: StoryObj<typeof CEESubjectSearch> = {
  name: "追加作品 · 已添加",
  render: () => <CEESubjectSearch addedIds={[1424]} onAdd={fn()} />,
  beforeEach: () => {
    useCEEStore.setState({ searchSubjects: async () => SUBJECTS });
  },
  play: async ({ canvasElement }) => {
    await userEvent.type(within(canvasElement).getByRole("combobox"), "孤独摇滚{Enter}");
    await screen.findByRole("listbox");
  },
};
