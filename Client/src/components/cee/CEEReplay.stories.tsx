import type { Meta, StoryObj } from "@storybook/react-vite";
import { CEE_REPLAY_STORAGE_KEY, type ReplayRound } from "@/lib/CeeReplay";
import { STORY_PLAYERS } from "@/stories/fixtures/Common";
import { CEE_CHARACTERS, ceeGuess } from "@/stories/fixtures/CEE";
import { CEEReplay } from "./CEEReplay";

const [HOST, ME, PEACH] = STORY_PLAYERS;

/** 两回合：第一回合猜中，第二回合靠共同作品逐步逼近。 */
const TWO_ROUNDS: ReplayRound[] = [
  {
    number: 1,
    answer: CEE_CHARACTERS.nijika,
    guesses: [
      ceeGuess({ player: ME, character: "gojo", at: 6 }, "nijika"),
      ceeGuess({ player: PEACH, character: "ryo", at: 18 }, "nijika"),
      ceeGuess({ player: HOST, character: "nijika", at: 27 }, "nijika"),
    ],
  },
  {
    number: 2,
    answer: CEE_CHARACTERS.hitori,
    guesses: [
      ceeGuess({ player: HOST, character: "ikuyo", at: 40 }, "hitori"),
      ceeGuess({ player: ME, character: "hitori", at: 52 }, "hitori"),
    ],
  },
];

/**
 * 回放默认不对外可见（见 `lib/CeeReplay`）：故事里打开本地开关，展示面板本身。
 */
const meta = {
  title: "CEE/CEEReplay",
  component: CEEReplay,
  args: { rounds: TWO_ROUNDS },
  decorators: [
    (Story) => {
      window.localStorage.setItem(CEE_REPLAY_STORAGE_KEY, "1");
      return <div className="w-[36rem] max-w-full"><Story /></div>;
    },
  ],
} satisfies Meta<typeof CEEReplay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TwoRounds: Story = { name: "两回合 · 自动播放" };

export const Empty: Story = { name: "空局 · 尚未产生猜测", args: { rounds: [] } };
