import { useCallback, useState } from "react";
import { motion } from "framer-motion";
import { Trophy, BookOpen, RotateCcw, Vote } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { CollapsibleRegion, DisclosureChevron } from "@/components/ui/Collapsible";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { WINNER_LABELS } from "@/config/WhoIsFakerPresentation";
import { headerTappable } from "@/lib/Motion";
import { ABSTAIN_TARGET_ID } from "@/types";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { ScoreTable, type ScoreTableColumn } from "@/components/common/room/ScoreTable";
import { RoleBadge } from "../layout/RoleBadge";

const WIF_SCORE_COLUMNS: ScoreTableColumn[] = [
  { key: "role", header: "身份", align: "left" },
  { key: "delta", header: "本局", signed: true },
  { key: "total", header: "总分", tone: "strong" },
];

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
      {...headerTappable}
      className="flex w-full cursor-pointer items-center gap-2 border-b border-background px-4 py-2.5 text-left transition-colors hover:bg-accent/40"
    >
      {icon}
      <h3 className="flex-1 text-xs font-semibold text-muted-foreground">
        {label}
      </h3>
      <DisclosureChevron open={open} className="text-muted-foreground" />
    </motion.button>
  );
}

export function GameOverPhase() {
  const snapshot = useWhoIsFakerStore((s) => s.snapshot)!;
  const privateState = useWhoIsFakerStore((s) => s.privateState);
  const sendCommand = useWhoIsFakerStore((s) => s.sendCommand);
  const addToast = useWhoIsFakerStore((s) => s.addToast);
  const summary = snapshot.summary;
  const [showVotes, setShowVotes] = useState(true);
  const [returning, setReturning] = useState(false);
  const isHost = snapshot.hostPlayerId === privateState?.playerId;

  const handleReturnToWaiting = useCallback(async () => {
    setReturning(true);
    try {
      await sendCommand("game.advancePhase");
    } catch (error) {
      addToast((error as { message?: string }).message ?? "返回房间失败", "error");
      setReturning(false);
    }
  }, [addToast, sendCommand]);

  if (!summary) {
    return (
      <div className="mx-auto max-w-2xl space-y-5 py-8">
        <PhaseHeader icon={Trophy} title="游戏结束" />
        <section className="space-y-3 overflow-hidden rounded-md bg-muted p-4">
          <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
            <BookOpen className="h-4 w-4 text-primary" />
            本局词语解密
          </div>
          <p className="text-sm text-muted-foreground">结算数据同步中…</p>
        </section>
      </div>
    );
  }

  // 胜方色与 ROLE_COLORS 同源：好人阵营随平民取 info，卧底阵营取 destructive，白板取中性色。
  const winnerTone =
    summary.winner === "aborted"
      ? "text-muted-foreground"
      : summary.winner === "undercover"
        ? "text-destructive"
        : summary.winner === "blank"
          ? "text-muted-foreground"
          : "text-info";

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PhaseHeader
        icon={Trophy}
        title={WINNER_LABELS[summary.winner]}
        titleClassName={winnerTone}
        iconClassName={winnerTone}
      />

      {/* 词语揭秘全景卡片 */}
      <section className="space-y-3 overflow-hidden rounded-md bg-muted p-4">
        <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
          <BookOpen className="h-4 w-4 text-primary" />
          本局词语解密
        </div>
        {summary.words ? (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-center">
            <div className="rounded-md border border-info/40 bg-info/10 p-3">
              <div className="text-xs text-info font-medium mb-1">平民词</div>
              <div className="text-base font-bold text-info">
                {summary.words.civilianWord}
              </div>
            </div>
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
              <div className="text-xs text-destructive font-medium mb-1">卧底词</div>
              <div className="text-base font-bold text-destructive">
                {summary.words.undercoverWord}
              </div>
            </div>
            {summary.words.blankHint && (
              <div className="col-span-2 rounded-md border border-border bg-muted p-3 md:col-span-1">
                <div className="text-xs text-muted-foreground font-medium mb-1">白板提示</div>
                <div className="text-base font-bold text-foreground">
                  {summary.words.blankHint}
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">本局在出题前结束，没有可解密的词语。</p>
        )}
      </section>

      {/* 身份按座次自上而下逐行揭示，让战报读作一次开牌而非整块出现 */}
      <ScoreTable
        title="身份揭示与得分统计"
        columns={WIF_SCORE_COLUMNS}
        rows={summary.revealedRoles.map(({ playerId, role }) => {
          const player = snapshot.players.find((p) => p.id === playerId);
          const delta = summary.awardedScores.find((s) => s.playerId === playerId)?.delta ?? 0;
          const total = player?.score ?? 0;
          return {
            key: playerId,
            name: player?.name ?? playerId,
            cells: {
              role: <RoleBadge role={role} inset />,
              delta,
              total,
            },
            // 结算快照里的累计分已含本局得分，从赛前分滚起
            rollFrom: { total: total - delta },
            // 服务端只给获胜阵营记分，本局得分即胜方；中止的局没有胜方
            winner: delta > 0,
          };
        })}
      />

      {/* 投票复盘：按天顺序展示 */}
      {summary.voteHistory && summary.voteHistory.length > 0 && (
        <section className="overflow-hidden rounded-md bg-muted">
          <DisclosureHeader
            icon={<Vote className="h-4 w-4 text-primary" />}
            label="投票明细"
            open={showVotes}
            onToggle={() => setShowVotes((v) => !v)}
          />
          <CollapsibleRegion open={showVotes}>
            <div className="space-y-3 p-4">
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
                        const abstained = v.targetId === ABSTAIN_TARGET_ID;
                        const target = snapshot.players.find((p) => p.id === v.targetId);
                        return (
                          <div
                            key={vIdx}
                            className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-background text-xs"
                          >
                            <span className="font-medium">{voter?.name ?? v.voterId}</span>
                            <span className="text-muted-foreground">
                              {abstained ? "选择了" : "投给了"}
                            </span>
                            <Badge variant="outline" size="xs">
                              {abstained ? "弃票" : (target?.name ?? v.targetId)}
                            </Badge>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
            </div>
          </CollapsibleRegion>
        </section>
      )}

      {/* 白板猜词记录 */}
      {summary.blankGuesses.length > 0 && (
        <section className="overflow-hidden rounded-md bg-muted">
          <div className="border-b border-background px-4 py-2.5">
            <h3 className="text-xs font-semibold text-muted-foreground">
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
                  <Badge variant={g.success ? "default" : "destructive"} size="xs">
                    {g.success ? "正确" : "错误"}
                  </Badge>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* 房主可让全房回到等待阶段。 */}
      <div className="flex flex-col items-center gap-3 pt-2">
        {isHost ? (
          <Button
            size="lg"
            onClick={handleReturnToWaiting}
            disabled={returning}
            className="gap-2 px-8 text-base"
          >
            <RotateCcw className="h-4 w-4" />
            {returning ? "正在返回…" : "返回房间等待"}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">等待房主返回房间</p>
        )}
      </div>
    </div>
  );
}
