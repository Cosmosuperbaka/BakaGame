import type { DescriptionRecord } from "@/types";

/** 发言历史的一列。轮次、平票 PK 与补充发言各自独立编号。 */
export interface DescriptionColumn {
  key: string;
  label: string;
  tone: "default" | "amber" | "sky";
}

export interface DescriptionColumnModel {
  columns: DescriptionColumn[];
  /** playerId → columnKey → 发言记录 */
  byPlayer: Map<string, Map<string, DescriptionRecord>>;
}

/** 把发言记录归入所属列，并给出该记录的列键。 */
function columnKeyOf(record: DescriptionRecord): string {
  if (record.kind === "tieBreak") return `tie-${record.tieBreakIndex ?? 1}`;
  if (record.kind === "supplement") return `sup-${record.supplementIndex ?? 1}`;
  return `cycle-${record.cycle}`;
}

/**
 * 按“正常轮次 → 平票 PK → 补充发言”的顺序展开列，
 * 并建立 玩家 × 列 的发言索引，供表格与玩家栏共用。
 */
export function buildDescriptionColumns(
  descriptions: DescriptionRecord[],
): DescriptionColumnModel {
  const cycles = new Set<number>();
  const ties = new Set<number>();
  const supplements = new Set<number>();

  for (const record of descriptions) {
    if (record.kind === "tieBreak") ties.add(record.tieBreakIndex ?? 1);
    else if (record.kind === "supplement") supplements.add(record.supplementIndex ?? 1);
    else cycles.add(record.cycle);
  }

  const ascending = (a: number, b: number) => a - b;
  const columns: DescriptionColumn[] = [
    ...[...cycles].sort(ascending).map((cycle) => ({
      key: `cycle-${cycle}`,
      label: `第 ${cycle} 轮`,
      tone: "default" as const,
    })),
    ...[...ties].sort(ascending).map((index) => ({
      key: `tie-${index}`,
      label: `平票 ${index}`,
      tone: "amber" as const,
    })),
    ...[...supplements].sort(ascending).map((index) => ({
      key: `sup-${index}`,
      label: `补充 ${index}`,
      tone: "sky" as const,
    })),
  ];

  const byPlayer = new Map<string, Map<string, DescriptionRecord>>();
  for (const record of descriptions) {
    const row = byPlayer.get(record.playerId) ?? new Map<string, DescriptionRecord>();
    row.set(columnKeyOf(record), record);
    byPlayer.set(record.playerId, row);
  }

  return { columns, byPlayer };
}

/** 发言单元格的文字色，与列标题保持同一套语义。 */
export const DESCRIPTION_TONES: Record<DescriptionColumn["tone"], string> = {
  default: "text-foreground",
  amber: "text-amber-700 dark:text-amber-400",
  sky: "text-sky-700 dark:text-sky-300",
};

/** 列标题的文字色。 */
export const DESCRIPTION_HEAD_TONES: Record<DescriptionColumn["tone"], string> = {
  default: "text-muted-foreground",
  amber: "text-amber-700 dark:text-amber-400",
  sky: "text-sky-700 dark:text-sky-300",
};
