import {
  PUBLIC_STATUS_COMPONENT_IDS,
  type PublicStatusComponent,
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

/** 页面手动刷新时调用；不做轮询，失败直接抛给页面按「未知」降级。 */
export const fetchSystemStatus = async (): Promise<PublicStatusSnapshot> => {
  const response = await fetch(resolveServerUrl("/api/status"), {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(STATUS_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`状态接口返回 HTTP ${response.status}`);
  return parseSystemStatus(await response.json());
};
