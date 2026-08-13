/* eslint-disable react-refresh/only-export-components -- 历史表测试共享纯数据辅助函数。 */
import { History } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  buildDescriptionColumns,
  DESCRIPTION_HEAD_TONES,
  DESCRIPTION_TONES,
  descriptionCellShadeForPlayer,
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

/** 补上只在发言记录里出现、已不在玩家列表中的玩家（已离场）。 */
export function collectDescriptionRows(
  players: PublicPlayerView[] | undefined,
  descriptions: DescriptionRecord[],
): PublicPlayerView[] {
  const rows = new Map<string, PublicPlayerView>();
  // 快照中的玩家数组就是 PlayerList 的实际渲染顺序，历史表不得另行排序。
  for (const player of players ?? []) rows.set(player.id, player);
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
  const rows = collectDescriptionRows(players, descriptions);

  if (rows.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">暂无玩家与发言记录</p>;
  }

  const cellPad = compact ? "px-3 py-2" : "px-4 py-3";
  const headColumns: DescriptionColumn[] =
    columns.length > 0
      ? columns
      : [
          {
            key: "empty",
            label: "暂无发言",
            tone: "default",
            index: 0,
            expectedPlayerIds: new Set<string>(),
          },
        ];

  return (
    <div className="scrollbar-hidden h-full overflow-auto">
      {/* table-auto 让每列按本列最长的一句取宽，不再统一均分 */}
      <table className="w-full table-auto border-collapse text-left text-sm">
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
                  "sticky top-0 z-20 min-w-[180px] whitespace-nowrap border-b border-r bg-panel px-4 py-3",
                  DESCRIPTION_HEAD_TONES[column.tone],
                )}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>

        <tbody className="divide-y divide-background text-foreground">
          {rows.map((player, rowIndex) => (
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
                    "whitespace-nowrap border-r text-sm leading-relaxed",
                    cellPad,
                    DESCRIPTION_TONES[column.tone],
                    descriptionCellShadeForPlayer(player, rowIndex, column.index),
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
