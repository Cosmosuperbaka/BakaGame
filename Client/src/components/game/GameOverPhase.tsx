import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Trophy, Check, History, ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useGame } from "@/contexts/GameContext";
import { ROLE_LABELS, ROLE_COLORS, WINNER_LABELS } from "@/lib/helpers";
import { cn } from "@/lib/utils";
import { DescriptionTable } from "./DescriptionHistory";

export function GameOverPhase() {
  const { state, sendCommand, addToast } = useGame();
  const snapshot = state.snapshot!;
  const privateState = state.privateState;
  const summary = snapshot.summary;
  const me = snapshot.players.find((p) => p.id === privateState?.playerId);
  const isHost = me?.isHost ?? false;
  const [showDescriptions, setShowDescriptions] = useState(false);

  const activePlayers = snapshot.players.filter((p) => p.membership === "active");
  const nonHostActive = activePlayers.filter((p) => !p.isHost);
  const canSoloRestart = snapshot.testMode && isHost && nonHostActive.length === 0;
  const allReady = canSoloRestart || (nonHostActive.length > 0 && nonHostActive.every((p) => p.isReady));
  const readyCount = nonHostActive.filter((p) => p.isReady).length;

  // 房主自动准备，方便直接点"开始下一局"。
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
  }, [me?.isReady, sendCommand, addToast]);

  const handleStart = useCallback(async () => {
    try {
      await sendCommand("game.advancePhase");
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    }
  }, [sendCommand, addToast]);

  if (!summary) {
    return (
      <div className="text-center py-8">
        <h2 className="text-xl font-semibold">游戏结束</h2>
        <p className="text-muted-foreground mt-2">等待结算数据...</p>
      </div>
    );
  }

  const winnerTone =
    summary.winner === "aborted"
      ? "text-muted-foreground"
      : summary.winner === "undercover"
        ? "text-rose-600"
        : summary.winner === "blank"
          ? "text-slate-600"
          : "text-amber-600";

  return (
    <motion.div
      key="game-over"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className="mx-auto max-w-2xl space-y-5"
    >
      {/* 结算标题 */}
      <div className="flex items-center gap-4 rounded-xl border bg-muted/30 px-5 py-4">
        <Trophy className={cn("h-10 w-10 shrink-0", winnerTone)} />
        <div className="min-w-0 flex-1">
          <div className={cn("text-xl font-semibold", winnerTone)}>
            {WINNER_LABELS[summary.winner]}
          </div>
          <p className="text-sm text-muted-foreground mt-0.5 leading-relaxed">
            {summary.reason}
          </p>
        </div>
      </div>

      {/* 身份公布 + 得分（合并为一张紧凑表格） */}
      <section className="rounded-xl border overflow-hidden">
        <div className="px-4 py-2.5 border-b bg-muted/30">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            身份揭示
          </h3>
        </div>
        <table className="w-full text-sm">
          <tbody className="divide-y">
            {summary.revealedRoles.map(({ playerId, role }) => {
              const player = snapshot.players.find((p) => p.id === playerId);
              const award = summary.awardedScores.find(
                (s) => s.playerId === playerId
              );
              return (
                <tr key={playerId} className="hover:bg-muted/20">
                  <td className="px-4 py-2 font-medium">
                    {player?.name ?? playerId}
                  </td>
                  <td className="px-4 py-2">
                    <Badge
                      variant="outline"
                      className={cn("text-[11px]", ROLE_COLORS[role])}
                    >
                      {ROLE_LABELS[role]}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 text-right w-20">
                    {award ? (
                      <span className="text-emerald-600 font-medium">
                        +{award.delta}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/60">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {/* 白板猜词记录 */}
      {summary.blankGuesses.length > 0 && (
        <section className="rounded-xl border overflow-hidden">
          <div className="px-4 py-2.5 border-b bg-muted/30">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              白板猜词
            </h3>
          </div>
          <div className="divide-y">
            {summary.blankGuesses.map((g, i) => {
              const player = snapshot.players.find((p) => p.id === g.playerId);
              return (
                <div
                  key={i}
                  className="px-4 py-2.5 text-sm flex items-center gap-3"
                >
                  <span className="font-medium min-w-[5rem]">
                    {player?.name}
                  </span>
                  <span className="text-muted-foreground">
                    {g.guessedWords[0]} / {g.guessedWords[1]}
                  </span>
                  <span className="flex-1" />
                  <Badge
                    variant={g.success ? "default" : "destructive"}
                    className="text-[11px]"
                  >
                    {g.success ? "正确" : "错误"}
                  </Badge>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* 描述复盘（可展开） */}
      {summary.descriptions.length > 0 && (
        <section className="rounded-xl border overflow-hidden">
          <button
            type="button"
            onClick={() => setShowDescriptions((v) => !v)}
            className="w-full px-4 py-2.5 border-b bg-muted/30 flex items-center gap-2 text-left hover:bg-muted/50 transition-colors"
          >
            <History className="h-3.5 w-3.5 text-muted-foreground" />
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex-1">
              描述复盘
            </h3>
            <ChevronDown
              className={cn(
                "h-4 w-4 text-muted-foreground transition-transform duration-200",
                showDescriptions && "rotate-180"
              )}
            />
          </button>
          <AnimatePresence initial={false}>
            {showDescriptions && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
                className="overflow-hidden"
              >
                <div className="p-4">
                  <DescriptionTable
                    descriptions={summary.descriptions}
                    compact
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      )}

      {/* 下一局：房主看到"开始"，成员看到"准备" */}
      <div className="flex flex-col items-center gap-3 pt-2">
        {isHost ? (
          <Button
            size="lg"
            disabled={!allReady}
            onClick={handleStart}
            className="text-base px-8"
          >
            {canSoloRestart
              ? "开始下一局"
              : allReady
              ? "开始下一局"
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
              <Check className="h-4 w-4" />
              {me.isReady ? "取消准备" : "准备下一局"}
            </Button>
          )
        )}
      </div>
    </motion.div>
  );
}
