import { useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "./Button";
import { Collapsible } from "./Collapsible";
import { PresenceBoundary } from "./PresenceBoundary";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./Tabs";
import { SettingsSection } from "@/components/common/room/settings/Layout";
import { CEERankedHistory } from "@/components/cee/ranked/CEERankedHistory";
import { CEERankedLeaderboardPanel } from "@/components/cee/ranked/CEERankedLeaderboard";
import { CEERankedScoreboard } from "@/components/cee/ranked/CEERankedScoreboard";
import { rankedLeaderboard, rankedProfile, rankedSeries } from "@/stories/fixtures/CEERanked";
import { dropIn } from "@/lib/motion/NamedMoves";
import { listItem } from "@/lib/motion/Choreography";

/**
 * 「挂载时已有内容、之后再追加」：容器首屏就在（`AnimatePresence initial={false}` 的首个子项），
 * 点按钮往里追加一项。追加的那一项应当照常以 `listItem` 推上来，而不是直接出现。
 */
function Appending({ children }: { children: (list: ReactNode) => ReactNode }) {
  const [count, setCount] = useState(2);
  const list = (
    <ul className="flex flex-wrap gap-2">
      {Array.from({ length: count }, (_, index) => (
        <motion.li
          key={index}
          variants={listItem}
          initial="initial"
          animate="animate"
          className="rounded-md border bg-muted px-3 py-1.5 text-sm"
        >
          第 {index + 1} 项
        </motion.li>
      ))}
    </ul>
  );
  return (
    <div className="w-[28rem] space-y-3">
      <Button size="sm" onClick={() => setCount((value) => value + 1)}>
        追加一项
      </Button>
      {children(list)}
    </div>
  );
}

const meta = {
  title: "基础控件/PresenceBoundary",
  tags: ["no-shot"],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const InTabs: Story = {
  name: "标签页内追加",
  render: () => (
    <Appending>
      {(list) => (
        <Tabs defaultValue="a">
          <TabsList className="mb-4">
            <TabsTrigger value="a">第一页</TabsTrigger>
            <TabsTrigger value="b">第二页</TabsTrigger>
          </TabsList>
          <TabsContent value="a">{list}</TabsContent>
          <TabsContent value="b">
            <p className="text-sm text-muted-foreground">第二页</p>
          </TabsContent>
        </Tabs>
      )}
    </Appending>
  ),
};

export const InCollapsible: Story = {
  name: "默认展开的折叠区内追加",
  render: () => (
    <Appending>
      {(list) => (
        <Collapsible title="已展开" defaultOpen>
          {list}
        </Collapsible>
      )}
    </Appending>
  ),
};

export const InSettingsSection: Story = {
  name: "设置组内追加",
  render: () => (
    <Appending>{(list) => <SettingsSection title="设置组">{list}</SettingsSection>}</Appending>
  ),
};

/** 战绩列表首屏就有条目（回到排位首页时沿用已取到的战绩），再往前翻一页。 */
function HistoryAppending() {
  const base = rankedProfile("rated").recent;
  const [pages, setPages] = useState(1);
  const entries = Array.from({ length: pages }, (_, page) =>
    base.map((entry) => ({ ...entry, seriesId: `${entry.seriesId}-${page}` }))
  ).flat();
  return (
    <div className="w-[28rem]">
      <CEERankedHistory
        entries={entries}
        hasMore
        loading={false}
        onLoadMore={() => setPages((value) => value + 1)}
      />
    </div>
  );
}

export const InRankedHistory: Story = {
  name: "排位战绩内追加",
  render: () => <HistoryAppending />,
};

/** 排行榜首屏就有（沿用上次取到的榜），重新打开后多出一名。 */
function LeaderboardAppending() {
  const full = rankedLeaderboard();
  const [count, setCount] = useState(5);
  return (
    <div className="w-[28rem] space-y-3">
      <Button size="sm" onClick={() => setCount((value) => value + 1)}>
        追加一项
      </Button>
      <CEERankedLeaderboardPanel leaderboard={{ ...full, entries: full.entries.slice(0, count) }} />
    </div>
  );
}

export const InRankedLeaderboard: Story = {
  name: "排行榜内追加",
  render: () => <LeaderboardAppending />,
};

/**
 * 排位页刷新后直接落在系列赛里：系列赛整块是页面 `AnimatePresence initial={false}` 的首个子项（结构同 `CEERankedPage`）。
 * 这一局打完，比分板上这一局的圆点换成胜负标记，应当带一次回弹落位。
 */
function SeriesAppending() {
  const playing = rankedSeries("playing");
  const [finished, setFinished] = useState(false);
  const series = finished
    ? {
        ...playing,
        games: [...playing.games, { ...playing.games[0], number: 2, winner: "self" as const }],
      }
    : playing;
  return (
    <div className="w-[40rem] space-y-3">
      <Button size="sm" onClick={() => setFinished(true)}>
        这一局结束
      </Button>
      <AnimatePresence initial={false}>
        <motion.div key="series" variants={dropIn} initial="initial" animate="animate">
          <PresenceBoundary>
            <CEERankedScoreboard series={series} />
          </PresenceBoundary>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

export const InRankedSeries: Story = {
  name: "排位系列赛内换局",
  render: () => <SeriesAppending />,
};
