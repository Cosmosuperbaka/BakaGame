import { History } from "lucide-react";
import { cn } from "@/lib/utils";
import { PlayerRow, type PlayerMarks, type PlayerRowProps } from "@/components/room/PlayerList";
import type { DescriptionRecord, PlayerRole, PublicPlayerView } from "@/types";

/** 传给表格首列的 PlayerRow 上下文，由 RoomPage 统一组装 */
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

/**
 * 发言历史表格 — 始终渲染，由父容器的 overflow-hidden + width 动画控制可见范围。
 * 第一列宽度固定为 256px，与玩家栏等宽，展开时无缝衔接。
 */
export function DescriptionTable({ descriptions, players, playerRowContext, compact = false }: DescriptionTableProps) {
  const cellPad = compact ? "px-3 py-2" : "px-4 py-3";

  // 按 活跃/出题/旁观 顺序排列，与 PlayerList 保持一致
  const orderedPlayers = players
    ? [
        ...players
          .filter((p) => p.membership === "active" && p.roundStatus !== "questioner")
          .sort((a, b) => Number(b.isHost) - Number(a.isHost)),
        ...players.filter((p) => p.membership === "spectator" || p.roundStatus === "questioner"),
      ]
    : [];

  // 补充只在 descriptions 里出现但不在 players 里的玩家（已离场）
  const tablePlayers = new Map<string, PublicPlayerView>();
  for (const p of orderedPlayers) tablePlayers.set(p.id, p);
  for (const d of descriptions) {
    if (!tablePlayers.has(d.playerId)) {
      tablePlayers.set(d.playerId, {
        id: d.playerId,
        name: d.playerName,
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
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">暂无玩家与发言记录</p>
    );
  }

  // 计算各列分组
  const normalDescs = descriptions.filter((d) => d.kind === "description");
  const maxCycle = normalDescs.reduce((m, d) => Math.max(m, d.cycle), 0);
  const cycles = Array.from({ length: maxCycle }, (_, i) => i + 1);

  const tieBreakIndices = [
    ...new Set(
      descriptions.filter((d) => d.kind === "tieBreak").map((d) => d.tieBreakIndex ?? 1),
    ),
  ].sort((a, b) => a - b);

  const supplementIndices = [
    ...new Set(
      descriptions.filter((d) => d.kind === "supplement").map((d) => d.supplementIndex ?? 1),
    ),
  ].sort((a, b) => a - b);

  const normalIdx = indexDescriptions(normalDescs, (d) => d.cycle);
  const tieIdx = indexDescriptions(
    descriptions.filter((d) => d.kind === "tieBreak"),
    (d) => d.tieBreakIndex ?? 1,
  );
  const supIdx = indexDescriptions(
    descriptions.filter((d) => d.kind === "supplement"),
    (d) => d.supplementIndex ?? 1,
  );

  const colCount = cycles.length + tieBreakIndices.length + supplementIndices.length;
  const minWidth = 256 + Math.max(1, colCount) * 180;

  return (
    <div className="h-full overflow-auto">
      <table
        className="w-full table-fixed border-collapse text-left text-sm"
        style={{ minWidth }}
      >
        <colgroup>
          <col style={{ width: 256 }} />
          {Array.from({ length: Math.max(1, colCount) }, (_, i) => (
            <col key={i} />
          ))}
        </colgroup>

        <thead className="text-xs font-semibold text-muted-foreground">
          <tr>
            {/* 首列标题 — sticky 于横向和纵向 */}
            <th className="sticky left-0 top-0 z-30 w-64 min-w-64 max-w-64 border-b border-r bg-panel px-4 py-3">
              <span className="flex items-center gap-2">
                <History className="h-3.5 w-3.5" />
                玩家
              </span>
            </th>
            {cycles.map((c) => (
              <th
                key={`c-${c}`}
                className="sticky top-0 z-20 min-w-[180px] border-b border-r bg-panel px-4 py-3"
              >
                第 {c} 轮
              </th>
            ))}
            {tieBreakIndices.map((idx) => (
              <th
                key={`tb-${idx}`}
                className="sticky top-0 z-20 min-w-[180px] border-b border-r bg-panel px-4 py-3 text-amber-700"
              >
                平票 {idx}
              </th>
            ))}
            {supplementIndices.map((idx) => (
              <th
                key={`sup-${idx}`}
                className="sticky top-0 z-20 min-w-[180px] border-b border-r bg-panel px-4 py-3 text-sky-700"
              >
                补充 {idx}
              </th>
            ))}
            {colCount === 0 && (
              <th className="sticky top-0 z-20 min-w-[180px] border-b bg-panel px-4 py-3">
                暂无发言
              </th>
            )}
          </tr>
        </thead>

        <tbody className="divide-y divide-background text-foreground">
          {[...tablePlayers.values()].map((player) => (
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
                  <span className={cn("flex min-w-0 items-center gap-2 truncate font-medium", cellPad)}>
                    {player.name}
                    {player.roundStatus === "questioner" && (
                      <span className="shrink-0 text-[10px] text-muted-foreground">出题</span>
                    )}
                  </span>
                )}
              </td>
              {cycles.map((c) => (
                <DescriptionCell
                  key={`c-${c}`}
                  description={normalIdx.get(player.id)?.get(c)}
                />
              ))}
              {tieBreakIndices.map((idx) => (
                <DescriptionCell
                  key={`tb-${idx}`}
                  description={tieIdx.get(player.id)?.get(idx)}
                  accent="amber"
                />
              ))}
              {supplementIndices.map((idx) => (
                <DescriptionCell
                  key={`sup-${idx}`}
                  description={supIdx.get(player.id)?.get(idx)}
                  accent="sky"
                />
              ))}
              {colCount === 0 && <DescriptionCell />}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── 工具函数 ─────────────────────────────────────────────── */

function indexDescriptions(
  descriptions: DescriptionRecord[],
  getCol: (d: DescriptionRecord) => number,
) {
  const index = new Map<string, Map<number, DescriptionRecord>>();
  for (const d of descriptions) {
    const byPlayer = index.get(d.playerId) ?? new Map<number, DescriptionRecord>();
    byPlayer.set(getCol(d), d);
    index.set(d.playerId, byPlayer);
  }
  return index;
}

function DescriptionCell({
  description,
  accent,
}: {
  description?: DescriptionRecord;
  accent?: "amber" | "sky";
}) {
  return (
    <td
      className={cn(
        "border-r px-4 py-3 text-sm leading-relaxed",
        accent === "amber" && "text-amber-900",
        accent === "sky" && "text-sky-900",
      )}
    >
      {description?.text ?? <span className="text-muted-foreground/40">—</span>}
    </td>
  );
}
