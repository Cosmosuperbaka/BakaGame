import { motion } from "framer-motion";
import { X, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useGameStore } from "@/stores/useGameStore";
import type { DescriptionRecord } from "@/types";

interface Props {
  onClose: () => void;
}

export function DescriptionHistoryView({ onClose }: Props) {
  const snapshot = useGameStore((s) => s.snapshot);
  if (!snapshot) return null;

  return (
    <motion.div
      key="description-history"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="absolute inset-0 z-20 bg-background flex flex-col"
    >
      <div className="flex items-center justify-between px-5 md:px-7 pt-5 pb-3 border-b shrink-0">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-primary" />
          <h2 className="text-base font-semibold">本局描述复盘</h2>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
          关闭
        </Button>
      </div>
      <ScrollArea className="flex-1 p-5 md:p-7">
        <DescriptionTable descriptions={snapshot.descriptions} />
      </ScrollArea>
    </motion.div>
  );
}

export function DescriptionTable({
  descriptions,
}: {
  descriptions: DescriptionRecord[];
  compact?: boolean;
}) {
  if (descriptions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-8">
        暂无描述记录
      </p>
    );
  }

  // 整理所有出现的玩家（按首次出现顺序）
  const playerNames = new Map<string, string>();
  for (const d of descriptions) {
    if (!playerNames.has(d.playerId)) playerNames.set(d.playerId, d.playerName);
  }

  const normalDescs = descriptions.filter((d) => d.kind === "description");
  const maxCycle = normalDescs.length > 0 ? Math.max(...normalDescs.map((d) => d.cycle)) : 0;
  const cycles = maxCycle > 0 ? Array.from({ length: maxCycle }, (_, i) => i + 1) : [];

  // 平票 PK 列：每个不同的 tieBreakIndex 为独立一列。
  const tieBreakDescs = descriptions.filter((d) => d.kind === "tieBreak");
  const tieBreakIndices = [...new Set(tieBreakDescs.map((d) => d.tieBreakIndex ?? 1))].sort(
    (a, b) => a - b
  );

  // 补充发言列：每个不同的 supplementIndex 为独立一列。
  const supplementDescs = descriptions.filter((d) => d.kind === "supplement");
  const supplementIndices = [...new Set(supplementDescs.map((d) => d.supplementIndex ?? 1))].sort(
    (a, b) => a - b
  );

  return (
    <div className="rounded-xl border overflow-x-auto bg-card shadow-xs">
      <table className="w-full text-sm text-left border-collapse">
        <thead className="bg-muted/40 text-xs font-semibold text-muted-foreground border-b">
          <tr>
            <th className="px-4 py-3 min-w-[100px] border-r">玩家</th>
            {cycles.map((c) => (
              <th key={`c-${c}`} className="px-4 py-3 min-w-[140px] border-r">
                第 {c} 轮
              </th>
            ))}
            {tieBreakIndices.map((idx) => (
              <th
                key={`tb-${idx}`}
                className="px-4 py-3 min-w-[140px] border-r text-amber-600 dark:text-amber-500"
              >
                平票{idx}
              </th>
            ))}
            {supplementIndices.map((idx) => (
              <th
                key={`sup-${idx}`}
                className="px-4 py-3 min-w-[140px] border-r text-sky-600 dark:text-sky-400"
              >
                补充{idx}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y text-foreground">
          {[...playerNames.entries()].map(([playerId, name]) => (
            <tr key={playerId} className="hover:bg-muted/20">
              <td className="px-4 py-3 font-medium border-r bg-muted/10 truncate max-w-[120px]">
                {name}
              </td>
              {cycles.map((c) => {
                const desc = normalDescs.find(
                  (d) => d.playerId === playerId && d.cycle === c
                );
                return (
                  <td key={`c-${c}`} className="px-4 py-3 border-r text-foreground/90 leading-relaxed">
                    {desc ? desc.text : <span className="text-muted-foreground/40">—</span>}
                  </td>
                );
              })}
              {tieBreakIndices.map((idx) => {
                const desc = tieBreakDescs.find(
                  (d) => d.playerId === playerId && (d.tieBreakIndex ?? 1) === idx
                );
                return (
                  <td
                    key={`tb-${idx}`}
                    className="px-4 py-3 border-r text-amber-950 dark:text-amber-100 font-medium leading-relaxed"
                  >
                    {desc ? desc.text : <span className="text-muted-foreground/40">—</span>}
                  </td>
                );
              })}
              {supplementIndices.map((idx) => {
                const desc = supplementDescs.find(
                  (d) => d.playerId === playerId && (d.supplementIndex ?? 1) === idx
                );
                return (
                  <td
                    key={`sup-${idx}`}
                    className="px-4 py-3 border-r text-sky-950 dark:text-sky-100 leading-relaxed"
                  >
                    {desc ? desc.text : <span className="text-muted-foreground/40">—</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
