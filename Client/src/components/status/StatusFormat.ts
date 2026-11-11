import type {
  PublicStatusComponentId,
  PublicStatusEvent,
  PublicStatusLevel,
} from "@bakagame/shared";

export const LEVEL_TEXT: Record<PublicStatusLevel, string> = {
  operational: "正常",
  degraded: "异常",
  unknown: "未知",
};

/** 状态页的时间一律北京时间：日格的服务端口径就是北京自然日，展示跟着同一时区读。 */
const BEIJING = "Asia/Shanghai";
export const DAY_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: BEIJING,
  month: "long",
  day: "numeric",
});
export const TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: BEIJING,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
export const CLOCK_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: BEIJING,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
export const DATETIME_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: BEIJING,
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** 百分比只在有结论时给；没探过或探不出结论的窗口读作「—」，不拿 0% 冒充全挂。 */
export const formatRatio = (ratio: number | null): string =>
  ratio === null ? "—" : `${(ratio * 100).toFixed(ratio >= 0.9995 ? 1 : 2)}%`;

export const formatLatency = (latencyMs: number | null): string =>
  latencyMs === null ? "—" : `${latencyMs} ms`;

/** 条格里的一格：悬停说明需要的全部信息在构建时算好，渲染层不再做时间换算。 */
export interface BarCell {
  key: string;
  level: PublicStatusLevel;
  total: number;
  ratio: number | null;
  latencyMs: number | null;
  /** 时段标题，如「10月21日」或「10月21日 14:03–14:06」。 */
  when: string;
  events: PublicStatusEvent[];
}

/**
 * 格子的形状与颜色。形状先于颜色说话：有样本的格子满高，没有样本的只留一截矮桩，
 * 色弱或灰度下也读得出「这段时间有没有数据」；满高的格子再按结论上色，探过但没有结论的取中性色。
 * 条带、悬停说明与图例共用这一份。正常格降一档浓度：一整排正常读作底色，异常的满色才跳出来。
 */
export const CELL_TONE = {
  operational: "h-full bg-success/70",
  degraded: "h-full bg-destructive",
  unknown: "h-full bg-muted-foreground/30",
  empty: "h-1/4 bg-border",
} as const;

export const cellTone = (cell: Pick<BarCell, "level" | "total">): string =>
  cell.total === 0 ? CELL_TONE.empty : CELL_TONE[cell.level];

/** 事件是否还在进行：故障读到恢复为止，维护读到完成为止。 */
export const isEventActive = (event: PublicStatusEvent): boolean =>
  event.kind === "incident" ? event.resolvedAt === null : event.status !== "done";

/** 事件在时段上是否还压着：维护窗口读计划结束，事件读到恢复为止。 */
export const eventOverlaps = (
  event: PublicStatusEvent,
  componentId: PublicStatusComponentId,
  start: number,
  end: number
): boolean => {
  const touches = event.components.length === 0 || event.components.includes(componentId);
  if (!touches) return false;
  const eventEnd = event.resolvedAt ?? event.plannedEndAt ?? Number.POSITIVE_INFINITY;
  return event.startedAt < end && eventEnd > start;
};
