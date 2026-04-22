import { useCallback } from "react";
import { motion } from "framer-motion";
import { Moon, Sword, FastForward, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useGame } from "@/contexts/GameContext";

export function NightPhase() {
  const { state, sendCommand, addToast } = useGame();
  const snapshot = state.snapshot!;
  const privateState = state.privateState;
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
        <Moon className="h-16 w-16 mx-auto mb-3 text-indigo-400/80" />
        <h2 className="text-2xl font-semibold">夜晚降临</h2>
        <p className="text-base text-muted-foreground mt-1">
          {canAct && !acted
            ? "你可以选择击杀一名玩家，或者什么都不做"
            : "等待夜晚结束..."}
        </p>
      </div>

      {canAct && !acted && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2.5">
            {targets.map((p) => (
              <Card
                key={p.id}
                className="cursor-pointer transition-[background,border-color] duration-150 hover:bg-rose-500/5 hover:border-rose-400/50"
                onClick={() => handleNightAction(p.id)}
              >
                <CardContent className="py-3.5 px-4 flex items-center justify-between">
                  <span className="font-medium truncate">{p.name}</span>
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
            <ShieldOff className="h-4 w-4" /> 什么都不做
          </Button>
        </div>
      )}

      {acted && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="text-center"
        >
          <Badge variant="outline" className="py-1.5 px-4 text-sm">
            已提交夜晚行动
          </Badge>
        </motion.div>
      )}

      {isQuestioner && (
        <div className="text-center pt-2">
          <Button onClick={handleAdvance} size="lg" className="gap-2">
            <FastForward className="h-4 w-4" /> 天亮了
          </Button>
        </div>
      )}
    </div>
  );
}
