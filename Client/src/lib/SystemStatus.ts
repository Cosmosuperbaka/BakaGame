import {
  PUBLIC_STATUS_COMPONENT_IDS,
  type PublicStatusCell,
  type PublicStatusComponent,
  type PublicStatusComponentId,
  type PublicStatusHistory,
  type PublicStatusHistoryEntry,
  type PublicStatusLevel,
  type PublicStatusSnapshot,
} from "@bakagame/shared";
import { resolveServerUrl } from "@/lib/ServerEndpoint";

/** 后端状态探测超时：后端不可达时页面最多等这么久就开始降级展示。 */
export const STATUS_REQUEST_TIMEOUT_MS = 5_000;

const LEVELS = new Set<string>(["operational", "degraded", "unknown"]);
const COMPONENT_IDS = new Set<string>(PUBLIC_STATUS_COMPONENT_IDS);

const isLevel = (value: unknown): value is PublicStatusLevel =>
  typeof value === "string" && LEVELS.has(value);

const parseComponents = (value: unknown): PublicStatusComponent[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || !COMPONENT_IDS.has(record.id)) return [];
    if (!isLevel(record.level)) return [];
    return [{ id: record.id as PublicStatusComponent["id"], level: record.level }];
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
  const response = await fetch(resolveServerUrl("/api/status"), {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(STATUS_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`状态接口返回 HTTP ${response.status}`);
  return parseSystemStatus(await response.json());
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
        { day: cell.day, total: cell.total, ratio: parseRatio(cell.ratio), level: cell.level },
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
    return [{ id: entry.id as PublicStatusComponentId, uptime, cells }];
  });
  return {
    days: record.days,
    generatedAt: typeof record.generatedAt === "number" ? record.generatedAt : Date.now(),
    entries,
  };
};

/** 历史一次读满展示窗口；读失败由页面单独降级，不影响当前状态。 */
export const fetchStatusHistory = async (): Promise<PublicStatusHistory> => {
  const response = await fetch(resolveServerUrl("/api/status/history"), {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(STATUS_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`历史接口返回 HTTP ${response.status}`);
  return parseStatusHistory(await response.json());
};
