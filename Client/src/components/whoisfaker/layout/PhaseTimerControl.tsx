import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Clock, Play, Timer, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/SegmentedControl";
import { useMeasuredHeight } from "@/hooks/UseMeasuredHeight";
import { countdownTickMs, dropIn, readoutSwap, spring, urgentPulse } from "@/lib/Motion";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { cn } from "@/lib/Utils";

const DURATION_OPTIONS: SegmentedOption<string>[] = [
  { label: "1分钟", value: "60" },
  { label: "2分钟", value: "120" },
  { label: "3分钟", value: "180" },
];

interface Props {
  className?: string;
  onTimeout?: () => void;
}

export function PhaseTimerControl({ className, onTimeout }: Props) {
  const snapshot = useWhoIsFakerStore((s) => s.snapshot);
  const privateState = useWhoIsFakerStore((s) => s.privateState);
  const sendCommand = useWhoIsFakerStore((s) => s.sendCommand);
  const addToast = useWhoIsFakerStore((s) => s.addToast);
  const triggerPhaseTimeout = useWhoIsFakerStore((s) => s.triggerPhaseTimeout);

  const [selectedDuration, setSelectedDuration] = useState<number>(60);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const firedTimeoutForEndsAt = useRef<number | null>(null);

  const phase = snapshot?.status.phase;
  const phaseTimer = snapshot?.status.phaseTimer;

  // 选择出题人、出题阶段、等待中和结算阶段不支持设置倒计时
  const isSupportedPhase =
    phase !== undefined &&
    phase !== "assigningQuestioner" &&
    phase !== "wordSubmission" &&
    phase !== "waiting" &&
    phase !== "gameOver";

  const isQuestioner = privateState?.isQuestioner ?? false;
  const isTestRoomHost = Boolean(snapshot?.testMode && snapshot?.hostPlayerId === privateState?.playerId);
  const canControl = (isQuestioner || isTestRoomHost) && isSupportedPhase;

  // 毫秒级倒计时平滑时钟
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!phaseTimer) {
      firedTimeoutForEndsAt.current = null;
      return;
    }
    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, countdownTickMs);
    return () => window.clearInterval(interval);
  }, [phaseTimer]);

  const remainingMs = phaseTimer ? Math.max(0, phaseTimer.endsAt - now) : 0;
  const remainingSec = Math.ceil(remainingMs / 1000);
  const totalSec = phaseTimer?.durationSeconds ?? 60;
  const percent = phaseTimer
    ? Math.max(0, Math.min(100, (remainingMs / (totalSec * 1000)) * 100))
    : 0;

  // 倒计时归零时触发 store 动作与本地回调，供输入框自动提交草稿
  useEffect(() => {
    if (!phaseTimer) return;
    if (remainingMs <= 0 && firedTimeoutForEndsAt.current !== phaseTimer.endsAt) {
      firedTimeoutForEndsAt.current = phaseTimer.endsAt;
      triggerPhaseTimeout();
      onTimeout?.();
    }
  }, [phaseTimer, remainingMs, triggerPhaseTimeout, onTimeout]);

  const handleStartTimer = useCallback(async () => {
    setStarting(true);
    try {
      await sendCommand("game.startPhaseTimer", { durationSeconds: selectedDuration });
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    } finally {
      setStarting(false);
    }
  }, [selectedDuration, sendCommand, addToast]);

  const handleStopTimer = useCallback(async () => {
    setStopping(true);
    try {
      await sendCommand("game.stopPhaseTimer", {});
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    } finally {
      setStopping(false);
    }
  }, [sendCommand, addToast]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  // 警示色阶：<=10秒为严重警示（红），<=30秒为警告（琥珀），>30秒为标准次要色
  const isCritical = remainingSec <= 10 && remainingSec > 0;
  const isWarning = remainingSec <= 30 && remainingSec > 10;

  // 有倒计时时全员可见；没有时只有能开启的人看到限时栏。两态共用同一个外框，只替换框内内容。
  const visible = Boolean(phaseTimer) || canControl;
  const tone = !phaseTimer ? "idle" : isCritical ? "critical" : isWarning ? "warning" : "neutral";

  return (
    <AnimatePresence initial={false}>
      {visible ? (
        <motion.div
          key="phase-timer"
          variants={dropIn}
          initial="initial"
          animate="animate"
          exit="exit"
          data-testid="phase-timer-container"
          className={cn(
            "@container relative w-full overflow-hidden rounded-md border bg-background shadow-2xs transition-colors",
            tone === "critical" ? "border-destructive/40" : tone === "warning" ? "border-warning/40" : "border-border",
            className,
          )}
        >
          {/* 末段的状态浅底叠在不透明的 bg-background 上，外框本身不换底色 */}
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-0 transition-colors",
              tone === "critical" ? "bg-destructive/10" : tone === "warning" ? "bg-warning/10" : "bg-transparent",
            )}
          />
          <MeasuredSwap>
            <AnimatePresence mode="popLayout" initial={false}>
              {phaseTimer ? (
                <motion.div
                  key={`running-${phaseTimer.phase}-${phaseTimer.endsAt}`}
                  variants={readoutSwap}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="relative p-3"
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <div className="mr-auto flex min-w-0 items-center gap-2">
                      <motion.span
                        animate={isCritical ? urgentPulse.animate : { scale: 1 }}
                        transition={isCritical ? urgentPulse.transition : spring.snap}
                        className="flex shrink-0"
                      >
                        <Timer
                          className={cn(
                            "h-4 w-4",
                            isCritical ? "text-destructive" : isWarning ? "text-warning" : "text-muted-foreground",
                          )}
                        />
                      </motion.span>
                      <span className="truncate text-xs font-medium text-muted-foreground">本阶段倒计时</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "font-mono text-xl font-bold tabular-nums",
                          isCritical ? "text-destructive" : isWarning ? "text-warning" : "text-foreground",
                        )}
                      >
                        {formatTime(remainingSec)}
                      </span>
                      {canControl ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-muted-foreground"
                          onClick={handleStopTimer}
                          loading={stopping}
                        >
                          {stopping ? null : <X className="h-3.5 w-3.5" />}
                          取消
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  {/* 底部平滑进度条 */}
                  <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
                    <div
                      className={cn(
                        // 宽度在两次刷新之间匀速补间（见 countdownTickMs），读作连续流逝的时间。
                        "h-full rounded-full transition-[width] ease-linear",
                        isCritical ? "bg-destructive" : isWarning ? "bg-warning" : "bg-primary",
                      )}
                      style={{ width: `${percent}%`, transitionDuration: `${countdownTickMs}ms` }}
                    />
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key="idle"
                  data-testid="host-timer-bar"
                  variants={readoutSwap}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  // 窄框（手机）里分段控件与按钮放不下一行：分段跟在标签后，按钮另起一行占满整宽
                  className="relative flex flex-wrap items-center gap-2.5 p-2.5"
                >
                  <div className="mr-auto flex items-center gap-2">
                    <Clock className="h-4 w-4 text-muted-foreground" />
                    <span className="whitespace-nowrap text-xs font-medium text-muted-foreground">阶段限时</span>
                  </div>
                  <SegmentedControl
                    size="sm"
                    aria-label="倒计时时长"
                    className="w-full @sm:w-auto"
                    value={String(selectedDuration)}
                    options={DURATION_OPTIONS}
                    onValueChange={(value) => setSelectedDuration(Number(value))}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full @md:w-auto"
                    onClick={handleStartTimer}
                    loading={starting}
                  >
                    {starting ? null : <Play className="h-3 w-3 fill-current" />}
                    开启倒计时
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
          </MeasuredSwap>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * 两态内容交叉时外框高度按 spring.settle 补间：内容层量出布局高度，外层只动高度，
 * 退场内容经 popLayout 抽出文档流叠在原位，外框不会先塌再撑开。
 */
function MeasuredSwap({ children }: { children: ReactNode }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const height = useMeasuredHeight(innerRef);
  return (
    <motion.div
      className="relative"
      initial={false}
      animate={height === null ? undefined : { height }}
      transition={spring.settle}
    >
      <div ref={innerRef}>{children}</div>
    </motion.div>
  );
}
