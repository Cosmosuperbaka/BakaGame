import { Clock3 } from "lucide-react";
import { ROLE_COLORS, ROLE_LABELS } from "@/lib/helpers";
import { cn } from "@/lib/utils";
import { useGameStore } from "@/stores/useGameStore";
import type { PlayerRole } from "@/types";

interface Props {
  mode: "vote" | "night";
}

function RoleLabel({ role }: { role?: PlayerRole }) {
  if (!role) return null;
  return (
    <span className={cn("shrink-0 rounded bg-background/75 px-1.5 py-0.5 text-[11px] font-semibold", ROLE_COLORS[role])}>
      {ROLE_LABELS[role]}
    </span>
  );
}

export function PrivilegedActionPreview({ mode }: Props) {
  const snapshot = useGameStore((state) => state.snapshot);
  const privateState = useGameStore((state) => state.privateState);
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
              ? vote.targetId === "abstain"
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

  return (
    <section className="mx-auto w-full max-w-lg space-y-3" aria-label={mode === "vote" ? "投票预览" : "夜间行动预览"}>
      {mode === "vote" ? (
        <div className="grid grid-cols-2 gap-2">
          {voteTargets.map((player) => (
            <div key={player.id} className="flex min-w-0 items-center gap-2 rounded-md bg-muted px-3 py-2.5">
              <RoleLabel role={roleByPlayerId.get(player.id)} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{player.name}</span>
              <span className="shrink-0 rounded bg-background/80 px-2 py-0.5 text-sm font-bold tabular-nums">
                {voteCounts.get(player.id) ?? 0}
              </span>
            </div>
          ))}
          {(voteCounts.get("abstain") ?? 0) > 0 ? (
            <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2.5 text-sm text-muted-foreground">
              <span>弃票</span>
              <span className="rounded bg-background/80 px-2 py-0.5 font-bold tabular-nums text-foreground">
                {voteCounts.get("abstain")}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="divide-y divide-background overflow-hidden rounded-md bg-muted">
        {rows.map((row) => (
          <div
            key={row.id}
            className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-3 py-2 text-sm"
          >
            <span className="flex min-w-0 items-center gap-2">
              <RoleLabel role={row.role} />
              <span className="truncate font-medium">{row.name}</span>
            </span>
            <span className="text-muted-foreground">→</span>
            <span
              className={cn(
                "flex items-center justify-end gap-1.5 truncate text-right",
                row.pending ? "text-muted-foreground" : "font-medium",
              )}
            >
              {row.pending ? <Clock3 className="h-3.5 w-3.5 shrink-0" /> : null}
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
