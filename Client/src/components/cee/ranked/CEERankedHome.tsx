import { AnimatePresence, motion } from "framer-motion";
import { useRef, useState } from "react";
import { Bot, Crown, History, ListOrdered, Search } from "lucide-react";
import type { CEERankedLeaderboard, CEERankedProfile, CEERankedState } from "@bakagame/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Collapsible } from "@/components/ui/Collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { useSecondsLeft, useSecondsSince } from "@/hooks/UseSecondsLeft";
import { dropIn, readoutTick } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { formatRankedClock } from "./CEERankedFormat";
import { CEERankedHistory } from "./CEERankedHistory";
import { CEERankedLeaderboardPanel } from "./CEERankedLeaderboard";
import { RankedRecentForm, RankedRecordMeter } from "./CEERankedMarks";

type QueuedState = Extract<CEERankedState, { status: "queued" }>;

/**
 * 分数区：定级中只给进度圆点，打满定级赛才亮出整数分（上榜时旁边挂全服名次）。
 * 胜负用胜负条与近况方块表达，不写成一串文字。
 */
function RatingSummary({
  profile,
  placementTotal,
  rank,
}: {
  profile: CEERankedProfile;
  placementTotal: number;
  rank: number | null;
}) {
  const placing = profile.rating === null;
  return (
    <div className="space-y-4">
      {placing ? (
        <div className="space-y-2">
          <span className="text-xs text-muted-foreground">定级赛</span>
          <ol
            className="flex gap-1.5"
            aria-label={`定级赛已完成 ${profile.placementPlayed} / ${placementTotal} 场`}
          >
            {Array.from({ length: placementTotal }, (_, index) => (
              <li
                key={index}
                aria-hidden="true"
                className={cn(
                  "h-2 flex-1 rounded-full border",
                  // 未完成的场次取前景色淡档空槽：只画 border 色描边在暗色卡片上约 1.3:1，五段几乎看不出。
                  index < profile.placementPlayed
                    ? "border-primary bg-primary"
                    : "border-transparent bg-foreground/10"
                )}
              />
            ))}
          </ol>
          <p className="text-sm text-muted-foreground">打满 {placementTotal} 场后显示分数</p>
        </div>
      ) : (
        <div className="flex items-end justify-between gap-3">
          <div>
            <span className="text-xs text-muted-foreground">排位分</span>
            <p className="font-serif text-5xl font-semibold tabular-nums">{profile.rating}</p>
          </div>
          {rank !== null ? (
            <Badge variant="active" className="mb-1.5 gap-1" aria-label={`全服第 ${rank} 名`}>
              <Crown className="size-3.5" aria-hidden="true" />
              <span className="font-mono tabular-nums">#{rank}</span>
            </Badge>
          ) : null}
        </div>
      )}
      <RankedRecordMeter wins={profile.wins} losses={profile.losses} draws={profile.draws} />
      <RankedRecentForm entries={profile.recent.slice(0, 10)} />
    </div>
  );
}

