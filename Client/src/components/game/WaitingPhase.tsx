import { useCallback, useEffect } from "react";
import { motion } from "framer-motion";
import { Check, X, Gamepad2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PhaseHeader } from "@/components/game/PhaseHeader";
import { useGameStore } from "@/stores/useGameStore";

export function WaitingPhase() {
  const snapshot = useGameStore((s) => s.snapshot)!;
  const privateState = useGameStore((s) => s.privateState);
  const sendCommand = useGameStore((s) => s.sendCommand);
  const addToast = useGameStore((s) => s.addToast);
  const me = snapshot.players.find((p) => p.id === privateState?.playerId);
  const isHost = me?.isHost ?? false;

  const activePlayers = snapshot.players.filter((p) => p.membership === "active");
  // 房主不需要手动准备，allReady 排除房主
  const nonHostActive = activePlayers.filter((p) => !p.isHost);
  const canSoloStart = snapshot.testMode && isHost && nonHostActive.length === 0;
  const allReady = canSoloStart || (nonHostActive.length > 0 && nonHostActive.every((p) => p.isReady));
  const readyCount = nonHostActive.filter((p) => p.isReady).length;

  // 房主自动准备（服务端要求所有 active 都 ready）
  useEffect(() => {
    if (isHost && me && !me.isReady) {
      sendCommand("player.setReady", { ready: true }).catch(() => {});
    }
  }, [isHost, me, sendCommand]);

  const handleReady = useCallback(async () => {
    try {
      await sendCommand("player.setReady", { ready: !me?.isReady });
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    }
  }, [me, sendCommand, addToast]);

  const handleStart = useCallback(async () => {
    try {
      await sendCommand("game.advancePhase");
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    }
  }, [sendCommand, addToast]);

  return (
    <div className="flex flex-col items-center gap-8">
      <div>
        <PhaseHeader
          icon={Gamepad2}
          title="等待玩家准备"
          description={
            canSoloStart
              ? "已准备开始游戏"
              : `${readyCount}/${nonHostActive.length} 名玩家已准备`
          }
        />
        {/* 进度条 — 真实状态变化驱动动画 */}
        <div className="w-48 h-1.5 bg-muted rounded-full mx-auto mt-4 overflow-hidden">
          <motion.div
            className="h-full bg-primary rounded-full"
            initial={false}
            animate={{
              width: canSoloStart
                ? "100%"
                : nonHostActive.length
                ? `${(readyCount / nonHostActive.length) * 100}%`
                : "0%",
            }}
            transition={{ duration: 0.35, ease: "easeOut" }}
          />
        </div>
      </div>

      {/* 房主只看到开始按钮，非房主只看到准备按钮 */}
      {isHost ? (
        <Button
          size="lg"
          disabled={!allReady}
          onClick={handleStart}
          className="text-base px-8"
        >
          {allReady
            ? "开始游戏"
            : `等待所有玩家准备 (${readyCount}/${nonHostActive.length})`}
        </Button>
      ) : (
        me?.membership === "active" && (
          <Button
            variant={me.isReady ? "outline" : "default"}
            size="lg"
            onClick={handleReady}
            className="gap-2 min-w-[120px]"
          >
            {me.isReady ? (
              <>
                <X className="h-4 w-4" /> 取消准备
              </>
            ) : (
              <>
                <Check className="h-4 w-4" /> 准备
              </>
            )}
          </Button>
        )
      )}
    </div>
  );
}
