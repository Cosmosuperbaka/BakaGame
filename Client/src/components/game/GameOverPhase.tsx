import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Trophy, Check, History, ChevronDown, BookOpen, Vote } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useGameStore } from "@/stores/useGameStore";
import { ROLE_LABELS, ROLE_COLORS, WINNER_LABELS } from "@/lib/helpers";
import { cn } from "@/lib/utils";
import { DescriptionTable } from "./DescriptionHistory";
import { PhaseHeader } from "./PhaseHeader";

export function GameOverPhase() {
  const snapshot = useGameStore((s) => s.snapshot)!;
  const privateState = useGameStore((s) => s.privateState);
  const sendCommand = useGameStore((s) => s.sendCommand);
  const addToast = useGameStore((s) => s.addToast);
  const summary = snapshot.summary;
  const me = snapshot.players.find((p) => p.id === privateState?.playerId);
  const isHost = me?.isHost ?? false;
  const [showDescriptions, setShowDescriptions] = useState(false);
  const [showVotes, setShowVotes] = useState(true);

  const activePlayers = snapshot.players.filter((p) => p.membership === "active");
  const nonHostActive = activePlayers.filter((p) => !p.isHost);
  const canSoloRestart = snapshot.testMode && isHost && nonHostActive.length === 0;
  const allReady = canSoloRestart || (nonHostActive.length > 0 && nonHostActive.every((p) => p.isReady));
  const readyCount = nonHostActive.filter((p) => p.isReady).length;

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

  if (!summary) {
    return (
      <div className="py-8">
        <PhaseHeader icon={Trophy} title="游戏结束" description="等待战报数据..." />
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
      <PhaseHeader
        icon={Trophy}
        title={WINNER_LABELS[summary.winner]}
        titleClassName={winnerTone}
        iconClassName={winnerTone}
        description={summary.reason.replace(/（测试）/g, "").replace(/\(测试\)/g, "").trim()}
      />

      {/* 词语揭秘全景卡片 */}
      {summary.words && (
        <section className="rounded-xl border overflow-hidden bg-muted/20 p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            <BookOpen className="h-4 w-4 text-primary" />
            本局词语解密
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-center">
            <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
              <div className="text-xs text-emerald-600 font-medium mb-1">平民词</div>
              <div className="text-base font-bold text-emerald-700">
                {summary.words.civilianWord}
              </div>
            </div>
            <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-lg">
              <div className="text-xs text-rose-600 font-medium mb-1">卧底词</div>
              <div className="text-base font-bold text-rose-700">
                {summary.words.undercoverWord}
              </div>
            </div>
            {summary.words.blankHint && (
              <div className="p-3 bg-slate-500/10 border border-slate-500/20 rounded-lg col-span-2 md:col-span-1">
                <div className="text-xs text-slate-600 font-medium mb-1">白板提示</div>
                <div className="text-base font-bold text-slate-700">
                  {summary.words.blankHint}
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* 身份揭示与得分表格 */}
      <section className="rounded-xl border overflow-hidden">
        <div className="px-4 py-2.5 border-b bg-muted/30 flex items-center justify-between">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            身份揭示与得分统计
          </h3>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/10 text-xs text-muted-foreground">
              <th className="px-4 py-2 text-left font-medium">玩家</th>
              <th className="px-4 py-2 text-left font-medium">本局身份</th>
              <th className="px-4 py-2 text-right font-medium">本局变动</th>
              <th className="px-4 py-2 text-right font-medium">房间累计</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {summary.revealedRoles.map(({ playerId, role }) => {
              const player = snapshot.players.find((p) => p.id === playerId);
              const award = summary.awardedScores.find(
                (s) => s.playerId === playerId
              );
              const delta = award?.delta ?? 0;
              const totalScore = player?.score ?? 0;
              return (
                <tr key={playerId} className="hover:bg-muted/20">
                  <td className="px-4 py-2.5 font-medium">
                    {player?.name ?? playerId}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge
                      variant="outline"
                      className={cn("text-[11px]", ROLE_COLORS[role])}
                    >
                      {ROLE_LABELS[role]}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5 text-right font-semibold text-emerald-600">
                    +{delta} 分
                  </td>
                  <td className="px-4 py-2.5 text-right font-semibold text-amber-600">
                    {totalScore} 分
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {/* 投票复盘明细 */}
      {summary.voteHistory && summary.voteHistory.length > 0 && (
        <section className="rounded-xl border overflow-hidden">
          <button
            type="button"
            onClick={() => setShowVotes((v) => !v)}
            className="w-full px-4 py-2.5 border-b bg-muted/30 flex items-center gap-2 text-left hover:bg-muted/50 transition-colors"
          >
            <Vote className="h-4 w-4 text-primary" />
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex-1">
              投票明细战报
            </h3>
            <ChevronDown
              className={cn(
                "h-4 w-4 text-muted-foreground transition-transform duration-200",
                showVotes && "rotate-180"
              )}
            />
          </button>
          <AnimatePresence initial={false}>
            {showVotes && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
                className="overflow-hidden p-4 space-y-3"
              >
                {summary.voteHistory.map((item, idx) => (
                  <div key={idx} className="space-y-1.5 text-sm">
                    <div className="font-semibold text-xs text-muted-foreground">
                      第 {item.day} 天{item.tieBreak ? " (平票PK投票)" : " (正常投票)"}：
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      {item.votes.map((v, vIdx) => {
                        const voter = snapshot.players.find((p) => p.id === v.voterId);
                        const target = snapshot.players.find((p) => p.id === v.targetId);
                        return (
                          <div
                            key={vIdx}
                            className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-muted/30 text-xs"
                          >
                            <span className="font-medium">{voter?.name ?? v.voterId}</span>
                            <span className="text-muted-foreground">投给了</span>
                            <Badge variant="outline" className="text-[11px] font-normal">
                              {target?.name ?? v.targetId}
                            </Badge>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      )}

      {/* 白板猜词记录 */}
      {summary.blankGuesses.length > 0 && (
        <section className="rounded-xl border overflow-hidden">
          <div className="px-4 py-2.5 border-b bg-muted/30">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              白板猜词记录
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

      {/* 描述复盘 */}
      {summary.descriptions.length > 0 && (
        <section className="rounded-xl border overflow-hidden">
          <button
            type="button"
            onClick={() => setShowDescriptions((v) => !v)}
            className="w-full px-4 py-2.5 border-b bg-muted/30 flex items-center gap-2 text-left hover:bg-muted/50 transition-colors"
          >
            <History className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex-1">
              描述发言复盘
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

      {/* 下一局控制按钮 */}
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
              : `等待在线玩家准备 (${readyCount}/${nonHostActive.length})`}
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