/** 排队中的读数：已等时长、匹配范围，满 10 秒出现「先打人机」，30 秒自动开人机。 */
function QueuePanel({
  queued,
  botUnrated,
  pendingCancel,
  pendingBot,
  onCancel,
  onPlayBot,
}: {
  queued: QueuedState;
  /** 今日计分的人机局已用完：主动或兜底进的人机局都不计分，排队时就要说清。 */
  botUnrated: boolean;
  pendingCancel: boolean;
  pendingBot: boolean;
  onCancel: () => void;
  onPlayBot: () => void;
}) {
  const elapsed = useSecondsSince(queued.queuedAt);
  const toFallback = useSecondsLeft(queued.botFallbackAt);
  const botReady = elapsed * 1000 >= queued.botAvailableAt - queued.queuedAt;
  return (
    <div className="space-y-3" role="status" aria-live="polite">
      <div className="flex items-center gap-2">
        <Search
          className="size-4 motion-safe:animate-breathe text-muted-foreground"
          aria-hidden="true"
        />
        <span className="text-sm">正在寻找分数相近的对手</span>
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={elapsed}
            initial={readoutTick.initial}
            animate={readoutTick.animate}
            transition={readoutTick.transition}
            className="ml-auto font-mono text-sm tabular-nums"
            aria-label={`已等待 ${elapsed} 秒`}
          >
            {formatRankedClock(elapsed)}
          </motion.span>
        </AnimatePresence>
      </div>
      <p className="text-xs text-muted-foreground">
        匹配范围 ±{queued.window} 分 ·{" "}
        {toFallback > 0 ? `${toFallback} 秒后自动匹配人机` : "正在匹配人机"}
        {botUnrated ? " · 今日人机局已不计分" : null}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={onCancel} loading={pendingCancel} disabled={pendingBot}>
          取消匹配
        </Button>
        <AnimatePresence initial={false}>
          {botReady ? (
            <motion.div key="bot" variants={dropIn} initial="initial" animate="animate" exit="exit">
              <Button
                variant="secondary"
                onClick={onPlayBot}
                loading={pendingBot}
                disabled={pendingCancel}
              >
                <Bot aria-hidden="true" />
                先打人机
              </Button>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}

/**
 * 排位首页：左边是分数与匹配，右边是「战绩 / 排行榜」两个标签页。
 * 空闲态给「开始匹配」（定级中写作「开始定级赛」，对手都是人机），排队态原地换成排队读数。
 */
export function CEERankedHome({
  profile,
  state,
  placementTotal,
  pending,
  historyLoading = false,
  leaderboard = null,
  onQueue,
  onCancel,
  onPlayBot,
  onLoadMoreHistory = () => {},
  onOpenLeaderboard = () => {},
}: {
  profile: CEERankedProfile | null;
  state: Extract<CEERankedState, { status: "idle" | "queued" }>;
  placementTotal: number;
  pending: { queue?: boolean; cancel?: boolean; playBot?: boolean };
  historyLoading?: boolean;
  leaderboard?: CEERankedLeaderboard | null;
  onQueue: () => void;
  onCancel: () => void;
  onPlayBot: () => void;
  onLoadMoreHistory?: () => void;
  /** 切到排行榜标签时调用：服务端有短缓存，每次切过去都现取一次。 */
  onOpenLeaderboard?: () => void;
}) {
  const placing = profile?.rating === null;
  const [tab, setTab] = useState("history");
  const tabRef = useRef(tab);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <section
        aria-label="我的排位"
        className="space-y-5 self-start rounded-md border bg-card p-5 shadow-sm"
      >
        {profile ? (
          <RatingSummary
            profile={profile}
            placementTotal={placementTotal}
            rank={leaderboard?.self?.rank ?? null}
          />
        ) : (
          <div
            className="h-28 motion-safe:animate-breathe rounded-md bg-muted"
            aria-label="正在读取排位资料"
          />
        )}
        <AnimatePresence initial={false} mode="popLayout">
          {state.status === "queued" ? (
            <motion.div
              key="queued"
              variants={dropIn}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              <QueuePanel
                queued={state}
                botUnrated={
                  profile !== null &&
                  profile.rating !== null &&
                  profile.botRatedToday >= profile.botRatedLimit
                }
                pendingCancel={Boolean(pending.cancel)}
                pendingBot={Boolean(pending.playBot)}
                onCancel={onCancel}
                onPlayBot={onPlayBot}
              />
            </motion.div>
          ) : (
            <motion.div
              key="idle"
              variants={dropIn}
              initial="initial"
              animate="animate"
              exit="exit"
              className="space-y-2"
            >
              <Button
                size="lg"
                className="w-full"
                onClick={onQueue}
                loading={Boolean(pending.queue)}
                disabled={!profile}
              >
                {placing ? "开始定级赛" : "开始匹配"}
              </Button>
              {placing ? (
                <p className="text-xs text-muted-foreground">
                  定级赛的对手都是人机，打满 {placementTotal} 场后开始匹配真人。
                </p>
              ) : null}
            </motion.div>
          )}
        </AnimatePresence>
        {/* 规则是卡片的页脚：分隔线另起一节；标题与条目同为 sm，展开间距交给 Collapsible 自己的内边距 */}
        <Collapsible title="规则" className="border-t pt-4">
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>三局两胜：每局双方猜同一个角色，先猜中者赢下这局，先赢两局者胜。</li>
            <li>一局双方都没猜中就不算，加赛一局，直到有人赢满两局。</li>
            <li>每局 3 分钟、各 10 次；都没猜中进入 45 秒加时，各加 2 次并公开一条提示。</li>
            <li>你看得到对手每次猜测的方向与远近，看不到猜了谁；对手看你也一样。</li>
            <li>题库难度随分数升档；匹配不到真人时由人机补位，人机会明确标出。</li>
            <li>中途退出或掉线超过 90 秒判负整场。</li>
          </ul>
        </Collapsible>
      </section>
      <section
        aria-label="战绩与排行"
        className="min-w-0 rounded-md border bg-panel px-5 pt-3 pb-2"
      >
        <Tabs
          value={tab}
          onValueChange={(value) => {
            // 点按标签时按下与聚焦各报一次同一个值：只在真正切换时现取榜单。
            if (value === tabRef.current) return;
            tabRef.current = value;
            setTab(value);
            if (value === "leaderboard") onOpenLeaderboard();
          }}
        >
          <TabsList className="mb-1 w-full">
            <TabsTrigger value="history" className="gap-1.5">
              <History className="size-4" aria-hidden="true" />
              战绩
            </TabsTrigger>
            <TabsTrigger value="leaderboard" className="gap-1.5">
              <ListOrdered className="size-4" aria-hidden="true" />
              排行榜
            </TabsTrigger>
          </TabsList>
          <TabsContent value="history">
            <CEERankedHistory
              entries={profile?.recent ?? null}
              hasMore={profile?.recentHasMore ?? false}
              loading={historyLoading}
              onLoadMore={onLoadMoreHistory}
            />
          </TabsContent>
          <TabsContent value="leaderboard" className="py-3">
            <CEERankedLeaderboardPanel leaderboard={leaderboard} />
          </TabsContent>
        </Tabs>
      </section>
    </div>
  );
}
