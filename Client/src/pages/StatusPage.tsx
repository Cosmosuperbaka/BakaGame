import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { AnimatePresence, motion, type TargetAndTransition, type Variants } from "framer-motion";
import {
  PUBLIC_STATUS_GROUPS,
  PUBLIC_STATUS_HISTORY_DAYS,
  PUBLIC_STATUS_REALTIME_WINDOW_MS,
  PUBLIC_STATUS_SAMPLE_INTERVAL_MS,
} from "@bakagame/shared/values";
import type {
  PublicStatusComponentId,
  PublicStatusEvent,
  PublicStatusHistory,
  PublicStatusLevel,
  PublicStatusRealtime,
  PublicStatusSnapshot,
} from "@bakagame/shared";
import { ArrowLeft, CheckCircle2, CircleHelp, TriangleAlert } from "lucide-react";
import { Seo } from "@/components/common/Seo";
import { LatencySparkline } from "@/components/status/LatencySparkline";
import { StatusEventsSection } from "@/components/status/StatusEventsSection";
import {
  CELL_TONE,
  CLOCK_FORMAT,
  DAY_FORMAT,
  LEVEL_TEXT,
  TIME_FORMAT,
  eventOverlaps,
  formatLatency,
  formatRatio,
  type BarCell,
} from "@/components/status/StatusFormat";
import { UptimeBar } from "@/components/status/UptimeBar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Hint } from "@/components/ui/Tooltip";
import { usePageNavigate } from "@/hooks/UsePageTransition";
import { useStatusLive } from "@/hooks/UseStatusLive";
import { duration, readoutSwap, statusGlyphSwap, uptimeReveal } from "@/lib/Motion";
import {
  fetchStatusEvents,
  fetchStatusHistory,
  fetchStatusRealtime,
  STATUS_COMPONENT_LABELS,
  STATUS_GROUP_LABELS,
  STATUS_POLL_INTERVAL_MS,
} from "@/lib/SystemStatus";
import { cn } from "@/lib/Utils";

type StatusView = "realtime" | "month";
/** 轮询数据的三态：`undefined` 读取中；`null` 读失败且此前没读到过；其余为最近一次读到的数据。 */
type Loadable<T> = T | null | undefined;

const REALTIME_CELLS = Math.round(
  PUBLIC_STATUS_REALTIME_WINDOW_MS / PUBLIC_STATUS_SAMPLE_INTERVAL_MS
);
const REALTIME_HOURS = PUBLIC_STATUS_REALTIME_WINDOW_MS / 3_600_000;
const SAMPLE_MINUTES = PUBLIC_STATUS_SAMPLE_INTERVAL_MS / 60_000;
const VIEW_LABEL: Record<StatusView, string> = {
  realtime: `近 ${REALTIME_HOURS} 小时`,
  month: `近 ${PUBLIC_STATUS_HISTORY_DAYS} 天`,
};
const AXIS_LABEL: Record<StatusView, readonly [string, string]> = {
  realtime: [`${REALTIME_HOURS} 小时前`, "现在"],
  month: [`${PUBLIC_STATUS_HISTORY_DAYS} 天前`, "今天"],
};

/** 页面按分组顺序排出的全部组件：显影错峰、总数与汇总都按这一份走。 */
const ALL_COMPONENTS: readonly PublicStatusComponentId[] = PUBLIC_STATUS_GROUPS.flatMap(
  (group) => group.components
);

const monthCellStart = (day: string): number => Date.parse(`${day}T00:00:00+08:00`);

/** 全站可用率：各组件窗口可用率的平均，只算有结论的组件；一个都没有时读作「—」。 */
const meanOf = (values: readonly (number | null)[]): number | null => {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
};

const LEVEL_BADGE = {
  operational: { variant: "matched", Icon: CheckCircle2 },
  degraded: { variant: "alert", Icon: TriangleAlert },
  unknown: { variant: "subtle", Icon: CircleHelp },
} as const;

/** 窄屏只留图标：形状本身区分三档，文字转给读屏，把宽度让给组件名。 */
function LevelBadge({ level }: { level: PublicStatusLevel }) {
  const { variant, Icon } = LEVEL_BADGE[level];
  return (
    <Badge variant={variant} size="sm" className="shrink-0">
      <Icon aria-hidden="true" className="size-3" />
      <span className="sr-only sm:not-sr-only">{LEVEL_TEXT[level]}</span>
    </Badge>
  );
}

