import { History } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  buildDescriptionColumns,
  DESCRIPTION_HEAD_TONES,
  DESCRIPTION_TONES,
  type DescriptionColumn,
} from "@/lib/descriptionColumns";
import { PlayerRow, type PlayerMarks, type PlayerRowProps } from "@/components/room/PlayerList";
import type { DescriptionRecord, PlayerRole, PublicPlayerView } from "@/types";

/** 传给表格首列的 PlayerRow 上下文，由调用方统一组装 */
export type DescriptionTableContext = Omit<
  PlayerRowProps,
  "player" | "embedded" | "actualRole" | "mark"
> & {
  actualRoleByPlayerId: Map<string, PlayerRole>;
  playerMarks: PlayerMarks;
};

interface DescriptionTableProps {
  descriptions: DescriptionRecord[];
  /** 有玩家列表时渲染可交互首列；省略时退回为只读姓名格 */
  players?: PublicPlayerView[];
  playerRowContext?: DescriptionTableContext;
  /** 紧凑模式：减少内边距，用于游戏结束摘要 */
  compact?: boolean;
}

/** 与 PlayerList 一致的分组顺序：活跃玩家在前，出题与旁观在后。 */
function orderPlayers(players: PublicPlayerView[]): PublicPlayerView[] {
  return [
    ...players
      .filter((p) => p.membership === "active" && p.roundStatus !== "questioner")
      .sort((a, b) => Number(b.isHost) - Number(a.isHost)),
    ...players.filter((p) => p.membership === "spectator" || p.roundStatus === "questioner"),
  ];
}

/** 补上只在发言记录里出现、已不在玩家列表中的玩家（已离场）。 */
function collectRows(
  players: PublicPlayerView[] | undefined,
  descriptions: DescriptionRecord[],
): PublicPlayerView[] {
  const rows = new Map<string, PublicPlayerView>();
  for (const player of orderPlayers(players ?? [])) rows.set(player.id, player);
  for (const record of descriptions) {
    if (rows.has(record.playerId)) continue;
    rows.set(record.playerId, {
      id: record.playerId,
      name: record.playerName,
      score: 0,
      membership: "active",
      online: true,
      isReady: false,
      isBot: false,
      isHost: false,
      roundStatus: "waiting",
    });
  }
  return [...rows.values()];
}

/**
 * 发言历史表格。自带玩家首列，用于战报复盘等没有相邻玩家栏的场景。
 * 房间页展开侧栏时不走这里 —— 那里的发言单元格直接渲染进玩家行内。
 */
export function DescriptionTable({
  descriptions,
  players,
  playerRowContext,
  compact = false,
}: DescriptionTableProps) {
  const { columns, byPlayer } = buildDescriptionColumns(descriptions);
  const rows = collectRows(players, descriptions);

  if (rows.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">暂无玩家与发言记录</p>;
  }

  const cellPad = compact ? "px-3 py-2" : "px-4 py-3";
  const headColumns: DescriptionColumn[] =
    columns.length > 0
      ? columns
      : [{ key: "empty", label: "暂无发言", tone: "default", expectedPlayerIds: new Set<string>() }];
  const minWidth = 256 + headColumns.length * 180;

  return (
    <div className="h-full overflow-auto">
      <table className="w-full table-fixed border-collapse text-left text-sm" style={{ minWidth }}>
        <colgroup>
          <col style={{ width: 256 }} />
          {headColumns.map((column) => (
            <col key={column.key} />
          ))}
        </colgroup>

        <thead className="text-xs font-semibold text-muted-foreground">
          <tr>
            <th className="sticky left-0 top-0 z-30 w-64 min-w-64 max-w-64 border-b border-r bg-panel px-4 py-3">
              <span className="flex items-center gap-2">
                <History className="h-3.5 w-3.5" />
                玩家
              </span>
            </th>
            {headColumns.map((column) => (
              <th
                key={column.key}
                className={cn(
                  "sticky top-0 z-20 min-w-[180px] border-b border-r bg-panel px-4 py-3",
                  DESCRIPTION_HEAD_TONES[column.tone],
                )}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>

        <tbody className="divide-y divide-background text-foreground">
          {rows.map((player) => (
            <tr key={player.id} className="hover:bg-accent/20">
              <td className="sticky left-0 z-10 w-64 min-w-64 max-w-64 border-r bg-panel p-0">
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
                  <span
                    className={cn("flex min-w-0 items-center gap-2 truncate font-medium", cellPad)}
                  >
                    {player.name}
                    {player.roundStatus === "questioner" && (
                      <span className="shrink-0 text-[10px] text-muted-foreground">出题</span>
                    )}
                  </span>
                )}
              </td>
              {headColumns.map((column) => (
                <td
                  key={column.key}
                  className={cn(
                    "border-r text-sm leading-relaxed",
                    cellPad,
                    DESCRIPTION_TONES[column.tone],
                  )}
                >
                  {/* 该轮无需发言的玩家留空，只有确实缺席发言的格子标短横线 */}
                  {byPlayer.get(player.id)?.get(column.key)?.text ??
                    (column.expectedPlayerIds.has(player.id) ? (
                      <span className="text-muted-foreground/40">—</span>
                    ) : null)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
