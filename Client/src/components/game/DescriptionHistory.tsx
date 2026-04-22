import { motion } from "framer-motion";
import { X, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useGame } from "@/contexts/GameContext";
import { cn } from "@/lib/utils";
import type { DescriptionRecord } from "@/types";

interface Props {
  onClose: () => void;
}

// 描述复盘：以表格行的形式铺开整局所有描述，覆盖游戏区。
export function DescriptionHistoryView({ onClose }: Props) {
  const { state } = useGame();
  const snapshot = state.snapshot;
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
      <div className="flex items-center justify-between px-5 md:px-7 pt-5 pb-3 shrink-0">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">本局描述</h2>
          <span className="text-xs text-muted-foreground">
            （包括已淘汰玩家）
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="gap-1.5 text-muted-foreground"
        >
          <X className="h-4 w-4" />
          关闭
        </Button>
      </div>
      <ScrollArea className="flex-1 px-5 md:px-7 pb-6">
        <DescriptionTable descriptions={snapshot.descriptions} />
      </ScrollArea>
    </motion.div>
  );
}

// 结算页复用的描述表格（没有关闭按钮，纯展示）。
export function DescriptionTable({
  descriptions,
  compact = false,
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

  const cycles = new Map<number, DescriptionRecord[]>();
  for (const d of descriptions) {
    const list = cycles.get(d.cycle) ?? [];
    list.push(d);
    cycles.set(d.cycle, list);
  }

  return (
    <div className={cn("space-y-5", compact && "space-y-3")}>
      {[...cycles.entries()].map(([cycle, entries]) => (
        <div key={cycle}>
          <h4 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            第 {cycle} 轮
          </h4>
          <div className="rounded-lg border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr className="text-left">
                  <th className="px-3 py-2 w-32 font-medium text-xs text-muted-foreground">
                    玩家
                  </th>
                  <th className="px-3 py-2 font-medium text-xs text-muted-foreground">
                    描述
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {entries.map((d) => (
                  <tr key={d.id} className="hover:bg-muted/20">
                    <td className="px-3 py-2 font-medium truncate">
                      {d.playerName}
                    </td>
                    <td className="px-3 py-2 text-foreground/85 leading-relaxed">
                      {d.text}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