const PLACEHOLDER = "—";

/**
 * 推送或轮询换来的新读数自下方顶上来，读作「这个数被换掉了」；值不变不动。
 * 占位「—」换成第一次读到的值不算「被换掉」：占位直接撤走，不和新值叠在一起闪成一道删除线。
 */
const readoutVariants: Variants = {
  ...readoutSwap,
  exit: (value: string): TargetAndTransition =>
    value === PLACEHOLDER
      ? { opacity: 0, transition: { duration: duration.none } }
      : (readoutSwap.exit as TargetAndTransition),
};

function Readout({ value }: { value: string }) {
  return (
    <span className="relative inline-flex">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={value}
          custom={value}
          variants={readoutVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          className="inline-block whitespace-nowrap"
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

const GLYPH = {
  operational: { Icon: CheckCircle2, tone: "bg-success/10 text-success" },
  degraded: { Icon: TriangleAlert, tone: "bg-destructive/10 text-destructive" },
  unknown: { Icon: CircleHelp, tone: "bg-muted text-muted-foreground" },
} as const;

/** 主卡左侧的状态图标：等级变了才换档，读取中按统一呼吸令牌起伏。 */
function StatusGlyph({ level, loading }: { level: PublicStatusLevel; loading: boolean }) {
  const { Icon, tone } = GLYPH[loading ? "unknown" : level];
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-10 shrink-0 place-items-center rounded-md transition-colors duration-(--motion-duration-base) ease-(--motion-ease-out) sm:size-11",
        tone
      )}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={loading ? "loading" : level}
          variants={statusGlyphSwap}
          initial="initial"
          animate="animate"
          exit="exit"
          className="grid place-items-center"
        >
          <Icon className={cn("size-5", loading && "motion-safe:animate-breathe")} />
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

interface Tally {
  operational: PublicStatusComponentId[];
  degraded: PublicStatusComponentId[];
  unknown: PublicStatusComponentId[];
}

const tallyOf = (
  ids: readonly PublicStatusComponentId[],
  levelOf: (id: PublicStatusComponentId) => PublicStatusLevel
): Tally => {
  const tally: Tally = { operational: [], degraded: [], unknown: [] };
  for (const id of ids) tally[levelOf(id)].push(id);
  return tally;
};

/** 主卡标题与说明：异常点名到组件；部分组件没有监测结论时不说「所有系统正常」。 */
const headlineOf = (
  snapshot: PublicStatusSnapshot | null,
  tally: Tally
): { title: string; detail: string; names?: string[] } => {
  if (!snapshot) return { title: "正在读取服务状态…", detail: "连上实时通道后自动更新" };
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

const groupSummaryOf = (tally: Tally, size: number): string => {
  if (tally.degraded.length > 0) return `${tally.degraded.length} 项异常`;
  if (tally.unknown.length === size) return "暂无监测结论";
  if (tally.unknown.length > 0) {
    return `${tally.operational.length} 项正常 · ${tally.unknown.length} 项未知`;
  }
  return "全部正常";
};

function SummaryStat({
  label,
  shortLabel,
  value,
}: {
  label: string;
  /** 窄屏三栏各只有七八十像素：换一个不必折行的短名，时间窗口由下方的范围切换说明。 */
  shortLabel: string;
  value: string;
}) {
  return (
    <div className="flex min-w-0 flex-col-reverse justify-end gap-1.5 border-l border-border px-3 first:border-l-0 first:pl-0 sm:px-5">
      <dt className="text-2xs leading-snug text-muted-foreground">
        <span className="sm:hidden">{shortLabel}</span>
        <span className="hidden sm:inline">{label}</span>
      </dt>
      <dd className="font-mono text-xl leading-none tabular-nums">
        <Readout value={value} />
      </dd>
    </div>
  );
}

/** 图例：每一档同时给形状与文字，条格读作什么由这里定。 */
const LEGEND = [
  { label: "正常", tone: CELL_TONE.operational },
  { label: "异常", tone: CELL_TONE.degraded },
  { label: "未知", tone: CELL_TONE.unknown },
  { label: "无样本", tone: CELL_TONE.empty },
] as const;

function Legend() {
  return (
    <ul
      aria-label="条带图例"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground"
    >
      {LEGEND.map((item) => (
        <li key={item.label} className="flex items-center gap-1">
          <span aria-hidden="true" className="flex h-3 w-1.5 items-end">
            <span className={cn("w-full rounded-xs", item.tone)} />
          </span>
          {item.label}
        </li>
      ))}
      <li className="hidden md:block">悬停条格看时段详情</li>
    </ul>
  );
}

/**
 * 行内延迟读的是哪一种数：实时视图给当前探测耗时；月视图给窗口内的样本加权均值；
 * 后端一行给浏览器到后端的往返（服务端探不了自己）。后两种在数字前标出口径，免得和「当前」混读。
 */
type LatencyKind = "current" | "average" | "roundTrip";

const LATENCY_PREFIX: Record<LatencyKind, string | null> = {
  current: null,
  average: "平均",
  roundTrip: "往返",
};

const LATENCY_TITLE: Record<LatencyKind, string> = {
  current: "服务端访问这项服务的响应耗时",
  average: `${VIEW_LABEL.month}服务端访问这项服务的平均响应耗时`,
  roundTrip: "从你的浏览器到后端服务的往返耗时，每分钟测一次",
};

interface RowLatency {
  value: number | null;
  /** 当前视图窗口里每格的平均延迟，画成走势；没有窗口数据（往返延迟）时为 null。 */
  series: (number | null)[] | null;
  kind: LatencyKind;
}

function ComponentRow({
  id,
  level,
  ratio,
  latency,
  cells,
  loading,
  placeholderCount,
  revealKey,
  revealDelay,
}: {
  id: PublicStatusComponentId;
  level: PublicStatusLevel;
  ratio: number | null;
  /** 只在实时视图、且这项服务有延迟口径时给；月视图与进程内组件不显示这一栏。 */
  latency: RowLatency | null;
  cells: BarCell[] | null;
  loading: boolean;
  placeholderCount: number;
  revealKey: string;
  revealDelay: number;
}) {
  return (
    <li className="px-4 py-3.5">
      <div className="flex min-w-0 items-center gap-1.5 sm:gap-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {STATUS_COMPONENT_LABELS[id]}
        </span>
        {latency ? (
          // 口径说明走统一的悬停说明（与站内其它说明同一种浮层），不用浏览器原生 title。
          <Hint label={LATENCY_TITLE[latency.kind]}>
            <span className="flex shrink-0 items-center gap-2">
              {latency.series ? (
                <LatencySparkline values={latency.series} className="hidden sm:block" />
              ) : null}
              <span className="flex items-baseline gap-1 font-mono text-xs tabular-nums text-muted-foreground">
                {LATENCY_PREFIX[latency.kind] ? (
                  <span className="font-sans">{LATENCY_PREFIX[latency.kind]}</span>
                ) : null}
                <Readout value={formatLatency(latency.value)} />
              </span>
            </span>
          </Hint>
        ) : null}
        <span className="w-11 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground sm:w-14">
          <Readout value={formatRatio(ratio)} />
        </span>
        <LevelBadge level={level} />
      </div>
      <UptimeBar
        className="mt-2.5"
        cells={cells}
        loading={loading}
        placeholderCount={placeholderCount}
        revealKey={revealKey}
        revealDelay={revealDelay}
      />
    </li>
  );
}

export default function StatusPage() {
  const navigate = usePageNavigate();
  const { snapshot } = useStatusLive();
  const [view, setView] = useState<StatusView>("realtime");
  const [history, setHistory] = useState<Loadable<PublicStatusHistory>>(undefined);
  const [realtime, setRealtime] = useState<Loadable<PublicStatusRealtime>>(undefined);
  const [events, setEvents] = useState<Loadable<PublicStatusEvent[]>>(undefined);
  const [roundTripMs, setRoundTripMs] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    // 三份数据各自降级：一份读不到不拖其它两块。轮询失败时留着上一份读到的，
    // 条带不因一次超时被清空；从没读到过才落成「读失败」。
    const keepPrevious =
      <T,>(set: Dispatch<SetStateAction<Loadable<T>>>) =>
      (): void => {
        if (alive) set((previous) => previous ?? null);
      };
    const load = (): void => {
      void fetchStatusHistory().then(
        (value) => alive && setHistory(value),
        keepPrevious(setHistory)
      );
      void fetchStatusRealtime((milliseconds) => alive && setRoundTripMs(milliseconds)).then(
        (value) => alive && setRealtime(value),
        () => {
          keepPrevious(setRealtime)();
          if (alive) setRoundTripMs(null);
        }
      );
      void fetchStatusEvents().then((value) => alive && setEvents(value), keepPrevious(setEvents));
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
  const levelOf = (id: PublicStatusComponentId): PublicStatusLevel =>
    levels.get(id)?.level ?? "unknown";

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
    if (!realtime) return null;
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
          events: (events ?? []).filter((event) => eventOverlaps(event, id, start, end)),
        };
      });
      result.set(id, cells);
    }
    return result;
  }, [realtime, realtimeById, events]);

  /** 月视图的日格：服务端按北京自然日给格子，这里只补事件重叠；缺条目的组件按同一串日子补空格。 */
  const monthCells = useMemo(() => {
    if (!history) return null;
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
          const start = monthCellStart(cell.day);
          const end = start + 86_400_000;
          return {
            key: `d${cell.day}`,
            level: cell.level,
            total: cell.total,
            ratio: cell.ratio,
            latencyMs: cell.latencyMs,
            when: DAY_FORMAT.format(start),
            events: (events ?? []).filter((event) => eventOverlaps(event, id, start, end)),
          };
        })
      );
    }
    return result;
  }, [history, historyById, events]);

  const cellsByView = view === "month" ? monthCells : realtimeCells;

  const ratioOf = (id: PublicStatusComponentId): number | null =>
    view === "month"
      ? (historyById.get(id)?.uptime.find((span) => span.days === PUBLIC_STATUS_HISTORY_DAYS)
          ?.ratio ?? null)
      : (realtimeById.get(id)?.uptime ?? null);

  const latencyOf = (id: PublicStatusComponentId): RowLatency | null => {
    // 往返延迟只有此刻这一个数，没有历史：月视图里后端一行不出延迟，不拿当下冒充 30 天。
    if (id === "backend") {
      return view === "realtime" ? { value: roundTripMs, series: null, kind: "roundTrip" } : null;
    }
    const series = cellsByView?.get(id)?.map((cell) => cell.latencyMs) ?? null;
    const value =
      view === "month"
        ? (historyById.get(id)?.latencyMs ?? null)
        : (levels.get(id)?.latencyMs ?? null);
    // 进程内组件（房间、数据集、图片缓存）没有延迟口径：整栏不出，不摆一排「—」。
    if (value === null && !series?.some((latency) => latency !== null)) return null;
    return { value, series, kind: view === "month" ? "average" : "current" };
  };

  const tally = tallyOf(ALL_COMPONENTS, levelOf);
  const overall = snapshot?.level ?? "unknown";
  const headline = headlineOf(snapshot, tally);
  const overallUptime = meanOf(ALL_COMPONENTS.map(ratioOf));
  const viewData = view === "month" ? history : realtime;

  return (
    <div className="h-full min-h-0 overflow-y-auto overscroll-contain">
      <Seo
        path="/status"
        title="服务状态 - BakaGame"
        description="BakaGame 服务状态：前端、后端、上游接口与本项目内部各能力的实时状态、延迟、历史可用率与事件维护记录。"
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

      <article className="mx-auto w-full max-w-3xl px-6 pb-12">
        <section
          aria-labelledby="status-summary"
          className={cn(
            "rounded-md border bg-card p-5 shadow-sm transition-colors duration-(--motion-duration-base) ease-(--motion-ease-out)",
            overall === "degraded" && "border-destructive/40"
          )}
        >
          <div className="flex items-start gap-3 sm:gap-4">
            <StatusGlyph level={overall} loading={!snapshot} />
            {/* 只播报标题与说明：数字每分钟都在变，放进 live region 会一直打断读屏。 */}
            <div className="min-w-0 flex-1 pt-0.5" aria-live="polite">
              <h2 id="status-summary" className="text-base leading-snug font-semibold sm:text-lg">
                {headline.title}
              </h2>
              {/* 组件名整体换行：窄屏不把「搜索索引」「网易云音乐 API」拆到两行；整句仍是同一段文字。 */}
              <p className="mt-0.5 text-sm text-muted-foreground">
                {headline.names
                  ? headline.names.map((name, index, names) => (
                      // 「异常：」与第一个名字绑在一起，不在行尾单独剩下一个前缀。
                      <span key={name} className="whitespace-nowrap">
                        {index === 0 ? `异常：${name}` : name}
                        {index < names.length - 1 ? "、" : null}
                      </span>
                    ))
                  : headline.detail}
              </p>
            </div>
          </div>
          <dl className="mt-5 grid grid-cols-3 border-t border-border pt-4">
            <SummaryStat
              label={`${VIEW_LABEL[view]}可用率`}
              shortLabel="可用率"
              value={formatRatio(overallUptime)}
            />
            <SummaryStat
              label="服务正常"
              shortLabel="服务正常"
              value={snapshot ? `${tally.operational.length}/${ALL_COMPONENTS.length}` : "—"}
            />
            <SummaryStat
              label="你的往返延迟"
              shortLabel="往返延迟"
              value={formatLatency(roundTripMs)}
            />
          </dl>
        </section>
        <p className="mt-2 flex min-h-4 flex-wrap justify-between gap-x-4 gap-y-0.5 px-1 text-2xs text-muted-foreground">
          {snapshot ? (
            <span>
              更新于{" "}
              <time
                dateTime={new Date(snapshot.observedAt).toISOString()}
                className="font-mono tabular-nums"
              >
                {CLOCK_FORMAT.format(snapshot.observedAt)}
              </time>
            </span>
          ) : null}
          {snapshot && snapshot.version !== "unknown" ? (
            <span className="font-mono">{snapshot.version}</span>
          ) : null}
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <SegmentedControl<StatusView>
            aria-label="时间范围"
            size="sm"
            value={view}
            onValueChange={setView}
            options={[
              { value: "realtime", label: VIEW_LABEL.realtime },
              { value: "month", label: VIEW_LABEL.month },
            ]}
          />
          <Legend />
        </div>

        {PUBLIC_STATUS_GROUPS.map((group) => (
          <section key={group.id} aria-labelledby={`status-group-${group.id}`} className="mt-6">
            <div className="flex items-baseline justify-between gap-3 px-1">
              <h2 id={`status-group-${group.id}`} className="text-sm font-semibold">
                {STATUS_GROUP_LABELS[group.id]}
              </h2>
              {snapshot ? (
                <p className="text-2xs text-muted-foreground">
                  {groupSummaryOf(tallyOf(group.components, levelOf), group.components.length)}
                </p>
              ) : null}
            </div>
            <ul className="mt-2 divide-y divide-border rounded-md border bg-card shadow-2xs">
              {group.components.map((id) => (
                <ComponentRow
                  key={id}
                  id={id}
                  level={levelOf(id)}
                  ratio={ratioOf(id)}
                  latency={latencyOf(id)}
                  cells={cellsByView?.get(id) ?? null}
                  loading={viewData === undefined}
                  placeholderCount={view === "month" ? PUBLIC_STATUS_HISTORY_DAYS : REALTIME_CELLS}
                  revealKey={view}
                  revealDelay={Math.min(
                    ALL_COMPONENTS.indexOf(id) * uptimeReveal.step,
                    uptimeReveal.span
                  )}
                />
              ))}
            </ul>
            <div
              aria-hidden="true"
              className="mt-1.5 flex justify-between px-4 font-mono text-2xs text-muted-foreground"
            >
              <span>{AXIS_LABEL[view][0]}</span>
              <span>{AXIS_LABEL[view][1]}</span>
            </div>
          </section>
        ))}

        <StatusEventsSection events={events} />

        <p className="mt-10 text-center text-2xs text-muted-foreground">
          时间均为北京时间 · 实时条带每 {SAMPLE_MINUTES} 分钟一格 · 页面自动刷新
        </p>
      </article>
    </div>
  );
}
