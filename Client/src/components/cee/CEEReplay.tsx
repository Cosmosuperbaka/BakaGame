import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Pause, Play, RotateCcw, SkipBack, SkipForward } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { buildReplaySteps, isCeeReplayEnabled, type ReplayRound } from "@/lib/CeeReplay";
import { CEECharacterImage } from "./CEECharacterImage";
import { CEEFeedbackChips } from "./CEEFeedbackTable";

/** 每一步的停留时间：够看清角色与判定，又不至于让长局回放拖沓。 */
const STEP_MS = 1_200;

/**
 * 猜测回放：按时间顺序重演本局（可含多个回合）的每次猜测。
 *
 * 数据全部来自结算快照，不新增协议；开关默认关闭（见 `lib/CeeReplay`），
 * 关闭时整个面板不渲染，结算页其余部分不受影响。
 */
export function CEEReplay({ rounds }: { rounds: ReplayRound[] }) {
  const enabled = useMemo(() => isCeeReplayEnabled(), []);
  const steps = useMemo(() => buildReplaySteps(rounds), [rounds]);
  const [index, setIndex] = useState(0);
  // 组件按回合挂载（见结算区的 key），新回合结算即从头自动播放。
  const [playing, setPlaying] = useState(true);
  const total = steps.length;
  const atEnd = total > 0 && index >= total - 1;
  // 停在末条时按钮回到「播放」，再按即重播；不再于 effect 里为「播完」单独写状态。
  const active = playing && !atEnd;

  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(
      () => setIndex((current) => Math.min(current + 1, total - 1)),
      STEP_MS
    );
    return () => clearTimeout(timer);
  }, [active, index, total]);

  const jump = useCallback(
    (next: number) => {
      setPlaying(false);
      setIndex(Math.max(0, Math.min(next, total - 1)));
    },
    [total]
  );

  const toggle = useCallback(() => {
    // 停在结尾时再按播放视为重播。
    if (index >= total - 1) {
      setIndex(0);
      setPlaying(true);
      return;
    }
    setPlaying((current) => !current);
  }, [index, total]);

  if (!enabled) return null;

  const step = steps[index];
  if (!step)
    return (
      <section
        aria-label="猜测回放"
        className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground"
      >
        本局还没有记录到猜测
      </section>
    );

  const { guess } = step;
  const title = guess.character.nameCn || guess.character.name;

  return (
    <section aria-label="猜测回放" className="space-y-3 rounded-md border bg-panel p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <h3 className="font-semibold">猜测回放</h3>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          第 {step.round} 回合 · 第 {step.index} 次猜测 · {index + 1}/{total}
        </p>
      </div>

      <motion.div
        key={step.guess.id}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18 }}
        className="flex items-start gap-3"
      >
        <CEECharacterImage
          character={guess.character}
          size="grid"
          className="size-16 shrink-0 rounded-md bg-background"
        />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{title}</span>
            <span className="text-xs text-muted-foreground">{guess.playerName} 猜</span>
            {guess.correct ? (
              <Badge size="sm" variant="matched">
                猜中
              </Badge>
            ) : null}
            {!guess.correct && guess.partial ? (
              <Badge size="sm" variant="outline">
                接近
              </Badge>
            ) : null}
          </div>
          <CEEFeedbackChips feedback={guess.feedback} />
          {guess.feedback.sharedAppearances.length ? (
            <p className="truncate text-xs text-muted-foreground">
              共同作品{" "}
              {guess.feedback.sharedAppearances
                .map((subject) => subject.nameCn || subject.name)
                .join("、")}
            </p>
          ) : null}
        </div>
      </motion.div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="size-8"
          aria-label="上一条"
          disabled={index === 0}
          onClick={() => jump(index - 1)}
        >
          <SkipBack className="size-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="size-8"
          aria-label={active ? "暂停回放" : "播放回放"}
          onClick={toggle}
        >
          {active ? <Pause className="size-4" /> : <Play className="size-4" />}
        </Button>
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="size-8"
          aria-label="下一条"
          disabled={index >= total - 1}
          onClick={() => jump(index + 1)}
        >
          <SkipForward className="size-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="size-8"
          aria-label="从头重播"
          onClick={() => {
            setIndex(0);
            setPlaying(true);
          }}
        >
          <RotateCcw className="size-4" />
        </Button>
        <input
          type="range"
          min={0}
          max={Math.max(0, total - 1)}
          value={index}
          aria-label="回放进度"
          className="h-2 min-w-32 flex-1 accent-primary"
          onChange={(event) => jump(Number(event.target.value))}
        />
      </div>
    </section>
  );
}
