import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PUBLIC_STATUS_GROUPS,
  type PublicStatusCell,
  type PublicStatusComponentId,
  type PublicStatusHistory,
  type PublicStatusLevel,
} from "@bakagame/shared";
import { ArrowLeft, CheckCircle2, CircleHelp, RefreshCw, TriangleAlert, Wifi } from "lucide-react";
import { Seo } from "@/components/common/Seo";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Hint } from "@/components/ui/Tooltip";
import { usePageNavigate } from "@/hooks/UsePageTransition";
import { useStatusLive, type StatusConnection } from "@/hooks/UseStatusLive";
import { fetchStatusHistory } from "@/lib/SystemStatus";
import { cn } from "@/lib/Utils";

const COMPONENT_LABELS: Record<PublicStatusComponentId, string> = {
  frontend: "前端站点",
  backend: "后端服务",
  upstream: "上游可用性",
  rooms: "房间服务",
  search: "搜索索引",
  dataset: "番剧数据",
  images: "图片缓存",
};

const GROUP_LABELS: Record<string, string> = {
  platform: "服务整体",
  internal: "本项目内部服务",
};

/** 上游可用性取自外部监测：说明它看的是整个工作区的探针聚合，不是某一个上游。 */
const COMPONENT_HINTS: Partial<Record<PublicStatusComponentId, string>> = {
  upstream: "由外部监测平台聚合探针的当前结果",
};

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

/** 百分比只在有样本时给；没探过的窗口读作「—」，不拿 0% 冒充全挂。 */
const formatRatio = (ratio: number | null): string =>
  ratio === null ? "—" : `${(ratio * 100).toFixed(ratio >= 0.9995 ? 1 : 2)}%`;

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

/**
 * 日格条带：一格一个自然日，左旧右新，与 UptimeKuma、BetterStack 的状态页同一读法。
 *
 * 整条带作为一个图像读给读屏，逐格不单独挂悬停说明：90 枚 tooltip 既没人真去逐格悬停，
 * 也会把键盘 Tab 拖成一条走不完的链。每行右侧另有文字状态与百分比，颜色不是唯一线索。
 */
function UptimeBar({ cells }: { cells: PublicStatusCell[] }) {
  const operational = cells.filter((cell) => cell.level === "operational").length;
  const degraded = cells.filter((cell) => cell.level === "degraded").length;
  const sampled = cells.filter((cell) => cell.total > 0).length;
  const label =
    sampled === 0
      ? "这段时间还没有探测样本"
      : `${sampled} 天有数据，其中 ${operational} 天正常、${degraded} 天异常`;

  return (
    <div
      role="img"
      aria-label={label}
      className="mt-2 flex items-stretch gap-px overflow-hidden rounded-sm"
    >
      {cells.map((cell) => (
        <span
          key={cell.day}
          aria-hidden="true"
          className={cn(
            "h-6 min-w-0 flex-1",
            cell.total === 0 ? "bg-muted" : CELL_CLASS[cell.level]
          )}
        />
      ))}
    </div>
  );
}

/**
 * 全站可用率：把窗口内所有组件的样本合起来算，而不是各组件百分比的平均——
 * 探测多的日子权重就大。没有样本时返回 null，页面读作「—」。
 */
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

/** 通道状态：读的是「这一页还在自己更新吗」，与「服务是否正常」是两件事。 */
function ConnectionIndicator({ connection }: { connection: StatusConnection }) {
  const text =
    connection === "live" ? "实时" : connection === "connecting" ? "连接中" : "已断开";
  const label =
    connection === "live"
      ? "已连接实时通道，状态会自动更新"
      : connection === "connecting"
        ? "正在连接实时通道"
        : "实时通道已断开，显示的是最后一次读到的状态";
  return (
    <Hint label={label}>
      <span
        className="flex items-center gap-1.5 font-sans text-2xs text-muted-foreground"
        aria-live="polite"
      >
        <Wifi aria-hidden="true" className="h-3.5 w-3.5" />
        {text}
        <span
          aria-hidden="true"
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            connection === "live" ? "bg-success" : "bg-muted-foreground/40"
          )}
        />
      </span>
    </Hint>
  );
}

