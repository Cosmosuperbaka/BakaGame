import type { DescriptionRecord, RoomSnapshot } from "@/types";

/** 发言历史的一列。轮次、平票 PK 与补充发言各自独立编号。 */
export interface DescriptionColumn {
  key: string;
  label: string;
  tone: "default" | "amber" | "sky";
  /**
   * 本列应当发言的玩家。
   * 出题人、旁观者、已出局以及本列未被点名的玩家不在其中，
   * 他们的格子留空，不显示待提交占位。
   */
  expectedPlayerIds: Set<string>;
}

export interface DescriptionColumnModel {
  columns: DescriptionColumn[];
  /** playerId → columnKey → 发言记录 */
  byPlayer: Map<string, Map<string, DescriptionRecord>>;
}

/** 计算应发言名单所需的快照状态字段 */
export type SpeechStatus = RoomSnapshot["status"];

/** 把发言记录归入所属列，并给出该记录的列键。 */
function columnKeyOf(record: DescriptionRecord): string {
  if (record.kind === "tieBreak") return `tie-${record.tieBreakIndex ?? 1}`;
  if (record.kind === "supplement") return `sup-${record.supplementIndex ?? 1}`;
  return `cycle-${record.cycle}`;
}

/**
 * 当前正在进行的发言列及其应发言名单。
 * 只有处于发言阶段时才有值；投票、夜晚等阶段没有待提交的格子。
 */
function pendingColumn(status: SpeechStatus): { key: string; playerIds: string[] } | null {
  const mode = status.speechMode ?? (status.phase === "tieBreak" ? "tieBreak" : undefined);
  if (mode === "supplement") {
    return {
      key: `sup-${status.supplementIndex ?? 1}`,
      playerIds: status.speechOrder ?? status.pendingSupplementPlayerIds ?? [],
    };
  }
  if (mode === "tieBreak") {
    if (status.tieBreakStage !== "description") return null;
    return {
      key: `tie-${status.tieBreakIndex ?? 1}`,
      playerIds: status.speechOrder ?? status.tieBreakCandidateIds ?? [],
    };
  }
  if (status.phase !== "description") return null;
  return {
    key: `cycle-${status.day}`,
    playerIds: status.speechOrder ?? status.descriptionOrder ?? [],
  };
}

/**
 * 按“正常轮次 → 平票 PK → 补充发言”的顺序展开列，
 * 并建立 玩家 × 列 的发言索引，供表格与玩家栏共用。
 *
 * 传入 `status` 时，当前进行中的那一列会补上尚未提交的应发言玩家；
 * 已结束的列只把实际发言过的人算作应发言，因此不会给出题人、
 * 旁观者或当时已出局的玩家留下待提交占位。
 */
export function buildDescriptionColumns(
  descriptions: DescriptionRecord[],
  status?: SpeechStatus,
): DescriptionColumnModel {
  const cycles = new Set<number>();
  const ties = new Set<number>();
  const supplements = new Set<number>();
  // columnKey → 该列应发言的玩家；先由实际发言记录填充。
  const expected = new Map<string, Set<string>>();

  const expectFor = (key: string) => {
    const found = expected.get(key);
    if (found) return found;
    const created = new Set<string>();
    expected.set(key, created);
    return created;
  };

  for (const record of descriptions) {
    if (record.kind === "tieBreak") ties.add(record.tieBreakIndex ?? 1);
    else if (record.kind === "supplement") supplements.add(record.supplementIndex ?? 1);
    else cycles.add(record.cycle);
    expectFor(columnKeyOf(record)).add(record.playerId);
  }

  // 进行中的列还没人齐，用服务端下发的名单补出待提交的格子。
  if (status) {
    const pending = pendingColumn(status);
    if (pending) {
      const { key, playerIds } = pending;
      if (key.startsWith("cycle-")) cycles.add(Number(key.slice(6)));
      else if (key.startsWith("tie-")) ties.add(Number(key.slice(4)));
      else supplements.add(Number(key.slice(4)));
      const bucket = expectFor(key);
      for (const playerId of playerIds) bucket.add(playerId);
    }
  }

  const ascending = (a: number, b: number) => a - b;
  const columns: DescriptionColumn[] = [
    ...[...cycles].sort(ascending).map((cycle) => ({
      key: `cycle-${cycle}`,
      label: `第 ${cycle} 轮`,
      tone: "default" as const,
      expectedPlayerIds: expectFor(`cycle-${cycle}`),
    })),
    ...[...ties].sort(ascending).map((index) => ({
      key: `tie-${index}`,
      label: `平票 ${index}`,
      tone: "amber" as const,
      expectedPlayerIds: expectFor(`tie-${index}`),
    })),
    ...[...supplements].sort(ascending).map((index) => ({
      key: `sup-${index}`,
      label: `补充 ${index}`,
      tone: "sky" as const,
      expectedPlayerIds: expectFor(`sup-${index}`),
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
