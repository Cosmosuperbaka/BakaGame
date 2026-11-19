import { useState } from "react";
import { motion } from "framer-motion";
import { Trophy, BookOpen, History, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { CollapsibleRegion, DisclosureChevron } from "@/components/ui/Collapsible";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { WINNER_LABELS, WINNER_TONE } from "@/config/WhoIsFakerPresentation";
import { headerTappable } from "@/lib/motion/Feedback";
import { cn } from "@/lib/Utils";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { ScoreTable, type ScoreTableColumn } from "@/components/common/room/ScoreTable";
import { FakerRoleBadge } from "../layout/FakerRoleBadge";
import { FakerRoundHistoryTimeline } from "./FakerRoundHistoryTimeline";
import { useFakerPhaseAction } from "./UseFakerPhaseAction";

/** 区块小标题：与公共结算表、得票与票型同一口径 */
const SECTION_TITLE = "flex items-center gap-1.5 text-xs font-semibold text-muted-foreground";

const WIF_SCORE_COLUMNS: ScoreTableColumn[] = [
  { key: "role", header: "身份", align: "left" },
  { key: "delta", header: "本局", signed: true },
  { key: "total", header: "总分", tone: "strong" },
];

/**
 * 折叠区标题。箭头以弹性过渡翻转，与内容展开同时发生，
 * 使箭头方向读作展开状态本身，而不是一个独立的装饰。
 * 与同页结算表的标题带同一语言（区块小标题：xs 半粗弱化色，图标 3.5 同色），
 * 整行悬停与聚焦内收的环取折叠设置组标题的写法：外层 overflow-hidden 会裁掉贴边的环。
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
      className="flex w-full cursor-pointer items-center gap-1.5 border-b border-background px-4 py-2.5 text-left text-muted-foreground transition-colors hover:bg-accent/40 focus-visible:-outline-offset-2"
    >
      {icon}
      <h3 className="flex-1 text-xs font-semibold">{label}</h3>
      <DisclosureChevron open={open} />
    </motion.button>
  );
}

export function FakerGameOverPhase() {
  const snapshot = useWhoIsFakerStore((s) => s.snapshot)!;
  const privateState = useWhoIsFakerStore((s) => s.privateState);
  const summary = snapshot.summary;
  const [showHistory, setShowHistory] = useState(true);
  const { exec, busy } = useFakerPhaseAction();
  // 成功后保持加载态直到快照切回等待阶段（本组件随之卸载），避免应答与快照之间的空档里再点一次
  const [returned, setReturned] = useState(false);
  const returning = busy || returned;
  const isHost = snapshot.hostPlayerId === privateState?.playerId;

  const handleReturnToWaiting = () =>
    void exec("game.advancePhase", undefined, {
      onSuccess: () => setReturned(true),
      fallback: "返回房间失败",
    });

  if (!summary) {
    return (
      <div className="mx-auto max-w-2xl space-y-5 py-8">
        <PhaseHeader icon={Trophy} title="游戏结束" />
        <section className="space-y-3 overflow-hidden rounded-md bg-muted p-4">
          <h3 className={SECTION_TITLE}>
            <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
            本局词语解密
          </h3>
          <p className="text-sm text-muted-foreground">结算数据同步中…</p>
        </section>
      </div>
    );
  }

  const hasHistory = Boolean(summary.history?.length);

  const winnerTone = WINNER_TONE[summary.winner];

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
        <h3 className={SECTION_TITLE}>
          <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
          本局词语解密
        </h3>
        {summary.words ? (
          <div
            className={cn(
              "grid grid-cols-2 gap-3 text-center",
              summary.words.blankHint && "md:grid-cols-3"
            )}
          >
            <div className="rounded-md border border-info/40 bg-info/10 p-3">
              <div className="text-xs text-info font-medium mb-1">平民词</div>
              <div className="text-base font-bold text-info">{summary.words.civilianWord}</div>
            </div>
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
              <div className="text-xs text-destructive font-medium mb-1">卧底词</div>
              <div className="text-base font-bold text-destructive">
                {summary.words.undercoverWord}
              </div>
            </div>
            {summary.words.blankHint && (
              // 与两张词卡同一套描边，提示不属于任何阵营，描边取中性色
              <div className="col-span-2 rounded-md border bg-background p-3 md:col-span-1">
                <div className="text-xs text-muted-foreground font-medium mb-1">白板提示</div>
                <div className="text-base font-bold text-foreground">{summary.words.blankHint}</div>
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
              role: <FakerRoleBadge role={role} inset />,
              delta,
              total,
            },
            // 结算快照里的累计分已含本局得分，从赛前分滚起
            rollFrom: { total: total - delta },
          };
        })}
      />

      {/* 全局历史已含每次投票与白板猜词 */}
      {hasHistory ? (
        <section className="overflow-hidden rounded-md bg-muted">
          <DisclosureHeader
            icon={<History className="h-3.5 w-3.5" aria-hidden="true" />}
            label="全局历史"
            open={showHistory}
            onToggle={() => setShowHistory((v) => !v)}
          />
          <CollapsibleRegion open={showHistory}>
            <FakerRoundHistoryTimeline history={summary.history ?? []} players={snapshot.players} />
          </CollapsibleRegion>
        </section>
      ) : null}

      {/* 房主可让全房回到等待阶段。 */}
      <div className="flex flex-wrap justify-center gap-2 pt-2">
        {isHost ? (
          <Button
            size="lg"
            onClick={handleReturnToWaiting}
            loading={returning}
            data-agent-control="faker.advance"
          >
            {returning ? null : <RotateCcw className="h-4 w-4" />}
            返回房间等待
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">等待房主返回房间</p>
        )}
      </div>
    </div>
  );
}
