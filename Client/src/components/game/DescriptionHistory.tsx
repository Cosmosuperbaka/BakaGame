import { motion } from "framer-motion";
import { History, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DescriptionRecord, PublicPlayerView } from "@/types";

interface OverlayProps {
  players: PublicPlayerView[];
  descriptions: DescriptionRecord[];
  onClose: () => void;
}

export function DescriptionHistoryOverlay({
  players,
  descriptions,
  onClose,
}: OverlayProps) {
  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="发言历史"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className="absolute inset-0 z-40 flex items-start bg-black/45 backdrop-blur-[1px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <motion.section
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="relative w-full overflow-hidden border-b bg-background shadow-2xl md:rounded-b-lg md:border-x"
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          title="关闭发言历史"
          aria-label="关闭发言历史"
          className="absolute right-2 top-1.5 z-50 h-8 w-8 bg-background/90"
        >
          <X className="h-4 w-4" />
        </Button>
        <DescriptionTable descriptions={descriptions} players={players} overlay />
      </motion.section>
    </motion.div>
  );
}

interface DescriptionTableProps {
  descriptions: DescriptionRecord[];
  players?: PublicPlayerView[];
  compact?: boolean;
  overlay?: boolean;
}

export function DescriptionTable({
  descriptions,
  players,
  compact = false,
  overlay = false,
}: DescriptionTableProps) {
  const tablePlayers = new Map<string, { name: string; spectator: boolean }>();
  const orderedPlayers = players
    ? [
        ...players
          .filter((player) => player.membership === "active")
          .sort((a, b) => Number(b.isHost) - Number(a.isHost)),
        ...players.filter((player) => player.membership === "spectator"),
      ]
    : [];
  for (const player of orderedPlayers) {
    tablePlayers.set(player.id, {
      name: player.name,
      spectator: player.membership === "spectator",
    });
  }
  for (const description of descriptions) {
    if (!tablePlayers.has(description.playerId)) {
      tablePlayers.set(description.playerId, {
        name: description.playerName,
        spectator: false,
      });
    }
  }

  if (tablePlayers.size === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        暂无玩家与发言记录
      </p>
    );
  }

  const normalDescriptions = descriptions.filter(
    (description) => description.kind === "description",
  );
  const maxCycle = normalDescriptions.reduce(
    (maximum, description) => Math.max(maximum, description.cycle),
    0,
  );
  const cycles = Array.from({ length: maxCycle }, (_, index) => index + 1);

  const tieBreakDescriptions = descriptions.filter(
    (description) => description.kind === "tieBreak",
  );
  const tieBreakIndices = [
    ...new Set(
      tieBreakDescriptions.map((description) => description.tieBreakIndex ?? 1),
    ),
  ].sort((a, b) => a - b);

  const supplementDescriptions = descriptions.filter(
    (description) => description.kind === "supplement",
  );
  const supplementIndices = [
    ...new Set(
      supplementDescriptions.map(
        (description) => description.supplementIndex ?? 1,
      ),
    ),
  ].sort((a, b) => a - b);

  const normalIndex = indexDescriptions(normalDescriptions, (description) => description.cycle);
  const tieBreakIndex = indexDescriptions(
    tieBreakDescriptions,
    (description) => description.tieBreakIndex ?? 1,
  );
  const supplementIndex = indexDescriptions(
    supplementDescriptions,
    (description) => description.supplementIndex ?? 1,
  );
  const hasDescriptionColumns =
    cycles.length + tieBreakIndices.length + supplementIndices.length > 0;
  const descriptionColumnCount = Math.max(
    1,
    cycles.length + tieBreakIndices.length + supplementIndices.length,
  );

  const cellPadding = compact ? "px-3 py-2" : "px-4 py-3";
  const playerColumnWidth = overlay
    ? "w-64 min-w-[16rem] max-w-64"
    : "min-w-[100px]";

  return (
    <div
      className={cn(
        "overflow-auto bg-background",
        overlay
          ? "max-h-[calc(100vh-5rem)] md:max-h-[min(72vh,720px)]"
          : "rounded-md border shadow-xs",
      )}
    >
      <table
        className="w-full table-fixed border-collapse text-left text-sm"
        style={{
          minWidth: `${(overlay ? 256 : 100) + descriptionColumnCount * 180}px`,
        }}
      >
        <colgroup>
          <col style={{ width: overlay ? 256 : 100 }} />
          {Array.from({ length: descriptionColumnCount }, (_, index) => (
            <col key={index} />
          ))}
        </colgroup>
        <thead className="text-xs font-semibold text-muted-foreground">
          <tr>
            <th
              className={cn(
                "sticky left-0 top-0 z-30 border-b border-r bg-muted px-4 py-3",
                playerColumnWidth,
              )}
            >
              <span className="flex items-center gap-2">
                <History className="h-4 w-4" />
                玩家
              </span>
            </th>
            {cycles.map((cycle) => (
              <th
                key={`c-${cycle}`}
                className="sticky top-0 z-20 min-w-[180px] border-b border-r bg-muted px-4 py-3"
              >
                第 {cycle} 轮
              </th>
            ))}
            {tieBreakIndices.map((index) => (
              <th
                key={`tb-${index}`}
                className="sticky top-0 z-20 min-w-[180px] border-b border-r bg-muted px-4 py-3 text-amber-700 dark:text-amber-400"
              >
                平票 {index}
              </th>
            ))}
            {supplementIndices.map((index) => (
              <th
                key={`sup-${index}`}
                className="sticky top-0 z-20 min-w-[180px] border-b border-r bg-muted px-4 py-3 pr-12 text-sky-700 dark:text-sky-400"
              >
                补充 {index}
              </th>
            ))}
            {!hasDescriptionColumns ? (
              <th className="sticky top-0 z-20 min-w-[180px] border-b bg-muted px-4 py-3 pr-12">
                暂无发言
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y text-foreground">
          {[...tablePlayers.entries()].map(([playerId, player]) => (
            <tr key={playerId} className="hover:bg-muted/20">
              <td
                className={cn(
                  "sticky left-0 z-10 border-r bg-background font-medium",
                  cellPadding,
                  playerColumnWidth,
                )}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{player.name}</span>
                  {player.spectator ? (
                    <span className="shrink-0 text-[10px] font-normal text-muted-foreground">
                      旁观
                    </span>
                  ) : null}
                </span>
              </td>
              {cycles.map((cycle) => (
                <DescriptionCell
                  key={`c-${cycle}`}
                  description={normalIndex.get(playerId)?.get(cycle)}
                  className={cellPadding}
                />
              ))}
              {tieBreakIndices.map((index) => (
                <DescriptionCell
                  key={`tb-${index}`}
                  description={tieBreakIndex.get(playerId)?.get(index)}
                  className={cn(
                    cellPadding,
                    "font-medium text-amber-950 dark:text-amber-100",
                  )}
                />
              ))}
              {supplementIndices.map((index) => (
                <DescriptionCell
                  key={`sup-${index}`}
                  description={supplementIndex.get(playerId)?.get(index)}
                  className={cn(
                    cellPadding,
                    "text-sky-950 dark:text-sky-100",
                  )}
                />
              ))}
              {!hasDescriptionColumns ? (
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
      {description?.text ?? (
        <span className="text-muted-foreground/40">-</span>
      )}
    </td>
  );
}
