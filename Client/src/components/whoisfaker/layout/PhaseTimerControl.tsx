import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Clock, Play, Timer, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/SegmentedControl";
import { countdownTickMs, dropIn, spring, urgentPulse } from "@/lib/Motion";
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

  if (!phaseTimer && !canControl) {
    return null;
  }

  return (
    <div className={cn("w-full space-y-3", className)} data-testid="phase-timer-container">
      {/* 倒计时进行中：全员操作区显示倒计时条 */}
      <AnimatePresence mode="wait">
        {phaseTimer && (
          <motion.div
            key={`timer-display-${phaseTimer.phase}-${phaseTimer.endsAt}`}
            variants={dropIn}
            initial="initial"
            animate="animate"
            exit="exit"
            className={cn(
              "relative overflow-hidden rounded-md border p-3 transition-colors",
              isCritical
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : isWarning
                  ? "border-warning/40 bg-warning/10 text-warning"
                  : "border-border/80 bg-muted/40 text-foreground",
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <motion.span
                  animate={isCritical ? urgentPulse.animate : { scale: 1 }}
                  transition={isCritical ? urgentPulse.transition : spring.snap}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-background"
                >
                  <Timer
                    className={cn(
                      "h-4 w-4",
                      isCritical
                        ? "text-destructive"
                        : isWarning
                          ? "text-warning"
                          : "text-muted-foreground",
                    )}
                  />
                </motion.span>
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-medium text-muted-foreground truncate">
                    本阶段倒计时
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    "font-mono text-xl font-bold tracking-widest tabular-nums",
                    isCritical
                      ? "text-destructive"
                      : isWarning
                        ? "text-warning"
                        : "text-foreground",
                  )}
                >
                  {formatTime(remainingSec)}
                </span>

                {canControl && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:bg-background hover:text-foreground"
                    onClick={handleStopTimer}
                    disabled={stopping}
                  >
                    <X className="h-3.5 w-3.5" />
                    取消
                  </Button>
                )}
              </div>
            </div>

            {/* 底部平滑进度条 */}
            <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
              <div
                className={cn(
                  // 宽度在两次刷新之间匀速补间（见 countdownTickMs），读作连续流逝的时间。
                  "h-full rounded-full transition-[width] ease-linear",
                  isCritical
                    ? "bg-destructive"
                    : isWarning
                      ? "bg-warning"
                      : "bg-primary",
                )}
                style={{ width: `${percent}%`, transitionDuration: `${countdownTickMs}ms` }}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 主持人/出题人未开启倒计时时的控制栏 */}
      {canControl && !phaseTimer && (
        <div
          data-testid="host-timer-bar"
          className="flex flex-wrap items-center justify-between gap-2.5 rounded-md border border-border/70 bg-background p-2.5 shadow-2xs"
        >
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">阶段限时</span>
          </div>

          <div className="flex items-center gap-2">
            <SegmentedControl
              size="sm"
              aria-label="倒计时时长"
              className="w-auto"
              value={String(selectedDuration)}
              options={DURATION_OPTIONS}
              onValueChange={(value) => setSelectedDuration(Number(value))}
            />

            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 px-3 text-xs"
              onClick={handleStartTimer}
              disabled={starting}
            >
              <Play className="h-3 w-3 fill-current" />
              开启倒计时
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
