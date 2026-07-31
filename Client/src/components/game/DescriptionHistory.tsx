import { motion } from "framer-motion";
import { History, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PlayerRow, type PlayerMarks, type PlayerRowProps } from "@/components/room/PlayerList";
import type { DescriptionRecord, PlayerRole, PublicPlayerView } from "@/types";

interface OverlayProps {
  players: PublicPlayerView[];
  descriptions: DescriptionRecord[];
  onClose: () => void;
  playerRowContext: Omit<PlayerRowProps, "player" | "embedded" | "actualRole" | "mark"> & {
    actualRoleByPlayerId: Map<string, PlayerRole>;
    playerMarks: PlayerMarks;
  };
}

export function DescriptionHistoryOverlay({
  players,
  descriptions,
  onClose,
  playerRowContext,
}: OverlayProps) {
  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="发言历史"
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -10 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="absolute inset-0 z-40 overflow-hidden bg-card shadow-2xl"
    >
      <Button
        variant="ghost"
        size="icon"
        onClick={onClose}
        title="收起发言历史"
        aria-label="收起发言历史"
        className="absolute right-2 top-2 z-50 h-8 w-8 bg-background/90"
      >
        <X className="h-4 w-4" />
      </Button>
      <DescriptionTable
        descriptions={descriptions}
        players={players}
        overlay
        playerRowContext={playerRowContext}
      />
    </motion.div>
  );
}

interface DescriptionTableProps {
  descriptions: DescriptionRecord[];
  players?: PublicPlayerView[];
  compact?: boolean;
  overlay?: boolean;
  playerRowContext?: OverlayProps["playerRowContext"];
}

