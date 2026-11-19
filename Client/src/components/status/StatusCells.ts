import { PUBLIC_STATUS_GROUPS } from "@bakagame/shared/values";
import type {
  PublicStatusComponentId,
  PublicStatusEvent,
  PublicStatusHistory,
  PublicStatusLevel,
  PublicStatusRealtime,
  PublicStatusSnapshot,
} from "@bakagame/shared";
import { STATUS_COMPONENT_LABELS } from "@/lib/SystemStatus";
import {
  DAY_FORMAT,
  TIME_FORMAT,
  beijingDayStart,
  eventOverlaps,
  type BarCell,
} from "./StatusFormat";

/** 页面按分组顺序排出的全部组件：显影错峰、总数与汇总都按这一份走。 */
export const ALL_COMPONENTS: readonly PublicStatusComponentId[] = PUBLIC_STATUS_GROUPS.flatMap(
  (group) => group.components
);

/** 全站可用率：各组件窗口可用率的平均，只算有结论的组件；一个都没有时读作「—」。 */
export const meanOf = (values: readonly (number | null)[]): number | null => {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
};

export interface Tally {
  operational: PublicStatusComponentId[];
  degraded: PublicStatusComponentId[];
  unknown: PublicStatusComponentId[];
}

export const tallyOf = (
  ids: readonly PublicStatusComponentId[],
  levelOf: (id: PublicStatusComponentId) => PublicStatusLevel
): Tally => {
  const tally: Tally = { operational: [], degraded: [], unknown: [] };
  for (const id of ids) tally[levelOf(id)].push(id);
  return tally;
};

/** 主卡标题与说明：异常点名到组件；部分组件没有监测结论时不说「所有系统正常」。 */
export const headlineOf = (
  snapshot: PublicStatusSnapshot | null,
  tally: Tally,
  failed: boolean
): { title: string; detail: string; names?: string[] } => {
  if (!snapshot) {
    return failed
      ? { title: "暂时读不到服务状态", detail: "实时通道与状态接口都没有响应，稍后会自动重试" }
      : { title: "正在读取服务状态…", detail: "连上实时通道后自动更新" };
  }
  const total = ALL_COMPONENTS.length;
  if (tally.degraded.length > 0) {
    const names = tally.degraded.map((id) => STATUS_COMPONENT_LABELS[id]);
    return {
      title: `${tally.degraded.length} 项服务异常`,
      detail: `异常：${names.join("、")}`,
      names,
    };
  }
  if (tally.unknown.length === total) {
    return { title: "暂时无法确认服务状态", detail: "各项服务都还没有可用的监测结论" };
  }
  if (tally.unknown.length > 0) {
    return {
      title: "已监测的服务运行正常",
      detail: `另有 ${tally.unknown.length} 项暂无监测结论`,
    };
  }
  return { title: "所有系统运行正常", detail: `${total} 项服务全部在线` };
};

export const groupSummaryOf = (tally: Tally, size: number): string => {
  if (tally.degraded.length > 0) return `${tally.degraded.length} 项异常`;
  if (tally.unknown.length === size) return "暂无监测结论";
  if (tally.unknown.length > 0) {
    return `${tally.operational.length} 项正常 · ${tally.unknown.length} 项未知`;
  }
  return "全部正常";
};

/** 实时窗口的格子序列：以服务端的窗口参数为准，缺样本的时段补空格。 */
export const buildRealtimeCells = (
  realtime: PublicStatusRealtime,
  events: readonly PublicStatusEvent[]
): Map<PublicStatusComponentId, BarCell[]> => {
  const realtimeById = new Map(realtime.entries.map((entry) => [entry.id, entry] as const));
  const count = Math.max(1, Math.round(realtime.windowMs / realtime.intervalMs));
  const last = Math.floor(realtime.generatedAt / realtime.intervalMs) * realtime.intervalMs;
  const result = new Map<PublicStatusComponentId, BarCell[]>();
  for (const id of ALL_COMPONENTS) {
    const byStart = new Map(
      (realtimeById.get(id)?.cells ?? []).map((cell) => [cell.start, cell] as const)
    );
    const cells: BarCell[] = Array.from({ length: count }, (_, index) => {
      const start = last - (count - 1 - index) * realtime.intervalMs;
      const end = start + realtime.intervalMs;
      const cell = byStart.get(start);
      return {
        key: `r${start}`,
        level: cell?.level ?? "unknown",
        total: cell?.total ?? 0,
        ratio: cell?.ratio ?? null,
        latencyMs: cell?.latencyMs ?? null,
        when: `${DAY_FORMAT.format(start)} ${TIME_FORMAT.format(start)}–${TIME_FORMAT.format(end)}`,
        events: events.filter((event) => eventOverlaps(event, id, start, end)),
      };
    });
    result.set(id, cells);
  }
  return result;
};

/** 月视图的日格：服务端按北京自然日给格子，这里只补事件重叠；缺条目的组件按同一串日子补空格。 */
export const buildMonthCells = (
  history: PublicStatusHistory,
  events: readonly PublicStatusEvent[]
): Map<PublicStatusComponentId, BarCell[]> => {
  const historyById = new Map(history.entries.map((entry) => [entry.id, entry] as const));
  const days = history.entries[0]?.cells.map((cell) => cell.day) ?? [];
  const result = new Map<PublicStatusComponentId, BarCell[]>();
  for (const id of ALL_COMPONENTS) {
    const source =
      historyById.get(id)?.cells ??
      days.map((day) => ({
        day,
        total: 0,
        ratio: null,
        level: "unknown" as const,
        latencyMs: null,
      }));
    result.set(
      id,
      source.map((cell) => {
        const start = beijingDayStart(cell.day);
        const end = start + 86_400_000;
        return {
          key: `d${cell.day}`,
          level: cell.level,
          total: cell.total,
          ratio: cell.ratio,
          latencyMs: cell.latencyMs,
          when: DAY_FORMAT.format(start),
          events: events.filter((event) => eventOverlaps(event, id, start, end)),
        };
      })
    );
  }
  return result;
};
