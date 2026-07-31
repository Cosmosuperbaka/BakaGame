import { Clock3, Eye, Moon, Vote } from "lucide-react";
import { useGameStore } from "@/stores/useGameStore";
import { cn } from "@/lib/utils";

interface Props {
  mode: "vote" | "night";
}

export function PrivilegedActionPreview({ mode }: Props) {
  const snapshot = useGameStore((state) => state.snapshot);
  const privateState = useGameStore((state) => state.privateState);
  const preview = privateState?.privilegedActionPreview;

  if (!snapshot || !privateState?.questionerView || !preview) return null;

  const playerNames = new Map(snapshot.players.map((player) => [player.id, player.name]));
  const title = mode === "vote" ? "实时投票预览" : "实时夜间行动";
  const Icon = mode === "vote" ? Vote : Moon;

  const rows =
    mode === "vote"
      ? snapshot.players
          .filter((player) => {
            if (player.roundStatus !== "alive") return false;
            return !(
              snapshot.status.phase === "tieBreak" &&
              snapshot.status.tieBreakCandidateIds?.includes(player.id)
            );
          })
          .map((player) => {
            const vote = preview.votes.find((item) => item.voterId === player.id);
            return {
              id: player.id,
              name: player.name,
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
              value: action
                ? action.targetId
                  ? (playerNames.get(action.targetId) ?? "未知玩家")
                  : "无行动"
                : "等待行动",
              pending: !action,
            };
          });

  return (
    <section className="mx-auto w-full max-w-lg" aria-label={title}>
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-foreground text-background">
          <Icon className="h-3.5 w-3.5" />
        </span>
        {title}
        <span className="ml-auto inline-flex items-center gap-1 text-xs font-normal text-muted-foreground">
          <Eye className="h-3.5 w-3.5" />
          特权视角
        </span>
      </div>
      <div className="divide-y overflow-hidden rounded-md border bg-background">
        {rows.map((row) => (
          <div key={row.id} className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-3 py-2 text-sm">
            <span className="truncate font-medium">{row.name}</span>
            <span className="text-muted-foreground">→</span>
            <span
              className={cn(
                "flex items-center justify-end gap-1.5 truncate text-right",
                row.pending ? "text-muted-foreground" : "font-medium",
              )}
            >
              {row.pending && <Clock3 className="h-3.5 w-3.5 shrink-0" />}
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
