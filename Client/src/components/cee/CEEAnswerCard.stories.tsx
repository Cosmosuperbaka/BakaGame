import type { Meta, StoryObj } from "@storybook/react-vite";
import { CEE_CHARACTERS } from "@/stories/fixtures/CEE";
import { dropFocus } from "@/stories/PlayHelpers";
import { CEEAnswerCard } from "./CEEAnswerCard";

/** Bangumi 维基的简介常见写法：换行分段、加粗、剧透遮罩与引用，长到需要截断。 */
const LONG_SUMMARY = [
  "下北泽高中二年级学生，[b]结束乐队[/b]的鼓手兼队长。",
  "性格开朗、很会照顾人，是乐队里调和气氛的存在。在 Live House「STARRY」打工，店长是她的姐姐伊地知星歌。",
  "梦想是让乐队站上更大的舞台，为此一直在默默地努力。[mask]其实最初组建乐队，是为了替姐姐完成未竟的心愿。[/mask]",
  "[quote]「我想看到大家一起站在舞台上的样子。」[/quote]",
].join("\n");

const nijika = CEE_CHARACTERS.nijika;
const yui = CEE_CHARACTERS.yui;

const meta = {
  title: "CEE/CEEAnswerCard",
  component: CEEAnswerCard,
  args: { answer: nijika },
  decorators: [
    (Story) => (
      <div className="w-[36rem] max-w-full rounded-md border bg-panel p-4 sm:p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CEEAnswerCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = { name: "调试", tags: ["no-shot"] };

/** 简介不长：资料表第三行直接放下全文，不出现展开箭头。 */
export const WithSummary: Story = { name: "有简介" };

/** 没有简介：资料表只有作品与声优两行。 */
export const WithoutSummary: Story = {
  name: "无简介",
  args: { answer: CEE_CHARACTERS.hitori },
};

/** 简介很长：默认收成三行、行尾省略，右上角箭头展开。 */
export const LongSummary: Story = {
  name: "简介很长 · 收起",
  args: { answer: { ...nijika, summary: LONG_SUMMARY } },
};

/** 展开全文：段落、加粗、剧透遮罩与引用都在资料行里排开，箭头翻转朝上。 */
export const LongSummaryExpanded: Story = {
  name: "简介很长 · 展开",
  args: { answer: { ...nijika, summary: LONG_SUMMARY } },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: "展开角色简介" }));
    dropFocus();
  },
};

/** 作品与声优很多：作品徽章折行、过长的书名截断，声优按顿号连成一段自然折行。 */
export const ManyCredits: Story = {
  name: "作品与声优很多",
  args: {
    answer: {
      ...yui,
      summary: LONG_SUMMARY,
      appearances: [
        ...yui.appearances,
        {
          id: 99001,
          name: "けいおん！ Shuffle 特別編 ～放課後ティータイムの長い長い夏休み～",
          nameCn: "轻音少女 Shuffle 特别篇 ～放学后茶会漫长的暑假～",
          year: 2024,
          rating: 7.1,
          ratingCount: 820,
        },
      ],
      voiceActors: ["丰崎爱生", "日笠阳子", "佐藤聪美", "寿美菜子", "竹达彩奈", "真田麻美"],
    },
  },
};

/** 本局揭晓：卡片沉一下再抬起亮相（截图取落定后的终态）。 */
export const Sealed: Story = {
  name: "揭晓态",
  args: { answer: { ...nijika, summary: LONG_SUMMARY }, sealed: true },
};

/** 手机宽度：图片在上、文字居中，资料表仍是左列字段名、右列内容。 */
export const Narrow: Story = {
  name: "窄屏",
  tags: ["page", "mobile"],
  args: { answer: { ...nijika, summary: LONG_SUMMARY } },
};
