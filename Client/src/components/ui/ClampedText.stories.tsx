import type { Meta, StoryObj } from "@storybook/react-vite";
import { ClampedText } from "./ClampedText";

const LONG_SUMMARY =
  "下北泽高中二年级学生，结束乐队的鼓手兼队长。性格开朗、很会照顾人，是乐队里调和气氛的存在。" +
  "在 STARRY 打工，和姐姐伊地知星歌一起经营着这家 Live House。梦想是让乐队站上更大的舞台，" +
  "为此一直在默默地努力，也常常替不善言辞的后藤一里打圆场。";

const meta = {
  title: "基础控件/ClampedText",
  component: ClampedText,
  args: {
    label: "角色简介",
    lines: 3,
    className: "text-sm leading-relaxed",
    children: LONG_SUMMARY,
  },
  decorators: [
    (Story) => (
      <div className="w-80 rounded-md bg-muted p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ClampedText>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = { name: "调试", tags: ["no-shot"] };

/** 放不下时默认收成三行、行尾省略，右上角出现展开箭头。 */
export const Collapsed: Story = { name: "收起" };

/** 展开全文，箭头翻转朝上，用来收起。 */
export const Expanded: Story = { name: "展开", args: { defaultExpanded: true } };

/** 放得下时不出现箭头，也不给右侧留白。 */
export const Fits: Story = {
  name: "放得下",
  args: { children: "结束乐队的鼓手兼队长。" },
};

/** 密集区域（CEE 反馈表的共同作品）：两行、xs 字号，箭头随所在行取成功色。 */
export const Dense: Story = {
  name: "密集区域 · 两行",
  args: {
    label: "共同作品",
    lines: 2,
    className: "text-xs text-success",
    toggleClassName: "text-success",
    children:
      "共同作品：孤独摇滚！、剧场总集篇 孤独摇滚！ Re:、剧场总集篇 孤独摇滚！ Re:Re:、孤独摇滚！ 第二季、孤独摇滚！ 音乐专辑",
  },
};
