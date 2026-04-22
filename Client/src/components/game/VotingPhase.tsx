import { useState, useCallback } from "react";
import { motion } from "framer-motion";
import { Vote, FastForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useGame } from "@/contexts/GameContext";

export function VotingPhase() {
  const { state, sendCommand, addToast } = useGame();
  const snapshot = state.snapshot!;
  const privateState = state.privateState;
  const isQuestioner = privateState?.isQuestioner ?? false;
  const me = snapshot.players.find((p) => p.id === privateState?.playerId);
  const amAlive = me?.roundStatus === "alive";

  const [votedId, setVotedId] = useState<string | null>(null);

  const baseTargets = snapshot.players.filter(
    (p) => p.roundStatus === "alive" && p.id !== privateState?.playerId
  );
  const targets =
    baseTargets.length > 0
      ? baseTargets
      : snapshot.testMode && amAlive && !isQuestioner && me
        ? [me]
        : [];
  const soloShowcaseVote = targets.length === 1 && targets[0].id === me?.id;

  const handleVote = useCallback(
    async (targetId: string) => {
      try {
        await sendCommand("game.submitVote", { targetId });
        setVotedId(targetId);
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
        <h2 className="text-2xl font-semibold">投票阶段</h2>
        <p className="text-base text-muted-foreground mt-1">
          {votedId
            ? "已投票，等待其他玩家..."
            : amAlive && !isQuestioner
              ? "选择你要投出的玩家"
              : "等待玩家投票..."}
        </p>
      </div>

      {amAlive && !isQuestioner && !votedId && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2.5">
            {targets.map((p) => (
              <Card
                key={p.id}
                className="cursor-pointer transition-[background,border-color] duration-150 hover:bg-primary/5 hover:border-primary/40"
                onClick={() => handleVote(p.id)}
              >
                <CardContent className="py-3.5 px-4 flex items-center justify-between">
                  <span className="font-medium truncate">{p.name}</span>
                  <Vote className="h-4 w-4 text-muted-foreground shrink-0 ml-2" />
                </CardContent>
              </Card>
            ))}
          </div>
          {soloShowcaseVote && (
            <p className="text-xs text-center text-muted-foreground">
              测试模式下可对自己投票，用于完整展示单人界面。
            </p>
          )}
        </div>
      )}

      {votedId && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="text-center"
        >
          <Badge variant="outline" className="text-sm py-1.5 px-4">
            已投票给：{targets.find((t) => t.id === votedId)?.name ?? "未知"}
          </Badge>
        </motion.div>
      )}

      {isQuestioner && (
        <div className="text-center pt-2">
          <Button onClick={handleAdvance} size="lg" className="gap-2">
            <FastForward className="h-4 w-4" /> 结算投票
          </Button>
        </div>
      )}
    </div>
  );
}
