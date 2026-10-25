import type { ExternalStatusProbe, ExternalStatusReading } from "./ExternalStatusProbe";
import { fetchWithGuardedRedirects } from "./OutboundGuard";
import {
  UPSTREAM_STATUS_COMPONENT_IDS,
  type PublicStatusLevel,
  type UpstreamStatusComponentId,
} from "../shared/Status";

const DEFAULT_BASE_URL = "https://uptime.betterstack.com/api/v2";
const PROBE_TIMEOUT_MS = 4_000;
/** 与状态快照的 15 秒缓存叠加：外部监测最多每 30 秒被请求一次。 */
const DEFAULT_CACHE_TTL_MS = 30_000;
/** 一次拉全工作区的 monitor：上游接口只有四个，这一页足够，翻页场景不属于本项目。 */
const MONITORS_PAGE_SIZE = 100;

export interface BetterStackStatusProbeOptions {
  apiKey: string;
  /**
   * 上游组件 → Better Stack monitor ID 的映射；由部署环境注入（`BETTERSTACK_MONITOR_MAP`）。
   * 未映射的组件读作未知，不靠 monitor 名称猜测。
   */
  monitors: Partial<Record<UpstreamStatusComponentId, string>>;
  fetcher?: typeof fetch;
  baseUrl?: string;
  now?: () => number;
  cacheTtlMs?: number;
}

/** Better Stack 的 monitor 状态归一化：只有明确的 up/down 才算结论，其余保持未知。 */
const levelOfMonitor = (value: unknown): PublicStatusLevel => {
  if (!value || typeof value !== "object") return "unknown";
  const attributes = (value as { attributes?: unknown }).attributes;
  if (!attributes || typeof attributes !== "object") return "unknown";
  const { status, paused } = attributes as { status?: unknown; paused?: unknown };
  if (paused === true) return "unknown";
  if (status === "up") return "operational";
  if (status === "down") return "degraded";
  return "unknown";
};

/** `average_response_time` 是毫秒数；缺失或非法时不编一个延迟出来。 */
const latencyOfMonitor = (value: unknown): number | null => {
  if (!value || typeof value !== "object") return null;
  const attributes = (value as { attributes?: unknown }).attributes;
  if (!attributes || typeof attributes !== "object") return null;
  const raw = (attributes as { average_response_time?: unknown }).average_response_time;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
};

export const monitorReadings = (
  data: unknown,
  monitors: Partial<Record<UpstreamStatusComponentId, string>>
): ExternalStatusReading => {
  if (!Array.isArray(data)) return {};
  const byMonitorId = new Map<string, unknown>();
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id === "string" || typeof id === "number") byMonitorId.set(String(id), item);
  }
  const reading: ExternalStatusReading = {};
  for (const id of UPSTREAM_STATUS_COMPONENT_IDS) {
    const monitorId = monitors[id];
    if (!monitorId) continue;
    const item = byMonitorId.get(monitorId);
    if (item === undefined) continue;
    const level = levelOfMonitor(item);
    reading[id] = { level, latencyMs: level === "operational" ? latencyOfMonitor(item) : null };
  }
  return reading;
};

/**
 * Better Stack Uptime 只读探针：一次拉取工作区 monitor 列表，按配置的 ID 映射拆成各上游组件的读数。
 *
 * 只读 token 通过 `Authorization: Bearer` 发送，绝不进入响应、日志或页面；
 * 短缓存避免每次快照都打一次上游，网络失败时回 `null` 交给状态页显示未知。
 */
export class BetterStackStatusProbe implements ExternalStatusProbe {
  private readonly apiKey: string;
  private readonly monitors: Partial<Record<UpstreamStatusComponentId, string>>;
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private cached?: { at: number; reading: ExternalStatusReading };

  constructor(options: BetterStackStatusProbeOptions) {
    if (!options.apiKey.trim()) throw new Error("Better Stack API key 不能为空");
    this.apiKey = options.apiKey.trim();
    this.monitors = options.monitors;
    this.fetcher = options.fetcher ?? fetch;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  async read(): Promise<ExternalStatusReading | null> {
    const at = this.now();
    if (this.cached && at - this.cached.at < this.cacheTtlMs) return this.cached.reading;
    try {
      const response = await fetchWithGuardedRedirects(
        this.fetcher,
        `${this.baseUrl}/monitors?page[size]=${MONITORS_PAGE_SIZE}`,
        {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        },
        { pinOrigin: true }
      );
      if (!response.ok) return null;
      const reading = monitorReadings((await response.json()).data, this.monitors);
      if (Object.keys(reading).length > 0) this.cached = { at, reading };
      return reading;
    } catch {
      return null;
    }
  }
}
