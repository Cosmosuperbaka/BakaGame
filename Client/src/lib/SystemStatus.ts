import { PUBLIC_STATUS_COMPONENT_IDS } from "@bakagame/shared/values";
import type {
  PublicStatusCell,
  PublicStatusComponent,
  PublicStatusComponentId,
  PublicStatusEvent,
  PublicStatusGroupId,
  PublicStatusHistory,
  PublicStatusHistoryEntry,
  PublicStatusLevel,
  PublicStatusRealtime,
  PublicStatusRealtimeEntry,
  PublicStatusSampleCell,
  PublicStatusSnapshot,
} from "@bakagame/shared";
import { fetchJson } from "@/lib/HttpJson";

/** 状态接口的请求选项：永远读最新，不吃缓存；超时用 `fetchJson` 的默认值，后端不可达时页面据此降级展示。 */
const STATUS_INIT = { cache: "no-store", headers: { accept: "application/json" } } as const;
/** 实时条带与事件的轮询间隔：采样本身 3 分钟一轮，页面没必要比它更勤。 */
export const STATUS_POLL_INTERVAL_MS = 60_000;

const LEVELS = new Set<string>(["operational", "degraded", "unknown"]);
const COMPONENT_IDS = new Set<string>(PUBLIC_STATUS_COMPONENT_IDS);

/** 组件的公开名称：状态页与后台事件面板共用同一份，不各写一套。 */
export const STATUS_COMPONENT_LABELS: Record<PublicStatusComponentId, string> = {
  frontend: "前端站点",
  backend: "后端服务",
  bangumi: "Bangumi API",
  qqmusic: "QQ音乐 API",
  netease: "网易云音乐 API",
  qq: "QQ API",
  rooms: "房间服务",
  search: "搜索索引",
  dataset: "番剧数据",
  images: "图片缓存",
};

export const STATUS_GROUP_LABELS: Record<PublicStatusGroupId, string> = {
  platform: "服务整体",
  upstream: "上游接口",
  internal: "本项目内部服务",
};

/** 状态事件的进度文案：事件与维护各一档，页面与后台共用。 */
export const STATUS_EVENT_STATUS_LABELS = {
  investigating: "调查中",
  identified: "已定位",
  monitoring: "观察中",
  resolved: "已恢复",
  scheduled: "计划中",
  in_progress: "进行中",
  done: "已完成",
} as const;

export const isLevel = (value: unknown): value is PublicStatusLevel =>
  typeof value === "string" && LEVELS.has(value);

/**
 * 延迟毫秒数：只认有限的非负数，四舍五入成整数；缺字段或不合形状读作 null（页面显示「—」或不显示）。
 * 快照、实时格与日格共用这一份：旧后端不给日格延迟时同样落成 null，页面照常渲染。
 */
const parseLatency = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

const parseComponents = (value: unknown): PublicStatusComponent[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || !COMPONENT_IDS.has(record.id)) return [];
    if (!isLevel(record.level)) return [];
    return [
      {
        id: record.id as PublicStatusComponent["id"],
        level: record.level,
        latencyMs: parseLatency(record.latencyMs),
      },
    ];
  });
};

/**
 * 校验 `/api/status` 的响应。只接受白名单组件：后端将来新增的组件在旧页面上忽略，
 * 页面按自己的白名单顺序渲染，缺项一律显示未知，不因字段变化而白屏。
 */
export const parseSystemStatus = (value: unknown): PublicStatusSnapshot => {
  if (!value || typeof value !== "object") throw new Error("状态接口返回了无效数据");
  const record = value as Record<string, unknown>;
  if (
    typeof record.observedAt !== "number" ||
    !Number.isFinite(record.observedAt) ||
    !isLevel(record.level) ||
    typeof record.version !== "string" ||
    !Array.isArray(record.components)
  ) {
    throw new Error("状态接口返回了无效数据");
  }
  return {
    observedAt: record.observedAt,
    level: record.level,
    version: record.version,
    components: parseComponents(record.components),
  };
};

/** 页面手动刷新时调用；失败直接抛给页面按「未知」降级。 */
export const fetchSystemStatus = async (): Promise<PublicStatusSnapshot> => {
  return parseSystemStatus(
    await fetchJson("/api/status", { label: "状态接口", init: STATUS_INIT })
  );
};

const parseRatio = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;

/**
 * 校验 `/api/status/history`。逐组件、逐格宽松收下：读不到的格子按「无样本」渲染，
 * 历史是页面里最不要紧的一块，任何一处形状不合都不该把当前状态一起拖没。
 */