function ComponentRow({
  id,
  level,
  cells,
  uptime,
}: {
  id: PublicStatusComponentId;
  level: PublicStatusLevel;
  cells: PublicStatusCell[];
  uptime: number | null;
}) {
  const label = COMPONENT_LABELS[id];
  const hint = COMPONENT_HINTS[id];
  return (
    <li className="px-4 py-3">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          {hint ? (
            <Hint label={hint}>
              <span className="truncate text-sm font-medium">{label}</span>
            </Hint>
          ) : (
            <span className="truncate text-sm font-medium">{label}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {/* 百分比与状态徽章并排：数字给趋势，徽章给当下，两者互为文字说明。 */}
          <span className="font-sans text-xs tabular-nums text-muted-foreground">
            {formatRatio(uptime)}
          </span>
          <LevelBadge level={level} />
        </div>
      </div>
      <UptimeBar cells={cells} />
    </li>
  );
}

export default function StatusPage() {
  const navigate = usePageNavigate();
  const { snapshot, connection, refresh, fetchOnce } = useStatusLive();
  const [history, setHistory] = useState<PublicStatusHistory | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetchStatusHistory()
      .then((value) => {
        if (alive) setHistory(value);
      })
      .catch(() => {
        // 历史读不到只让条带空着，当前状态仍由实时通道给出。
        if (alive) setHistory(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  /** 手动刷新优先让服务端经通道立刻重推；通道没开才退回一次 HTTP 请求，两条路都顺带补历史。 */
  const onRefresh = useCallback(async () => {
    const pushed = refresh();
    if (!pushed) {
      setPending(true);
      try {
        await fetchOnce();
      } catch {
        // 拉不到就保留上一次快照，通道指示已经说明了它不再更新。
      } finally {
        setPending(false);
      }
    }
    setHistory(await fetchStatusHistory().catch(() => null));
  }, [refresh, fetchOnce]);

  const levels = useMemo(
    () => new Map(snapshot?.components.map((component) => [component.id, component.level])),
    [snapshot]
  );
  const historyById = useMemo(
    () => new Map(history?.entries.map((entry) => [entry.id, entry])),
    [history]
  );

  /** 全站可用率：所有组件的样本合起来算，不是各组件百分比的平均——样本多的日子权重就大。 */
  const overallUptime = useMemo(() => computeOverallUptime(history), [history]);

  const overall = snapshot?.level ?? "unknown";
  const degradedCount = snapshot
    ? snapshot.components.filter((component) => component.level === "degraded").length
    : 0;

  return (
    <div className="h-full min-h-0 overflow-y-auto overscroll-contain">
      <Seo
        path="/status"
        description="BakaGame 服务状态：前端、后端、上游可用性与本项目内部各能力的实时状态与历史可用率。"
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
          <ConnectionIndicator connection={connection} />
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => void onRefresh()}
            disabled={pending}
          >
            <RefreshCw aria-hidden="true" className={pending ? "animate-spin" : undefined} />
            刷新
          </Button>
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
          {/* 全站可用率：把窗口内所有组件的样本合起来算的一个数。 */}
          <p className="mt-2 flex items-baseline gap-2 text-sm">
            <span className="font-mono text-2xl leading-none tabular-nums">
              {formatRatio(overallUptime)}
            </span>
            <span className="font-sans text-2xs text-muted-foreground">
              {`${history?.days ?? 90} 天全站可用率`}
            </span>
          </p>
        </section>

        {PUBLIC_STATUS_GROUPS.map((group) => (
          <section key={group.id} aria-labelledby={`status-group-${group.id}`} className="mt-6">
            <h2
              id={`status-group-${group.id}`}
              className="font-sans text-2xs text-muted-foreground"
            >
              {GROUP_LABELS[group.id]}
            </h2>
            <ul className="mt-2 divide-y divide-border overflow-hidden rounded-md border bg-card shadow-2xs">
              {group.components.map((id) => (
                <ComponentRow
                  key={id}
                  id={id}
                  level={levels.get(id) ?? "unknown"}
                  cells={historyById.get(id)?.cells ?? []}
                  uptime={
                    historyById.get(id)?.uptime.find((span) => span.days === 90)?.ratio ?? null
                  }
                />
              ))}
            </ul>
          </section>
        ))}
      </article>
    </div>
  );
}
