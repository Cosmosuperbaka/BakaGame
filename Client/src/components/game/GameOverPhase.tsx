import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Trophy, ChevronDown, BookOpen, Home, Vote } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useGameStore } from "@/stores/useGameStore";
import { ROLE_LABELS, ROLE_COLORS, WINNER_LABELS } from "@/lib/helpers";
import { collapsible, listContainer, listItem, spring } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { PhaseHeader } from "./PhaseHeader";

/**
 * 折叠区标题。箭头以弹性过渡翻转，与内容展开同时发生，
 * 使箭头方向读作展开状态本身，而不是一个独立的装饰。
 */
function DisclosureHeader({
  icon,
  label,
  open,
  onToggle,
}: {
  icon: React.ReactNode;
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <motion.button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      whileTap={{ scale: 0.995 }}
      transition={spring.snap}
      className="flex w-full cursor-pointer items-center gap-2 border-b border-background px-4 py-2.5 text-left transition-colors hover:bg-background/50"
    >
      {icon}
      <h3 className="flex-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </h3>
      <motion.span
        aria-hidden="true"
        className="inline-flex text-muted-foreground"
        animate={{ rotate: open ? 180 : 0 }}
        transition={spring.snap}
      >
        <ChevronDown className="h-4 w-4" />
      </motion.span>
    </motion.button>
  );
}

export function GameOverPhase() {
  const snapshot = useGameStore((s) => s.snapshot)!;
  const leaveRoom = useGameStore((s) => s.leaveRoom);
  const navigate = useNavigate();
  const summary = snapshot.summary;
  const [showVotes, setShowVotes] = useState(true);

  // 结算看完就离开房间回到主页。准备状态已由服务端在结算时统一重置，
  // 想再来一局就重新进房间，不在战报页直接开下一局。
  const handleBackHome = useCallback(async () => {
    await leaveRoom();
    navigate("/whoisfaker");
  }, [leaveRoom, navigate]);

  if (!summary) {
    return (
      <div className="py-8">
        <PhaseHeader icon={Trophy} title="游戏结束" />
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
    <div className="mx-auto max-w-2xl space-y-5">
      <PhaseHeader
        icon={Trophy}
        title={WINNER_LABELS[summary.winner]}
        titleClassName={winnerTone}
        iconClassName={winnerTone}
      />

      {/* 词语揭秘全景卡片 */}
      {summary.words && (
        <section className="space-y-3 overflow-hidden rounded-md bg-muted p-4">
          <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            <BookOpen className="h-4 w-4 text-primary" />
            本局词语解密
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-center">
            <div className="rounded-md border border-emerald-500/20 bg-emerald-500/10 p-3">
              <div className="text-xs text-emerald-600 font-medium mb-1">平民词</div>
              <div className="text-base font-bold text-emerald-700">
                {summary.words.civilianWord}
              </div>
            </div>
            <div className="rounded-md border border-rose-500/20 bg-rose-500/10 p-3">
              <div className="text-xs text-rose-600 font-medium mb-1">卧底词</div>
              <div className="text-base font-bold text-rose-700">
                {summary.words.undercoverWord}
              </div>
            </div>
            {summary.words.blankHint && (
              <div className="col-span-2 rounded-md border border-slate-500/20 bg-slate-500/10 p-3 md:col-span-1">
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
      <section className="overflow-hidden rounded-md bg-muted">
        <div className="flex items-center justify-between border-b border-background px-4 py-2.5">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            身份揭示与得分统计
          </h3>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-background text-xs text-muted-foreground">
              <th className="px-4 py-2 text-left font-medium">玩家</th>
              <th className="px-4 py-2 text-left font-medium">本局身份</th>
              <th className="px-4 py-2 text-right font-medium">本局变动</th>
              <th className="px-4 py-2 text-right font-medium">房间累计</th>
            </tr>
          </thead>
          {/* 身份逐行揭示，让战报读作一次开牌而非整块出现 */}
          <motion.tbody
            className="divide-y divide-background"
            variants={listContainer(summary.revealedRoles.length)}
            initial="initial"
            animate="animate"
          >
            {summary.revealedRoles.map(({ playerId, role }) => {
              const player = snapshot.players.find((p) => p.id === playerId);
              const award = summary.awardedScores.find(
                (s) => s.playerId === playerId
              );
              const delta = award?.delta ?? 0;
              const totalScore = player?.score ?? 0;
              return (
                <motion.tr key={playerId} variants={listItem} className="hover:bg-background/50">
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
                    +{delta}
                  </td>
                  <td className="px-4 py-2.5 text-right font-semibold text-amber-600">
                    {totalScore}
                  </td>
                </motion.tr>
              );
            })}
          </motion.tbody>
        </table>
      </section>

      {/* 投票复盘：按天顺序展示 */}
      {summary.voteHistory && summary.voteHistory.length > 0 && (
        <section className="overflow-hidden rounded-md bg-muted">
          <DisclosureHeader
            icon={<Vote className="h-4 w-4 text-primary" />}
            label="投票明细"
            open={showVotes}
            onToggle={() => setShowVotes((v) => !v)}
          />
          <AnimatePresence initial={false}>
            {showVotes && (
              <motion.div
                variants={collapsible}
                initial="initial"
                animate="animate"
                exit="exit"
                className="space-y-3 overflow-hidden p-4"
              >
                {[...summary.voteHistory]
                  .sort((a, b) => a.day - b.day || (a.tieBreak ? 1 : 0) - (b.tieBreak ? 1 : 0))
                  .map((item, idx) => (
                  <div key={idx} className="space-y-1.5 text-sm">
                    <div className="font-semibold text-xs text-muted-foreground">
                      第 {item.day} 天{item.tieBreak ? " · 平票PK" : ""}：
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
        <section className="overflow-hidden rounded-md bg-muted">
          <div className="border-b border-background px-4 py-2.5">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              白板猜词记录
            </h3>
          </div>
          <div className="divide-y divide-background">
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

      {/* 战报看完后统一回主页 */}
      <div className="flex flex-col items-center gap-3 pt-2">
        <Button size="lg" onClick={handleBackHome} className="gap-2 px-8 text-base">
          <Home className="h-4 w-4" />
          返回主页
        </Button>
      </div>
    </div>
  );
}
