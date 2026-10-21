import type { ExternalStatusProbe } from "./ExternalStatusProbe";
import { fetchWithGuardedRedirects } from "./OutboundGuard";
import type { PublicStatusLevel } from "../shared/Status";

const DEFAULT_BASE_URL = "https://uptime.betterstack.com/api/v2";
const PROBE_TIMEOUT_MS = 4_000;
/** 与状态快照的 15 秒缓存叠加：外部监测最多每 30 秒被请求一次。 */
const DEFAULT_CACHE_TTL_MS = 30_000;

export interface BetterStackStatusProbeOptions {
  apiKey: string;
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

/**
 * 聚合整个工作区的 monitor：任一 down 即异常；全部 up 才正常；
 * 只要还有暂停、待确认或未知项，就不替它下结论。
 */
export const aggregateBetterStackMonitors = (data: unknown): PublicStatusLevel | null => {
  if (!Array.isArray(data) || data.length === 0) return null;
  const levels = data.map(levelOfMonitor);
  if (levels.includes("degraded")) return "degraded";
  if (levels.every((level) => level === "operational")) return "operational";
  return "unknown";
};

/**
 * Better Stack Uptime 只读探针。
 *
 * 只读 token 通过 `Authorization: Bearer` 发送，绝不进入响应、日志或页面；
 * 短缓存避免每次手动刷新都打一次上游，网络失败时回 `null` 交给状态页显示未知。
 */
export class BetterStackStatusProbe implements ExternalStatusProbe {
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private cached?: { at: number; level: PublicStatusLevel };

  constructor(options: BetterStackStatusProbeOptions) {
    if (!options.apiKey.trim()) throw new Error("Better Stack API key 不能为空");
    this.apiKey = options.apiKey.trim();
    this.fetcher = options.fetcher ?? fetch;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  async read(): Promise<PublicStatusLevel | null> {
    const at = this.now();
    if (this.cached && at - this.cached.at < this.cacheTtlMs) return this.cached.level;
    try {
      const response = await fetchWithGuardedRedirects(
        this.fetcher,
        `${this.baseUrl}/monitors`,
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
      const level = aggregateBetterStackMonitors((await response.json()).data);
      if (level) this.cached = { at, level };
      return level;
    } catch {
      return null;
    }
  }
}
