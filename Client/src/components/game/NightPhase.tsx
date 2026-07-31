import { useCallback } from "react";
import { motion } from "framer-motion";
import { Moon, Sword, FastForward, ShieldOff, CheckCircle2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useGameStore } from "@/stores/useGameStore";
import { PrivilegedActionPreview } from "./PrivilegedActionPreview";

export function NightPhase() {
  const snapshot = useGameStore((s) => s.snapshot)!;
  const privateState = useGameStore((s) => s.privateState);
  const sendCommand = useGameStore((s) => s.sendCommand);
  const addToast = useGameStore((s) => s.addToast);
  const isQuestioner = privateState?.isQuestioner ?? false;
  const me = snapshot.players.find((p) => p.id === privateState?.playerId);
  const amAlive = me?.roundStatus === "alive";
  const role = privateState?.role;

  const acted = privateState?.nightActionSubmitted ?? false;

  const canAct =
    amAlive && !isQuestioner && (role === "civilian" || role === "undercover");

  const baseTargets = snapshot.players.filter(
    (p) => p.roundStatus === "alive" && p.id !== privateState?.playerId
  );
  const targets =
    baseTargets.length > 0
      ? baseTargets
      : snapshot.testMode && canAct && me
        ? [me]
        : [];
  const soloShowcaseNight = targets.length === 1 && targets[0].id === me?.id;

  const handleNightAction = useCallback(
    async (targetId?: string) => {
      try {
        await sendCommand("game.submitNightAction", { targetId: targetId ?? null });
      } catch (e) {
        addToast((e as { message: string }).message, "error");
      }
    },
    [sendCommand, addToast]
  );

  const handleCancelNightAction = useCallback(async () => {
    try {
      await sendCommand("game.cancelNightAction", {});
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    }
  }, [sendCommand, addToast]);

  const handleAdvance = useCallback(async () => {
    try {
      await sendCommand("game.advancePhase");
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    }
  }, [sendCommand, addToast]);

  return (
    <div className="space-y-6 max-w-lg mx-auto">
      <div className="text-center">
        <Moon className="h-14 w-14 mx-auto mb-3 text-indigo-500/80" />
        <h2 className="text-2xl font-semibold">夜晚降临</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {canAct && !acted
            ? "你可以选择击杀一名玩家，或者什么都不做"
            : "等待夜晚结束..."}
        </p>
      </div>

      <PrivilegedActionPreview mode="night" />

      {canAct && !acted && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2.5">
            {targets.map((p) => (
              <Card
                key={p.id}
                className="cursor-pointer transition-all duration-150 hover:bg-rose-500/5 hover:border-rose-400/50 shadow-2xs"
                onClick={() => handleNightAction(p.id)}
              >
                <CardContent className="py-3.5 px-4 flex items-center justify-between">
                  <span className="font-medium text-sm truncate">{p.name}</span>
                  <Sword className="h-4 w-4 text-rose-500 shrink-0 ml-2" />
                </CardContent>
              </Card>
            ))}
          </div>
          {soloShowcaseNight && (
            <p className="text-xs text-center text-muted-foreground">
              测试模式下可选择自己，或直接跳过夜晚行动。
            </p>
          )}
          <Button
            variant="outline"
            className="w-full gap-2 h-10"
            onClick={() => handleNightAction()}
          >
            <ShieldOff className="h-4 w-4 text-muted-foreground" /> 什么都不做
          </Button>
        </div>
      )}

      {/* 提交行动后的优雅反馈卡片，支持撤销 */}
      {canAct && acted && (
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="flex items-center justify-between gap-3 p-4 rounded-xl border bg-emerald-500/10 border-emerald-500/20 text-emerald-800 dark:text-emerald-300 max-w-sm mx-auto"
        >
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <div className="text-sm font-medium">
              已完成夜晚决策
              <span className="ml-2 font-normal text-xs text-muted-foreground">
                ( 静待天亮... )
              </span>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-xs text-muted-foreground hover:text-foreground shrink-0"
            onClick={handleCancelNightAction}
          >
            <Undo2 className="h-3.5 w-3.5" />
            撤销
          </Button>
        </motion.div>
      )}

      {isQuestioner && (
        <div className="text-center pt-2">
          <Button onClick={handleAdvance} size="lg" className="gap-2 px-6">
            <FastForward className="h-4 w-4" /> 天亮了
          </Button>
        </div>
      )}
    </div>
  );
}
