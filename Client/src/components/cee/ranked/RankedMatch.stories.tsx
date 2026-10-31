import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import type { CEERankedSeriesView } from "@bakagame/shared";
import { rankedSeries } from "@/stories/fixtures/CEERanked";
import { RankedGameRecap } from "./RankedGameRecap";
import { RankedMatch } from "./RankedMatch";
import { RankedScoreboard } from "./RankedScoreboard";

/** 对局页的上下两段：顶栏比分 + 进行中的一局（或局间复盘），与排位页同一组合。 */
function RankedTable({
  series,
  onGuess,
  onSurrender,
  onExit,
}: {
  series: CEERankedSeriesView;
  onGuess: (characterId: number) => Promise<boolean>;
  onSurrender: () => void;
  onExit: () => void;
}) {
  const last = series.games.at(-1);
  return (
    <div className="space-y-4">
      <RankedScoreboard series={series} />
      {series.phase === "intermission" && last ? (
        <RankedGameRecap game={last} reveal />
      ) : (
        <RankedMatch
          series={series}
          pending={{}}
          onGuess={onGuess}
          onSurrender={onSurrender}
          onExit={onExit}
        />
      )}
    </div>
  );
}

const meta = {
  title: "CEE/Ranked/对局",
  component: RankedTable,
  args: {
    series: rankedSeries("playing"),
    onGuess: fn(async () => true),
    onSurrender: fn(),
    onExit: fn(),
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[72rem] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RankedTable>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Countdown: Story = {
  name: "第 1 局读秒",
  args: { series: rankedSeries("countdown") },
};
export const Playing: Story = { name: "第 2 局进行中 · 对手落后一手" };
export const Overtime: Story = {
  name: "第 3 局加时 · 本人次数用尽",
  args: {
    series: (() => {
      const series = rankedSeries("overtime");
      return { ...series, self: { ...series.self, attempts: 12, finished: true } };
    })(),
  },
};
export const Intermission: Story = {
  name: "局间复盘",
  args: { series: rankedSeries("intermission") },
};
export const OpponentOffline: Story = {
  name: "真人对手掉线",
  args: {
    series: (() => {
      const series = rankedSeries("playing");
      return {
        ...series,
        opponent: {
          ...series.opponent,
          isBot: false,
          name: "凉宫同学",
          rating: 1588,
          online: false,
        },
      };
    })(),
  },
};
export const Narrow: Story = {
  name: "窄屏",
  globals: { viewport: { value: "mobile", isRotated: false } },
};
