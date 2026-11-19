import type { PublicStatusComponentId, PublicStatusLevel } from "@bakagame/shared";
import { Hint } from "@/components/ui/Tooltip";
import { STATUS_COMPONENT_LABELS } from "@/lib/SystemStatus";
import { LatencySparkline } from "./LatencySparkline";
import { Readout, LevelBadge } from "./StatusReadout";
import { HISTORY_WINDOW_LABEL, formatLatency, formatRatio, type BarCell } from "./StatusFormat";
import { UptimeBar } from "./UptimeBar";

/**
 * 行内延迟读的是哪一种数：实时视图给当前探测耗时；月视图给窗口内的样本加权均值；
 * 后端一行给浏览器到后端的往返（服务端探不了自己）。后两种在数字前标出口径，免得和「当前」混读。
 */
export type LatencyKind = "current" | "average" | "roundTrip";

const LATENCY_PREFIX: Record<LatencyKind, string | null> = {
  current: null,
  average: "平均",
  roundTrip: "往返",
};

const LATENCY_TITLE: Record<LatencyKind, string> = {
  current: "服务端访问这项服务的响应耗时",
  average: `${HISTORY_WINDOW_LABEL}服务端访问这项服务的平均响应耗时`,
  roundTrip: "从你的浏览器到后端服务的往返耗时，每分钟测一次",
};

export interface RowLatency {
  value: number | null;
  /** 当前视图窗口里每格的平均延迟，画成走势；没有窗口数据（往返延迟）时为 null。 */
  series: (number | null)[] | null;
  kind: LatencyKind;
}

export function ComponentRow({
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
