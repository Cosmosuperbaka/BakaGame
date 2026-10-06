import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, Clock3 } from "lucide-react";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { listItem, readoutSwap } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { ABSTAIN_TARGET_ID } from "@/types";
import { RoleBadge } from "./RoleBadge";

interface Props {
  mode: "vote" | "night";
}

export function PrivilegedActionPreview({ mode }: Props) {
  const snapshot = useWhoIsFakerStore((state) => state.snapshot);
  const privateState = useWhoIsFakerStore((state) => state.privateState);
  const preview = privateState?.privilegedActionPreview;

  if (!snapshot || !privateState?.questionerView || !preview) return null;

  const playerNames = new Map(snapshot.players.map((player) => [player.id, player.name]));
  const roleByPlayerId = new Map(
    privateState.questionerView.map((player) => [player.playerId, player.role]),
  );
  const alivePlayers = snapshot.players.filter((player) => player.roundStatus === "alive");
  const tieBreakCandidateIds = snapshot.status.tieBreakCandidateIds ?? [];
  const eligibleVoters = alivePlayers.filter(
    (player) =>
      !(
        snapshot.status.phase === "tieBreak" && tieBreakCandidateIds.includes(player.id)
      ),
  );

  const rows =
    mode === "vote"
      ? eligibleVoters.map((player) => {
          const vote = preview.votes.find((item) => item.voterId === player.id);
          return {
            id: player.id,
            name: player.name,
            role: roleByPlayerId.get(player.id),
            value: vote
              ? vote.targetId === ABSTAIN_TARGET_ID
                ? "弃票"
                : (playerNames.get(vote.targetId) ?? "未知玩家")
              : "等待投票",
            pending: !vote,
          };
        })
      : privateState.questionerView
          .filter(
            (player) =>
              player.alive && (player.role === "civilian" || player.role === "undercover"),
          )
          .map((player) => {
            const action = preview.nightActions.find((item) => item.actorId === player.playerId);
            return {
              id: player.playerId,
              name: playerNames.get(player.playerId) ?? "未知玩家",
              role: player.role,
              value: action
                ? action.targetId
                  ? (playerNames.get(action.targetId) ?? "未知玩家")
                  : "无行动"
                : "等待行动",
              pending: !action,
            };
          });

  const voteTargets =
    snapshot.status.phase === "tieBreak" && tieBreakCandidateIds.length > 0
      ? alivePlayers.filter((player) => tieBreakCandidateIds.includes(player.id))
      : alivePlayers;
  const voteCounts = new Map<string, number>();
  for (const vote of preview.votes) {
    voteCounts.set(vote.targetId, (voteCounts.get(vote.targetId) ?? 0) + 1);
  }
  const abstainCount = voteCounts.get(ABSTAIN_TARGET_ID) ?? 0;

  return (
    <section className="mx-auto w-full max-w-lg space-y-3" aria-label={mode === "vote" ? "投票预览" : "夜间行动预览"}>
      {mode === "vote" ? (
        <div className="grid grid-cols-2 gap-2">
          {voteTargets.map((player) => {
            const role = roleByPlayerId.get(player.id);
            return (
              <div key={player.id} className="flex min-w-0 items-center gap-2 rounded-md bg-muted px-3 py-2.5">
                {role ? <RoleBadge role={role} inset /> : null}
                <span title={player.name} className="min-w-0 flex-1 truncate text-sm font-medium">{player.name}</span>
                {/* 票数随投票逐位滚动，读作「又多了一票」 */}
                <AnimatedNumber
                  value={voteCounts.get(player.id) ?? 0}
                  className="shrink-0 rounded-md bg-background px-2 py-0.5 text-sm font-bold"
                />
              </div>
            );
          })}
          {/* 第一张弃票出现时卡片推入，弃票被撤回到 0 时退出 */}
          <AnimatePresence initial={false}>
            {abstainCount > 0 ? (
              <motion.div
                key="abstain"
                variants={listItem}
                initial="initial"
                animate="animate"
                exit="exit"
                className="flex origin-left items-center justify-between rounded-md bg-muted px-3 py-2.5 text-sm text-muted-foreground"
              >
                <span>弃票</span>
                <AnimatedNumber
                  value={abstainCount}
                  className="rounded-md bg-background px-2 py-0.5 font-bold text-foreground"
                />
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      ) : null}

      <div className="divide-y divide-background overflow-hidden rounded-md bg-muted">
        {rows.map((row) => (
          <div
            key={row.id}
            className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-3 py-2 text-sm"
          >
            <span className="flex min-w-0 items-center gap-2">
              {row.role ? <RoleBadge role={row.role} inset /> : null}
              <span title={row.name} className="truncate font-medium">{row.name}</span>
            </span>
            <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
            {/* 目标换人（投票、撤销、改投）时新读数自下顶上来，而不是原地闪一下 */}
            <span className="flex min-w-0 justify-end">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={row.value}
                  variants={readoutSwap}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  title={row.value}
                  className={cn(
                    "flex min-w-0 items-center justify-end gap-1.5 text-right",
                    row.pending ? "text-muted-foreground" : "font-medium",
                  )}
                >
                  {row.pending ? <Clock3 className="h-3.5 w-3.5 shrink-0" /> : null}
                  <span className="truncate">{row.value}</span>
                </motion.span>
              </AnimatePresence>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