export function DescriptionTable({
  descriptions,
  players,
  compact = false,
  overlay = false,
  playerRowContext,
}: DescriptionTableProps) {
  const orderedPlayers = players
    ? [
        ...players
          .filter(
            (player) => player.membership === "active" && player.roundStatus !== "questioner",
          )
          .sort((left, right) => Number(right.isHost) - Number(left.isHost)),
        ...players.filter(
          (player) => player.membership === "spectator" || player.roundStatus === "questioner",
        ),
      ]
    : [];
  const tablePlayers = new Map<string, PublicPlayerView>();
  for (const player of orderedPlayers) tablePlayers.set(player.id, player);
  for (const description of descriptions) {
    if (!tablePlayers.has(description.playerId)) {
      tablePlayers.set(description.playerId, {
        id: description.playerId,
        name: description.playerName,
        score: 0,
        membership: "active",
        online: true,
        isReady: false,
        isBot: false,
        isHost: false,
        roundStatus: "waiting",
      });
    }
  }

  if (tablePlayers.size === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">暂无玩家与发言记录</p>;
  }

  const normalDescriptions = descriptions.filter((description) => description.kind === "description");
  const maxCycle = normalDescriptions.reduce(
    (maximum, description) => Math.max(maximum, description.cycle),
    0,
  );
  const cycles = Array.from({ length: maxCycle }, (_, index) => index + 1);
  const tieBreakIndices = [
    ...new Set(
      descriptions
        .filter((description) => description.kind === "tieBreak")
        .map((description) => description.tieBreakIndex ?? 1),
    ),
  ].sort((a, b) => a - b);
  const supplementIndices = [
    ...new Set(
      descriptions
        .filter((description) => description.kind === "supplement")
        .map((description) => description.supplementIndex ?? 1),
    ),
  ].sort((a, b) => a - b);
  const normalIndex = indexDescriptions(normalDescriptions, (description) => description.cycle);
  const tieBreakIndex = indexDescriptions(
    descriptions.filter((description) => description.kind === "tieBreak"),
    (description) => description.tieBreakIndex ?? 1,
  );
  const supplementIndex = indexDescriptions(
    descriptions.filter((description) => description.kind === "supplement"),
    (description) => description.supplementIndex ?? 1,
  );
  const columnCount = Math.max(1, cycles.length + tieBreakIndices.length + supplementIndices.length);
  const cellPadding = compact ? "px-3 py-2" : "px-4 py-3";
  const playerColumnWidth = overlay ? "w-64 min-w-64 max-w-64" : "min-w-[100px]";

  return (
    <div
      className={cn(
        "overflow-auto bg-card",
        overlay ? "h-full" : "rounded-md bg-muted",
      )}
    >
      <table
        className="w-full table-fixed border-collapse text-left text-sm"
        style={{ minWidth: `${(overlay ? 256 : 100) + columnCount * 180}px` }}
      >
        <colgroup>
          <col style={{ width: overlay ? 256 : 100 }} />
          {Array.from({ length: columnCount }, (_, index) => <col key={index} />)}
        </colgroup>
        <thead className="text-xs font-semibold text-muted-foreground">
          <tr>
            <th className={cn("sticky left-0 top-0 z-30 border-b border-r bg-muted px-4 py-3", playerColumnWidth)}>
              <span className="flex items-center gap-2">
                <History className="h-4 w-4" />
                玩家
              </span>
            </th>
            {cycles.map((cycle) => (
              <th key={`c-${cycle}`} className="sticky top-0 z-20 min-w-[180px] border-b border-r bg-muted px-4 py-3">
                第 {cycle} 轮
              </th>
            ))}
            {tieBreakIndices.map((index) => (
              <th key={`tb-${index}`} className="sticky top-0 z-20 min-w-[180px] border-b border-r bg-muted px-4 py-3 text-amber-700">
                平票 {index}
              </th>
            ))}
            {supplementIndices.map((index) => (
              <th key={`sup-${index}`} className="sticky top-0 z-20 min-w-[180px] border-b border-r bg-muted px-4 py-3 text-sky-700">
                补充 {index}
              </th>
            ))}
            {columnCount === 1 && cycles.length + tieBreakIndices.length + supplementIndices.length === 0 ? (
              <th className="sticky top-0 z-20 min-w-[180px] border-b bg-muted px-4 py-3">暂无发言</th>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-background text-foreground">
          {[...tablePlayers.values()].map((player) => (
            <tr key={player.id} className="hover:bg-muted/50">
              <td
                className={cn(
                  "sticky left-0 z-10 border-r bg-card",
                  overlay ? "p-0" : cellPadding,
                  playerColumnWidth,
                )}
              >
                {playerRowContext ? (
                  <PlayerRow
                    {...playerRowContext}
                    player={player}
                    actualRole={playerRowContext.actualRoleByPlayerId.get(player.id)}
                    mark={playerRowContext.playerMarks[player.id] ?? "unknown"}
                    canMark={
                      playerRowContext.canMark &&
                      player.membership === "active" &&
                      player.roundStatus !== "questioner"
                    }
                    embedded
                  />
                ) : (
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">{player.name}</span>
                    {player.roundStatus === "questioner" ? (
                      <span className="shrink-0 text-[10px] text-muted-foreground">出题</span>
                    ) : null}
                  </span>
                )}
              </td>
              {cycles.map((cycle) => (
                <DescriptionCell key={`c-${cycle}`} description={normalIndex.get(player.id)?.get(cycle)} className={cellPadding} />
              ))}
              {tieBreakIndices.map((index) => (
                <DescriptionCell key={`tb-${index}`} description={tieBreakIndex.get(player.id)?.get(index)} className={cn(cellPadding, "text-amber-950")} />
              ))}
              {supplementIndices.map((index) => (
                <DescriptionCell key={`sup-${index}`} description={supplementIndex.get(player.id)?.get(index)} className={cn(cellPadding, "text-sky-950")} />
              ))}
              {columnCount === 1 && cycles.length + tieBreakIndices.length + supplementIndices.length === 0 ? (
                <DescriptionCell className={cellPadding} />
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function indexDescriptions(
  descriptions: DescriptionRecord[],
  getColumn: (description: DescriptionRecord) => number,
) {
  const index = new Map<string, Map<number, DescriptionRecord>>();
  for (const description of descriptions) {
    const playerDescriptions = index.get(description.playerId) ?? new Map();
    playerDescriptions.set(getColumn(description), description);
    index.set(description.playerId, playerDescriptions);
  }
  return index;
}

function DescriptionCell({
  description,
  className,
}: {
  description?: DescriptionRecord;
  className?: string;
}) {
  return (
    <td className={cn("border-r leading-relaxed text-foreground/90", className)}>
      {description?.text ?? <span className="text-muted-foreground/40">-</span>}
    </td>
  );
}
