import type { Meta, StoryObj } from "@storybook/react-vite";
import type { CCBGuess } from "@bakagame/shared";
import { STORY_PLAYERS } from "@/stories/fixtures/Common";
import { ccbGuess } from "@/stories/fixtures/CCB";
import { CCBFeedbackTable } from "./CCBFeedbackTable";

const [HOST, ME, PEACH] = STORY_PLAYERS;

/** 答案是伊地知虹夏：同作品角色作品数与年份相同、标签部分命中，跨作品角色多为远档，最后一次猜中。 */
const ROUND: CCBGuess[] = [
  ccbGuess({ player: ME, character: "gojo", at: 10 }, "nijika"),
  ccbGuess({ player: PEACH, character: "yui", at: 22 }, "nijika"),
  ccbGuess({ player: ME, character: "ryo", at: 31 }, "nijika"),
  ccbGuess({ player: HOST, character: "ikuyo", at: 40 }, "nijika"),
  ccbGuess({ player: PEACH, character: "nijika", at: 52 }, "nijika"),
];

/** 未知评分、被他人先发现的标签与游戏专属标签：反馈里不可比较或已隐藏的几种写法。 */
const EDGE_CASES: CCBGuess[] = [{
  ...ROUND[2]!,
  id: "edge",
  feedback: {
    ...ROUND[2]!.feedback,
    rating: { value: -1, comparison: "?" },
    tags: ROUND[2]!.feedback.tags.map((tag, index) => (index === 1 ? { ...tag, text: "???", matched: false, hidden: true } : tag)),
    extraTags: [{ section: "乐队担当", tags: [{ text: "贝斯", matched: false }, { text: "作曲", matched: true }] }],
  },
}];

const meta = {
  title: "CCB/CCBFeedbackTable",
  component: CCBFeedbackTable,
  args: { guesses: ROUND, showRound: false },
  // 与 1440 宽房间页的游戏区同宽：表格在区内横向滚动，角色列贴住左缘。
  decorators: [(Story) => <div className="w-[36rem] max-w-full"><Story /></div>],
} satisfies Meta<typeof CCBFeedbackTable>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllTones: Story = { name: "一局猜测 · 全部档位" };

export const SyncRounds: Story = {
  name: "同步模式 · 标出轮次",
  args: {
    showRound: true,
    guesses: ROUND.slice(0, 3).map((guess, index) => ({ ...guess, syncRound: index + 1 })),
  },
};

export const EdgeCases: Story = { name: "未知评分与隐藏标签", args: { guesses: EDGE_CASES } };

/** 手机宽度：容器窄于 30rem 时收起头像、收窄角色列。 */
export const Narrow: Story = {
  name: "窄容器 · 收起头像",
  decorators: [(Story) => <div className="w-[20rem]"><Story /></div>],
};

export const Empty: Story = { name: "尚无猜测", args: { guesses: [] } };