export const parseStatusHistory = (value: unknown): PublicStatusHistory => {
  if (!value || typeof value !== "object") throw new Error("历史接口返回了无效数据");
  const record = value as Record<string, unknown>;
  if (typeof record.days !== "number" || !Array.isArray(record.entries)) {
    throw new Error("历史接口返回了无效数据");
  }
  const entries: PublicStatusHistoryEntry[] = record.entries.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== "string" || !COMPONENT_IDS.has(entry.id)) return [];
    if (!Array.isArray(entry.cells)) return [];
    const cells: PublicStatusCell[] = entry.cells.flatMap((raw) => {
      if (!raw || typeof raw !== "object") return [];
      const cell = raw as Record<string, unknown>;
      if (typeof cell.day !== "string" || typeof cell.total !== "number" || !isLevel(cell.level)) {
        return [];
      }
      return [
        {
          day: cell.day,
          total: cell.total,
          ratio: parseRatio(cell.ratio),
          level: cell.level,
          latencyMs: parseLatency(cell.latencyMs),
        },
      ];
    });
    const uptime = Array.isArray(entry.uptime)
      ? entry.uptime.flatMap((raw) => {
          if (!raw || typeof raw !== "object") return [];
          const span = raw as Record<string, unknown>;
          if (typeof span.days !== "number") return [];
          return [{ days: span.days, ratio: parseRatio(span.ratio) }];
        })
      : [];
    return [
      {
        id: entry.id as PublicStatusComponentId,
        uptime,
        latencyMs: parseLatency(entry.latencyMs),
        cells,
      },
    ];
  });
  return {
    days: record.days,
    generatedAt: typeof record.generatedAt === "number" ? record.generatedAt : Date.now(),
    entries,
  };
};

/** 历史一次读满展示窗口；读失败由页面单独降级，不影响当前状态。 */
export const fetchStatusHistory = async (): Promise<PublicStatusHistory> => {
  return parseStatusHistory(
    await fetchJson("/api/status/history", { label: "历史接口", init: STATUS_INIT })
  );
};

const parseSampleCells = (value: unknown): PublicStatusSampleCell[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const cell = raw as Record<string, unknown>;
    if (
      typeof cell.start !== "number" ||
      !Number.isFinite(cell.start) ||
      typeof cell.total !== "number" ||
      !isLevel(cell.level)
    ) {
      return [];
    }
    return [
      {
        start: cell.start,
        total: cell.total,
        ratio: parseRatio(cell.ratio),
        level: cell.level,
        latencyMs: parseLatency(cell.latencyMs),
      },
    ];
  });
};

/**
 * 校验 `/api/status/realtime`：窗口内没有样本的格子由服务端省略，
 * 页面按 `start` 对齐补空格，读不到形状的条目整条丢弃而不是白屏。
 */
export const parseStatusRealtime = (value: unknown): PublicStatusRealtime => {
  if (!value || typeof value !== "object") throw new Error("实时接口返回了无效数据");
  const record = value as Record<string, unknown>;
  if (
    typeof record.intervalMs !== "number" ||
    typeof record.windowMs !== "number" ||
    !Array.isArray(record.entries)
  ) {
    throw new Error("实时接口返回了无效数据");
  }
  const entries: PublicStatusRealtimeEntry[] = record.entries.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== "string" || !COMPONENT_IDS.has(entry.id)) return [];
    return [
      {
        id: entry.id as PublicStatusComponentId,
        uptime: parseRatio(entry.uptime),
        cells: parseSampleCells(entry.cells),
      },
    ];
  });
  return {
    intervalMs: record.intervalMs,
    windowMs: record.windowMs,
    generatedAt: typeof record.generatedAt === "number" ? record.generatedAt : Date.now(),
    entries,
  };
};

/**
 * 读实时条带。`onRoundTrip` 拿到这次请求从发出到响应头到达的毫秒数：
 * 实时接口只读内存账本、几乎不占服务端时间，这段耗时就是浏览器到后端的往返，
 * 状态页拿它给「后端服务」一行配延迟，不为测延迟另开一条请求。
 */
export const fetchStatusRealtime = async (
  onRoundTrip?: (milliseconds: number) => void
): Promise<PublicStatusRealtime> => {
  return parseStatusRealtime(
    await fetchJson("/api/status/realtime", { label: "实时接口", init: STATUS_INIT, onRoundTrip })
  );
};

/**
 * 校验 `/api/status/events`。事件的组件清单重新过白名单，
 * 读不到形状的事件丢弃，不影响其余条目。
 */
export const parseStatusEvents = (value: unknown): PublicStatusEvent[] => {
  if (!value || typeof value !== "object") throw new Error("事件接口返回了无效数据");
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.events)) throw new Error("事件接口返回了无效数据");
  const known = new Set(Object.keys(STATUS_EVENT_STATUS_LABELS));
  return record.events.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const event = raw as Record<string, unknown>;
    if (
      typeof event.id !== "number" ||
      (event.kind !== "incident" && event.kind !== "maintenance") ||
      typeof event.title !== "string" ||
      typeof event.body !== "string" ||
      typeof event.status !== "string" ||
      !known.has(event.status) ||
      typeof event.startedAt !== "number" ||
      typeof event.updatedAt !== "number"
    ) {
      return [];
    }
    const components = Array.isArray(event.components)
      ? event.components.filter(
          (id): id is PublicStatusComponentId => typeof id === "string" && COMPONENT_IDS.has(id)
        )
      : [];
    const ended = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    return [
      {
        id: event.id,
        kind: event.kind,
        title: event.title,
        body: event.body,
        status: event.status as PublicStatusEvent["status"],
        components,
        startedAt: event.startedAt,
        plannedEndAt: ended(event.plannedEndAt),
        resolvedAt: ended(event.resolvedAt),
        updatedAt: event.updatedAt,
      },
    ];
  });
};

export const fetchStatusEvents = async (): Promise<PublicStatusEvent[]> => {
  return parseStatusEvents(
    await fetchJson("/api/status/events", { label: "事件接口", init: STATUS_INIT })
  );
};
