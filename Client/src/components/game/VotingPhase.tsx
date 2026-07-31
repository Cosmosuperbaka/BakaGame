import { useCallback } from "react";
import { motion } from "framer-motion";
import { Vote, FastForward, CheckCircle2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useGameStore } from "@/stores/useGameStore";
import { PrivilegedActionPreview } from "./PrivilegedActionPreview";

export function VotingPhase() {
  const snapshot = useGameStore((s) => s.snapshot)!;
  const privateState = useGameStore((s) => s.privateState);
  const sendCommand = useGameStore((s) => s.sendCommand);
  const addToast = useGameStore((s) => s.addToast);
  const isQuestioner = privateState?.isQuestioner ?? false;
  const me = snapshot.players.find((p) => p.id === privateState?.playerId);
  const amAlive = me?.roundStatus === "alive";

  // 从服务端 privateState 中读取已投票对象（而非本地状态），保证刷新后一致。
  const votedId = privateState?.myCurrentVoteTargetId ?? null;

  const isTieBreak = snapshot.status.phase === "tieBreak";
  const tieBreakCandidateIds = snapshot.status.tieBreakCandidateIds ?? [];

  const alivePlayers = snapshot.players.filter((p) => p.roundStatus === "alive");

  const baseTargets = alivePlayers.filter(
    (p) => p.id !== privateState?.playerId || snapshot.testMode
  );

  const targets =
    isTieBreak && tieBreakCandidateIds.length > 0
      ? alivePlayers.filter((p) => tieBreakCandidateIds.includes(p.id))
      : baseTargets.length > 0
      ? baseTargets
      : snapshot.testMode && amAlive && !isQuestioner && me
        ? [me]
        : [];
  const soloShowcaseVote = targets.length === 1 && targets[0].id === me?.id;

  const handleVote = useCallback(
    async (targetId: string) => {
      try {
        await sendCommand("game.submitVote", { targetId });
      } catch (e) {
        addToast((e as { message: string }).message, "error");
      }
    },
    [sendCommand, addToast]
  );

  const handleCancelVote = useCallback(async () => {
    try {
      await sendCommand("game.cancelVote", {});
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

  const targetPlayerName = targets.find((t) => t.id === votedId)?.name
    ?? snapshot.players.find((p) => p.id === votedId)?.name;

  return (
    <div className="space-y-6 max-w-lg mx-auto">
      <div className="text-center">
        <h2 className="text-2xl font-semibold">投票阶段</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {votedId
            ? "已完成投票，等待其他玩家..."
            : amAlive && !isQuestioner
              ? "选择你要投出的玩家"
              : "等待玩家投票..."}
        </p>
      </div>

      <PrivilegedActionPreview mode="vote" />

      {amAlive && !isQuestioner && !votedId && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2.5">
            {targets.map((p) => (
              <Card
                key={p.id}
                className="cursor-pointer transition-all duration-150 hover:bg-primary/5 hover:border-primary/40 shadow-2xs"
                onClick={() => handleVote(p.id)}
              >
                <CardContent className="py-3.5 px-4 flex items-center justify-between">
                  <span className="font-medium text-sm truncate">{p.name}</span>
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

      {/* 提交选票后的优雅反馈卡片，支持撤销 */}
      {amAlive && !isQuestioner && votedId && (
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="flex items-center justify-between gap-3 p-4 rounded-xl border bg-emerald-500/10 border-emerald-500/20 text-emerald-800 dark:text-emerald-300 max-w-sm mx-auto"
        >
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <div className="text-sm font-medium">
              已完成投票
              {targetPlayerName && (
                <span className="ml-2 font-normal text-xs text-muted-foreground">
                  ( 投给：{targetPlayerName} )
                </span>
              )}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-xs text-muted-foreground hover:text-foreground shrink-0"
            onClick={handleCancelVote}
          >
            <Undo2 className="h-3.5 w-3.5" />
            撤销
          </Button>
        </motion.div>
      )}

      {isQuestioner && (
        <div className="text-center pt-2">
          <Button onClick={handleAdvance} size="lg" className="gap-2 px-6">
            <FastForward className="h-4 w-4" /> 结算投票
          </Button>
        </div>
      )}
    </div>
  );
}
