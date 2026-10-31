import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { Bot, Search } from "lucide-react";
import type { CEERankedHistoryEntry, CEERankedProfile, CEERankedState } from "@bakagame/shared";
import { ceeRankedTier } from "@bakagame/shared/values";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Collapsible } from "@/components/ui/Collapsible";
import { useSecondsLeft } from "@/hooks/UseSecondsLeft";
import { dropIn, listContainer, listItem, readoutTick, skeletonFade } from "@/lib/Motion";
import { formatRelativeTime } from "@/lib/Time";
import { cn } from "@/lib/Utils";
import { formatRankedClock, formatRankedPoints } from "./RankedFormat";

type QueuedState = Extract<CEERankedState, { status: "queued" }>;

/** 已排队的整秒数；只在跨秒时写入，避免心跳里白跑渲染。 */
function useElapsedSeconds(since: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(
      () =>
        setNow((current) =>
          Math.floor((current - since) / 1000) === Math.floor((Date.now() - since) / 1000)
            ? current
            : Date.now()
        ),
      250
    );
    return () => window.clearInterval(timer);
  }, [since]);
  return Math.max(0, Math.floor((now - since) / 1000));
}

/** 分数区：定级中只给进度，打满定级赛才亮出整数分。 */
function RatingSummary({
  profile,
  placementTotal,
}: {
  profile: CEERankedProfile;
  placementTotal: number;
}) {
  const placing = profile.rating === null;
  return (
    <div className="space-y-2">
      <span className="text-xs text-muted-foreground">{placing ? "定级赛" : "排位分"}</span>
      {placing ? (
        <div className="space-y-2">
          <ol className="flex gap-1.5" aria-hidden="true">
            {Array.from({ length: placementTotal }, (_, index) => (
              <li
                key={index}
                className={cn(
                  "size-3 rounded-full border",
                  index < profile.placementPlayed ? "border-primary bg-primary" : "border-border"
                )}
              />
            ))}
          </ol>
          <p className="text-sm">
            已完成 {profile.placementPlayed} / {placementTotal} 场，打满后显示分数
          </p>
        </div>
      ) : (
        <p className="font-serif text-5xl font-semibold tabular-nums">{profile.rating}</p>
      )}
      <p className="text-sm text-muted-foreground">
        胜 {profile.wins} · 负 {profile.losses} · 平 {profile.draws}
        {placing ? null : (
          <>
            {" "}
            · 今日人机计分 {Math.min(profile.botRatedToday, profile.botRatedLimit)} /{" "}
            {profile.botRatedLimit}
          </>
        )}
      </p>
    </div>
  );
}

/** 排队中的读数：已等时长、匹配范围，满 10 秒出现「先打人机」，30 秒自动开人机。 */
function QueuePanel({
  queued,
  pendingCancel,
  pendingBot,
  onCancel,
  onPlayBot,
}: {
  queued: QueuedState;
  pendingCancel: boolean;
  pendingBot: boolean;
  onCancel: () => void;
  onPlayBot: () => void;
}) {
  const elapsed = useElapsedSeconds(queued.queuedAt);
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

const OUTCOME = {
  won: { label: "胜", variant: "matched" },
  lost: { label: "负", variant: "muted" },
  drawn: { label: "平", variant: "subtle" },
} as const;

function HistoryRow({ entry }: { entry: CEERankedHistoryEntry }) {
  const outcome = OUTCOME[entry.outcome];
  return (
    <motion.li variants={listItem} className="flex items-center gap-2 py-2 text-sm">
      <Badge variant={outcome.variant} size="sm" className="w-6 justify-center">
        {outcome.label}
      </Badge>
      <span className="w-14 shrink-0 font-mono text-xs tabular-nums">
        {formatRankedPoints(entry.selfPoints)} : {formatRankedPoints(entry.opponentPoints)}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {entry.opponentName}
        {entry.opponentIsBot ? (
          <Badge variant="subtle" size="xs" className="ml-1.5 align-middle">
            人机
          </Badge>
        ) : null}
      </span>
      <span className="hidden text-xs text-muted-foreground sm:inline">
        {ceeRankedTier(entry.tierId).name}
      </span>
      <span
        className={cn(
          "w-12 shrink-0 text-right font-mono text-xs tabular-nums",
          entry.ratingDelta !== null && entry.ratingDelta > 0
            ? "text-success"
            : "text-muted-foreground"
        )}
      >
        {entry.placement
          ? "定级"
          : entry.ratingDelta === null
            ? "—"
            : entry.ratingDelta > 0
              ? `+${entry.ratingDelta}`
              : entry.ratingDelta}
      </span>
      <span className="hidden w-16 shrink-0 text-right text-xs text-muted-foreground md:inline">
        {formatRelativeTime(new Date(entry.endedAt).toISOString())}
      </span>
    </motion.li>
  );
}

/**
 * 排位首页：左边是分数与匹配，右边是最近战绩。
 * 空闲态给「开始匹配」（定级中写作「开始定级赛」，对手都是人机），排队态原地换成排队读数。
 */
export function RankedHome({
  profile,
  state,
  placementTotal,
  pending,
  onQueue,
  onCancel,
  onPlayBot,
}: {
  profile: CEERankedProfile | null;
  state: Extract<CEERankedState, { status: "idle" | "queued" }>;
  placementTotal: number;
  pending: { queue?: boolean; cancel?: boolean; playBot?: boolean };
  onQueue: () => void;
  onCancel: () => void;
  onPlayBot: () => void;
}) {
  const placing = profile?.rating === null;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <section aria-label="我的排位" className="space-y-5 rounded-md border bg-card p-5 shadow-sm">
        {profile ? (
          <RatingSummary profile={profile} placementTotal={placementTotal} />
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
        <Collapsible title="规则" size="sm">
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>三局两胜：每局双方猜同一个角色，先猜中者得 1 分，平局各得半分。</li>
            <li>每局 3 分钟、各 10 次；都没猜中进入 45 秒加时，各加 2 次并公开一条提示。</li>
            <li>你看得到对手每次猜测的方向与远近，看不到猜了谁；对手看你也一样。</li>
            <li>题库难度随分数升档；匹配不到真人时由人机补位，人机会明确标出。</li>
            <li>中途退出或掉线超过 90 秒判负整场。</li>
          </ul>
        </Collapsible>
      </section>
      <section aria-label="最近战绩" className="rounded-md border bg-panel p-5">
        <h2 className="mb-2 font-serif text-base font-semibold">最近战绩</h2>
        <AnimatePresence initial={false} mode="popLayout">
          {profile === null ? (
            <motion.div
              key="loading"
              exit={skeletonFade.exit}
              className="space-y-2"
              aria-hidden="true"
            >
              {[0, 1, 2].map((index) => (
                <div key={index} className="h-8 motion-safe:animate-breathe rounded-md bg-muted" />
              ))}
            </motion.div>
          ) : profile.recent.length ? (
            <motion.ol
              key="list"
              variants={listContainer(profile.recent.length)}
              initial="initial"
              animate="animate"
              className="divide-y"
            >
              {profile.recent.map((entry) => (
                <HistoryRow key={entry.seriesId} entry={entry} />
              ))}
            </motion.ol>
          ) : (
            <motion.p
              key="empty"
              className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground"
            >
              还没有排位记录，打完第一场后显示在这里
            </motion.p>
          )}
        </AnimatePresence>
      </section>
    </div>
  );
}
