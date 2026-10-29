import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  PUBLIC_STATUS_GROUPS,
  type PublicStatusComponentId,
  type PublicStatusEvent,
  type PublicStatusHistory,
  type PublicStatusLevel,
  type PublicStatusRealtime,
} from "@bakagame/shared";
import {
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  CircleHelp,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { Seo } from "@/components/common/Seo";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { usePageNavigate } from "@/hooks/UsePageTransition";
import { useStatusLive } from "@/hooks/UseStatusLive";
import { popover } from "@/lib/Motion";
import {
  fetchStatusEvents,
  fetchStatusHistory,
  fetchStatusRealtime,
  STATUS_COMPONENT_LABELS,
  STATUS_EVENT_STATUS_LABELS,
  STATUS_GROUP_LABELS,
  STATUS_POLL_INTERVAL_MS,
} from "@/lib/SystemStatus";
import { cn } from "@/lib/Utils";

type StatusView = "realtime" | "month";

const LEVEL_TEXT: Record<PublicStatusLevel, string> = {
  operational: "正常",
  degraded: "异常",
  unknown: "未知",
};

const CELL_CLASS: Record<PublicStatusLevel, string> = {
  operational: "bg-success",
  degraded: "bg-destructive",
  unknown: "bg-muted-foreground/30",
};

/** 状态页的时间一律北京时间：日格的服务端口径就是北京自然日，展示跟着同一时区读。 */
const BEIJING = "Asia/Shanghai";
const DAY_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: BEIJING,
  month: "long",
  day: "numeric",
});
const TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: BEIJING,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const DATETIME_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: BEIJING,
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** 百分比只在有样本时给；没探过的窗口读作「—」，不拿 0% 冒充全挂。 */
const formatRatio = (ratio: number | null): string =>
  ratio === null ? "—" : `${(ratio * 100).toFixed(ratio >= 0.9995 ? 1 : 2)}%`;

const formatLatency = (latencyMs: number | null): string =>
  latencyMs === null ? "—" : `${latencyMs} ms`;

