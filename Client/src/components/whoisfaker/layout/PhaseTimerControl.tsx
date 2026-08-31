import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Clock, Play, Timer, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { duration, spring, tappable } from "@/lib/Motion";
import { useWhoIsFakerStore as useGameStore } from "@/stores/UseWhoIsFakerStore";
import { cn } from "@/lib/Utils";

const DURATION_OPTIONS = [
  { label: "1分钟", seconds: 60 },
  { label: "2分钟", seconds: 120 },
  { label: "3分钟", seconds: 180 },
] as const;

interface Props {
  className?: string;
}

export function PhaseTimerControl({ className }: Props = {}) {
  const snapshot = useGameStore((s) => s.snapshot);
  const privateState = useGameStore((s) => s.privateState);
  const sendCommand = useGameStore((s) => s.sendCommand);
  const addToast = useGameStore((s) => s.addToast);

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
    }, 100);
    return () => window.clearInterval(interval);
  }, [phaseTimer]);

  const remainingMs = phaseTimer ? Math.max(0, phaseTimer.endsAt - now) : 0;
  const remainingSec = Math.ceil(remainingMs / 1000);
  const totalSec = phaseTimer?.durationSeconds ?? 60;
  const percent = phaseTimer
    ? Math.max(0, Math.min(100, (remainingMs / (totalSec * 1000)) * 100))
    : 0;

  // 倒计时归零时广播本地超时事件，供各阶段输入框自动提交暂存草稿
  useEffect(() => {
    if (!phaseTimer) return;
    if (remainingMs <= 0 && firedTimeoutForEndsAt.current !== phaseTimer.endsAt) {
      firedTimeoutForEndsAt.current = phaseTimer.endsAt;
      window.dispatchEvent(new CustomEvent("whoisfaker:phase-timeout"));
    }
  }, [phaseTimer, remainingMs]);

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
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98, transition: { duration: duration.instant } }}
            transition={spring.swift}
            className={cn(
              "relative overflow-hidden rounded-xl border p-3 shadow-xs transition-colors duration-300",
              isCritical
                ? "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300"
                : isWarning
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300"
                  : "border-border/80 bg-muted/60 text-foreground",
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <motion.span
                  animate={isCritical ? { scale: [1, 1.2, 1] } : {}}
                  transition={isCritical ? { duration: 0.8, repeat: Infinity } : {}}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-background/80"
                >
                  <Timer
                    className={cn(
                      "h-4 w-4",
                      isCritical
                        ? "text-rose-600 dark:text-rose-400"
                        : isWarning
                          ? "text-amber-600 dark:text-amber-400"
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
                      ? "text-rose-600 dark:text-rose-400"
                      : isWarning
                        ? "text-amber-700 dark:text-amber-400"
                        : "text-foreground",
                  )}
                >
                  {formatTime(remainingSec)}
                </span>

                {canControl && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:bg-background/80 hover:text-foreground"
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
                  "h-full rounded-full transition-all duration-100 ease-linear",
                  isCritical
                    ? "bg-rose-500"
                    : isWarning
                      ? "bg-amber-500"
                      : "bg-primary",
                )}
                style={{ width: `${percent}%` }}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 主持人/出题人未开启倒计时时的控制栏 */}
      {canControl && !phaseTimer && (
        <div
          data-testid="host-timer-bar"
          className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-border/70 bg-background/80 p-2.5 shadow-2xs backdrop-blur-md"
        >
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">阶段限时</span>
          </div>

          <div className="flex items-center gap-2">
            {/* 1分 / 2分 / 3分 分段选择器 */}
            <div className="flex items-center rounded-md bg-muted p-0.5">
              {DURATION_OPTIONS.map((opt) => {
                const isSelected = selectedDuration === opt.seconds;
                return (
                  <motion.button
                    key={opt.seconds}
                    type="button"
                    {...tappable}
                    onClick={() => setSelectedDuration(opt.seconds)}
                    className={cn(
                      "cursor-pointer rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
                      isSelected
                        ? "bg-background text-foreground shadow-2xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {opt.label}
                  </motion.button>
                );
              })}
            </div>

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