/** 事件在时段上是否还压着：维护窗口读计划结束，事件读到恢复为止。 */
const overlaps = (
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

/** 条格里的一格：悬停说明需要的全部信息在构建时算好，渲染层不再做时间换算。 */
interface BarCell {
  key: string;
  level: PublicStatusLevel;
  total: number;
  ratio: number | null;
  latencyMs: number | null;
  /** 时段标题，如「10月21日」或「14:03–14:06」。 */
  when: string;
  events: PublicStatusEvent[];
}

const monthCellStart = (day: string): number => Date.parse(`${day}T00:00:00+08:00`);

function LevelBadge({ level }: { level: PublicStatusLevel }) {
  if (level === "operational") {
    return (
      <Badge variant="matched" size="sm">
        <CheckCircle2 aria-hidden="true" className="h-3 w-3" />
        {LEVEL_TEXT.operational}
      </Badge>
    );
  }
  if (level === "degraded") {
    return (
      <Badge variant="restricted" size="sm">
        <TriangleAlert aria-hidden="true" className="h-3 w-3" />
        {LEVEL_TEXT.degraded}
      </Badge>
    );
  }
  return (
    <Badge variant="subtle" size="sm">
      <CircleHelp aria-hidden="true" className="h-3 w-3" />
      {LEVEL_TEXT.unknown}
    </Badge>
  );
}

/** 悬停时跟随条格的说明：可用率、延迟与压在这个时段上的事件，一条一格。 */
function CellTooltip({ cell, align }: { cell: BarCell; align: { left: number } }) {
  return (
    <motion.div
      variants={popover}
      aria-hidden="true"
      style={{ left: align.left }}
      className="floating-surface pointer-events-none absolute bottom-full z-popover mb-2 w-max max-w-64 -translate-x-1/2 rounded-md px-3 py-2 text-left shadow-md"
    >
      <p className="font-sans text-2xs text-muted-foreground">{cell.when}</p>
      <p className="mt-0.5 text-xs">
        {cell.total === 0
          ? "没有探测样本"
          : `${LEVEL_TEXT[cell.level]} · 可用率 ${formatRatio(cell.ratio)}`}
      </p>
      {cell.latencyMs !== null ? (
        <p className="font-sans text-2xs text-muted-foreground">
          平均延迟 {formatLatency(cell.latencyMs)}
        </p>
      ) : null}
      {cell.events.length > 0 ? (
        <ul className="mt-1 space-y-0.5 border-t border-border pt-1">
          {cell.events.map((event) => (
            <li key={event.id} className="flex items-center gap-1 text-2xs">
              {event.kind === "maintenance" ? (
                <Wrench aria-hidden="true" className="h-3 w-3 shrink-0 text-muted-foreground" />
              ) : (
                <TriangleAlert aria-hidden="true" className="h-3 w-3 shrink-0 text-destructive" />
              )}
              <span className="truncate">{event.title}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </motion.div>
  );
}

/**
 * 日格 / 实时共用的条带：左旧右新，一格一个时段。
 *
 * 悬停说明按「一整条一个浮层」实现：格子上只记指针位置，浮层是同一块 DOM 顺着挪，
 * 120 格也不产生 120 份浮层。整条带仍作为一张图像读给读屏（逐格细节悬停可见，
 * 键盘侧每行右侧另有文字状态、可用率与延迟，颜色不是唯一线索）。
 */
function UptimeBar({ cells }: { cells: BarCell[] }) {
  const [hover, setHover] = useState<{ index: number; left: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const operational = cells.filter((cell) => cell.level === "operational").length;
  const degraded = cells.filter((cell) => cell.level === "degraded").length;
  const sampled = cells.filter((cell) => cell.total > 0).length;
  const label =
    sampled === 0
      ? "这段时间还没有探测样本"
      : `${sampled} 个时段有数据，其中 ${operational} 个正常、${degraded} 个异常`;

  const onEnter = (index: number) => (event: ReactPointerEvent<HTMLSpanElement>) => {
    const cell = event.currentTarget;
    const container = containerRef.current;
    if (!container) return;
    // 说明钉在格子上方居中，靠边时往条带内侧收，不越过条带两端。
    const center = cell.offsetLeft + cell.offsetWidth / 2;
    const clamped = Math.min(Math.max(center, 72), container.offsetWidth - 72);
    setHover({ index, left: clamped });
  };

  return (
    <div className="relative mt-2" onPointerLeave={() => setHover(null)}>
      <AnimatePresence>
        {hover ? (
          <CellTooltip
            key={cells[hover.index]?.key}
            cell={cells[hover.index]!}
            align={{ left: hover.left }}
          />
        ) : null}
      </AnimatePresence>
      <div
        ref={containerRef}
        role="img"
        aria-label={label}
        className="flex h-5 items-stretch gap-px overflow-hidden rounded-sm"
      >
        {cells.map((cell, index) => (
          <span
            key={cell.key}
            aria-hidden="true"
            onPointerEnter={onEnter(index)}
            className={cn(
              "min-w-0 flex-1 transition-colors",
              cell.total === 0 ? "bg-muted" : CELL_CLASS[cell.level],
              hover?.index === index && "opacity-80"
            )}
          />
        ))}
      </div>
    </div>
  );
}

function ComponentRow({
  id,
  level,
  latencyMs,
  ratio,
  cells,
}: {
  id: keyof typeof STATUS_COMPONENT_LABELS;
  level: PublicStatusLevel;
  /** 当前延迟（毫秒）；只在实时视图传入，月视图不显示这个口径。 */
  latencyMs: number | null | undefined;
  ratio: number | null;
  cells: BarCell[];
}) {
  const label = STATUS_COMPONENT_LABELS[id];
  return (
    <li className="px-4 py-3">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="truncate text-sm font-medium">{label}</span>
        <div className="flex shrink-0 items-center gap-3">
          {latencyMs !== undefined ? (
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {formatLatency(latencyMs)}
            </span>
          ) : null}
          {/* 百分比与状态徽章并排：数字给趋势，徽章给当下，两者互为文字说明。 */}
          <span className="font-sans text-xs tabular-nums text-muted-foreground">
            {formatRatio(ratio)}
          </span>
          <LevelBadge level={level} />
        </div>
      </div>
      <UptimeBar cells={cells} />
    </li>
  );
}

/** 事件卡的元信息：时间段与受影响组件，维护窗口带计划结束。 */
function EventMeta({ event }: { event: PublicStatusEvent }) {
  const range =
    event.kind === "maintenance"
      ? `${DATETIME_FORMAT.format(event.startedAt)} – ${
          event.plannedEndAt === null ? "待定" : TIME_FORMAT.format(event.plannedEndAt)
        }`
      : DATETIME_FORMAT.format(event.startedAt);
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-sans text-2xs text-muted-foreground">
      <span className="font-mono tabular-nums">{range}</span>
      {event.components.length > 0 ? (
        <span className="text-border" aria-hidden="true">
          ·
        </span>
      ) : null}
      <span className="truncate">
        {event.components.map((component) => STATUS_COMPONENT_LABELS[component]).join("、")}
      </span>
    </p>
  );
}

function EventStatusBadge({ event }: { event: PublicStatusEvent }) {
  const resolved = event.kind === "incident" ? event.resolvedAt !== null : event.status === "done";
  return (
    <Badge
      variant={resolved ? "subtle" : event.kind === "maintenance" ? "active" : "restricted"}
      size="xs"
    >
      {STATUS_EVENT_STATUS_LABELS[event.status]}
    </Badge>
  );
}

/** 事件与维护一览：进行中的成卡，已结束的排成时间线；两者都给足文字，不只靠颜色。 */
function StatusEventsSection({ events }: { events: PublicStatusEvent[] }) {
  const isActive = (event: PublicStatusEvent): boolean =>
    event.kind === "incident" ? event.resolvedAt === null : event.status !== "done";
  const active = events.filter(isActive);
  const past = events.filter((event) => !isActive(event));

  return (
    <section aria-labelledby="status-events" className="mt-6">
      <h2 id="status-events" className="font-sans text-2xs text-muted-foreground">
        事件与维护
      </h2>
      {events.length === 0 ? (
        <p className="mt-2 rounded-md border bg-card p-4 text-sm text-muted-foreground shadow-2xs">
          近一个月没有记录在案的事件或维护。
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          <AnimatePresence initial={false}>
            {active.map((event) => (
              <motion.article
                key={event.id}
                layout
                variants={popover}
                className={cn(
                  "rounded-md border p-4 shadow-2xs",
                  event.kind === "incident"
                    ? "border-destructive/40 bg-destructive/10"
                    : "border-border bg-card"
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  {event.kind === "maintenance" ? (
                    event.status === "scheduled" ? (
                      <CalendarClock
                        aria-hidden="true"
                        className="shrink-0 text-muted-foreground"
                      />
                    ) : (
                      <Wrench aria-hidden="true" className="shrink-0 text-muted-foreground" />
                    )
                  ) : (
                    <TriangleAlert aria-hidden="true" className="shrink-0 text-destructive" />
                  )}
                  <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{event.title}</h3>
                  <EventStatusBadge event={event} />
                </div>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{event.body}</p>
                <EventMeta event={event} />
              </motion.article>
            ))}
          </AnimatePresence>
          {past.length > 0 ? (
            <ul className="divide-y divide-border overflow-hidden rounded-md border bg-card shadow-2xs">
              {past.map((event) => (
                <li key={event.id} className="flex min-w-0 items-center gap-3 px-4 py-3">
                  <time className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                    {DAY_FORMAT.format(event.startedAt)}
                  </time>
                  <span className="min-w-0 flex-1 truncate text-sm">{event.title}</span>
                  <span className="hidden shrink-0 truncate font-sans text-2xs text-muted-foreground sm:block">
                    {event.components
                      .map((component) => STATUS_COMPONENT_LABELS[component])
                      .join("、") || "全站"}
                  </span>
                  <EventStatusBadge event={event} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
      <p className="sr-only">
        时间均为北京时间。{active.length} 条进行中，{past.length} 条已结束。
      </p>
    </section>
  );
}

/** 全站可用率（月视图）：把窗口内所有组件的样本合起来算，样本多的日子权重就大。 */
function computeOverallUptime(history: PublicStatusHistory | null): number | null {
  if (!history) return null;
  let total = 0;
  let operational = 0;
  for (const entry of history.entries) {
    for (const cell of entry.cells) {
      if (cell.total === 0 || cell.ratio === null) continue;
      total += cell.total;
      operational += cell.ratio * cell.total;
    }
  }
  return total > 0 ? operational / total : null;
}

/** 全站可用率（实时视图）：与月视图同一口径，只是样本换成 3 分钟格。 */
function computeOverallRealtime(realtime: PublicStatusRealtime | null): number | null {
  if (!realtime) return null;
  let total = 0;
  let operational = 0;
  for (const entry of realtime.entries) {
    for (const cell of entry.cells) {
      if (cell.total === 0) continue;
      total += cell.total;
      operational += (cell.ratio ?? 0) * cell.total;
    }
  }
  return total > 0 ? operational / total : null;
}

export default function StatusPage() {
  const navigate = usePageNavigate();
  const { snapshot } = useStatusLive();
  const [view, setView] = useState<StatusView>("realtime");
  const [history, setHistory] = useState<PublicStatusHistory | null>(null);
  const [realtime, setRealtime] = useState<PublicStatusRealtime | null>(null);
  const [events, setEvents] = useState<PublicStatusEvent[] | null>(null);

  useEffect(() => {
    let alive = true;
    // 三份数据各自降级：历史读不到不拖实时条带，事件读不到不拖其它两块。
    const load = (): void => {
      void fetchStatusHistory().then(
        (value) => alive && setHistory(value),
        () => alive && setHistory(null)
      );
      void fetchStatusRealtime().then(
        (value) => alive && setRealtime(value),
        () => alive && setRealtime(null)
      );
      void fetchStatusEvents().then(
        (value) => alive && setEvents(value),
        () => alive && setEvents(null)
      );
    };
    load();
    // 采样本身 3 分钟一轮，页面按分钟对齐就够；离开页面即停。
    const timer = setInterval(load, STATUS_POLL_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const levels = useMemo(
    () =>
      new Map(snapshot?.components.map((component) => [component.id, component] as const) ?? []),
    [snapshot]
  );
  const historyById = useMemo(
    () => new Map(history?.entries.map((entry) => [entry.id, entry] as const) ?? []),
    [history]
  );
  const realtimeById = useMemo(
    () => new Map(realtime?.entries.map((entry) => [entry.id, entry] as const) ?? []),
    [realtime]
  );

  /** 实时窗口的格子序列：以服务端的窗口参数为准，缺样本的时段补空格。 */
  const realtimeCells = useMemo(() => {
    if (!realtime) return new Map<string, BarCell[]>();
    const count = Math.max(1, Math.round(realtime.windowMs / realtime.intervalMs));
    const last = Math.floor(realtime.generatedAt / realtime.intervalMs) * realtime.intervalMs;
    const result = new Map<string, BarCell[]>();
    for (const entry of realtime.entries) {
      const byStart = new Map(entry.cells.map((cell) => [cell.start, cell] as const));
      const cells: BarCell[] = Array.from({ length: count }, (_, index) => {
        const start = last - (count - 1 - index) * realtime.intervalMs;
        const end = start + realtime.intervalMs;
        const cell = byStart.get(start);
        const overlapping = (events ?? []).filter((event) => overlaps(event, entry.id, start, end));
        return {
          key: `r${start}`,
          level: cell?.level ?? "unknown",
          total: cell?.total ?? 0,
          ratio: cell?.ratio ?? null,
          latencyMs: cell?.latencyMs ?? null,
          when: `${DAY_FORMAT.format(start)} ${TIME_FORMAT.format(start)}–${TIME_FORMAT.format(end)}`,
          events: overlapping,
        };
      });
      result.set(entry.id, cells);
    }
    return result;
  }, [realtime, events]);

  /** 月视图的日格：服务端按北京自然日给格子，这里只补事件重叠。 */
  const monthCells = useMemo(() => {
    const result = new Map<string, BarCell[]>();
    for (const entry of history?.entries ?? []) {
      const cells: BarCell[] = entry.cells.map((cell) => {
        const start = monthCellStart(cell.day);
        const end = start + 86_400_000;
        return {
          key: `d${cell.day}`,
          level: cell.level,
          total: cell.total,
          ratio: cell.ratio,
          latencyMs: null,
          when: DAY_FORMAT.format(start),
          events: (events ?? []).filter((event) => overlaps(event, entry.id, start, end)),
        };
      });
      result.set(entry.id, cells);
    }
    return result;
  }, [history, events]);

  const overall = snapshot?.level ?? "unknown";
  const degradedCount = snapshot
    ? snapshot.components.filter((component) => component.level === "degraded").length
    : 0;
  const overallUptime =
    view === "month" ? computeOverallUptime(history) : computeOverallRealtime(realtime);
  const uptimeLabel = view === "month" ? "30 天全站可用率" : "近 6 小时全站可用率";

  return (
    <div className="h-full min-h-0 overflow-y-auto overscroll-contain">
      <Seo
        path="/status"
        description="BakaGame 服务状态：前端、后端、上游接口与本项目内部各能力的实时状态、历史可用率与事件维护记录。"
        indexable={false}
      />
      <header>
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-6 py-3 md:py-4">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 h-8 shrink-0 gap-1.5 px-2 text-muted-foreground"
            onClick={() => void navigate("/")}
          >
            <ArrowLeft aria-hidden="true" />
            <span>返回主页</span>
          </Button>
          <h1 className="flex flex-1 items-center gap-2 text-lg font-bold sm:text-xl">服务状态</h1>
        </div>
      </header>

      <article className="mx-auto w-full max-w-3xl px-6 pb-10">
        <section
          aria-live="polite"
          className={cn(
            "rounded-md border p-4",
            overall === "degraded"
              ? "border-destructive/40 bg-destructive/10"
              : overall === "operational"
                ? "border-success/40 bg-success/10"
                : "border-border bg-muted/40"
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              {overall === "operational" ? (
                <CheckCircle2 aria-hidden="true" className="text-success" />
              ) : overall === "degraded" ? (
                <TriangleAlert aria-hidden="true" className="text-destructive" />
              ) : (
                <CircleHelp aria-hidden="true" className="text-muted-foreground" />
              )}
              <h2 className="text-base font-semibold">
                {!snapshot
                  ? "正在读取服务状态…"
                  : overall === "operational"
                    ? "所有系统运行正常"
                    : overall === "degraded"
                      ? `${degradedCount} 项服务异常`
                      : "暂时无法确认服务状态"}
              </h2>
            </div>
            {snapshot ? <LevelBadge level={overall} /> : null}
          </div>
          {/* 全站可用率：当前视图窗口内所有组件的样本合起来算的一个数。 */}
          <p className="mt-2 flex items-baseline gap-2 text-sm">
            <span className="font-mono text-2xl leading-none tabular-nums">
              {formatRatio(overallUptime)}
            </span>
            <span className="font-sans text-2xs text-muted-foreground">{uptimeLabel}</span>
          </p>
        </section>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <SegmentedControl<StatusView>
            aria-label="状态视图"
            value={view}
            onValueChange={setView}
            options={[
              { value: "realtime", label: "实时" },
              { value: "month", label: "一月" },
            ]}
          />
          <p className="flex flex-wrap items-center gap-3 font-sans text-2xs text-muted-foreground">
            {/* 图例：颜色之外同时给出文字，条格读作什么由这里定。 */}
            <span className="flex items-center gap-1">
              <span aria-hidden="true" className="h-2 w-2 rounded-sm bg-success" />
              正常
            </span>
            <span className="flex items-center gap-1">
              <span aria-hidden="true" className="h-2 w-2 rounded-sm bg-destructive" />
              异常
            </span>
            <span className="flex items-center gap-1">
              <span aria-hidden="true" className="h-2 w-2 rounded-sm bg-muted" />
              无数据
            </span>
            <span className="hidden sm:inline">悬停条格查看时段详情</span>
          </p>
        </div>

        {PUBLIC_STATUS_GROUPS.map((group) => (
          <section key={group.id} aria-labelledby={`status-group-${group.id}`} className="mt-4">
            <h2
              id={`status-group-${group.id}`}
              className="font-sans text-2xs text-muted-foreground"
            >
              {STATUS_GROUP_LABELS[group.id]}
            </h2>
            <ul className="mt-2 divide-y divide-border overflow-hidden rounded-md border bg-card shadow-2xs">
              {group.components.map((id) => {
                const component = levels.get(id);
                const monthEntry = historyById.get(id);
                const realtimeEntry = realtimeById.get(id);
                const ratio =
                  view === "month"
                    ? (monthEntry?.uptime.find((span) => span.days === 30)?.ratio ?? null)
                    : (realtimeEntry?.uptime ?? null);
                return (
                  <ComponentRow
                    key={id}
                    id={id}
                    level={component?.level ?? "unknown"}
                    latencyMs={view === "realtime" ? (component?.latencyMs ?? null) : undefined}
                    ratio={ratio}
                    cells={(view === "month" ? monthCells.get(id) : realtimeCells.get(id)) ?? []}
                  />
                );
              })}
            </ul>
          </section>
        ))}

        <StatusEventsSection events={events ?? []} />
      </article>
    </div>
  );
}
