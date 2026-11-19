import { BANGUMI_USER_AGENT } from "./BangumiUserAgent";
import type {
  ExternalStatusProbe,
  ExternalStatusReading,
  ExternalMonitorReading,
} from "./ExternalStatusProbe";
import { UPSTREAM_STATUS_COMPONENT_IDS, type UpstreamStatusComponentId } from "../shared/Status";

/** 一个上游接口的直连探测目标：固定地址，可附带必需的请求头。 */
export interface DirectUpstreamTarget {
  url: string;
  headers?: Record<string, string>;
}

export interface DirectUpstreamStatusProbeOptions {
  /** 缺省为空：没有目标就没有读数，页面读作未知，不冒充结论。 */
  targets?: Partial<Record<UpstreamStatusComponentId, DirectUpstreamTarget>>;
  fetcher?: typeof fetch;
  now?: () => number;
  /** 整份读数的缓存时长：状态快照每 15 秒聚合一次，不能每次都打上游。 */
  cacheTtlMs?: number;
  timeoutMs?: number;
}

/**
 * 四个上游接口的缺省探测目标：都是本项目实际依赖的公网接口地址（代码常量，非运维注入），
 * 路径取最轻的可达性探针。3xx 与除 403/429 以外的 4xx 都说明对端在应答，读作 operational。
 */
export const defaultUpstreamTargets = (
  bangumiApiUrl: string
): Record<UpstreamStatusComponentId, DirectUpstreamTarget> => ({
  bangumi: {
    url: `${bangumiApiUrl.replace(/\/+$/, "")}/v0/subjects/1`,
    // Bangumi 官方规范要求声明 UA，缺了会被拒。
    headers: { "User-Agent": BANGUMI_USER_AGENT },
  },
  qqmusic: { url: "https://u.y.qq.com/cgi-bin/musicu.fcg" },
  netease: { url: "https://music.163.com/api/" },
  qq: { url: "https://q1.qlogo.cn/g?b=qq&nk=10000&s=100" },
});

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 4_000;

/**
 * 直连上游探针：不依赖外部监测服务，服务端自己 GET 一次各上游接口拿可达性与响应耗时。
 *
 * 目标全部来自代码常量与运维配置（非第三方输入），且 `redirect: "manual"` 永不跟随跳转，
 * 因此不需要 `fetchWithGuardedRedirects` 的逐跳护栏。超时与网络错误一律 degraded：
 * 探不到就是不可达证据，与「未接入监测」的 unknown 分开；被对端 403/429 拒绝则没有结论。
 */
export class DirectUpstreamStatusProbe implements ExternalStatusProbe {
  private readonly targets: Partial<Record<UpstreamStatusComponentId, DirectUpstreamTarget>>;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private cached?: { at: number; reading: ExternalStatusReading };
  /** 同一时刻只跑一轮探测：并行消费者共享同一份在途结果，不打重复请求。 */
  private inflight: Promise<ExternalStatusReading | null> | undefined;

  constructor(options: DirectUpstreamStatusProbeOptions = {}) {
    this.targets = options.targets ?? {};
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async read(): Promise<ExternalStatusReading | null> {
    const at = this.now();
    if (this.cached && at - this.cached.at < this.cacheTtlMs) return this.cached.reading;
    this.inflight ??= this.probeAll(at).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async probeAll(at: number): Promise<ExternalStatusReading | null> {
    const ids = UPSTREAM_STATUS_COMPONENT_IDS.filter((id) => this.targets[id]);
    if (ids.length === 0) return null;
    const readings = await Promise.all(
      ids.map(async (id): Promise<[UpstreamStatusComponentId, ExternalMonitorReading]> => [
        id,
        await this.probeTarget(this.targets[id]!),
      ])
    );
    const reading: ExternalStatusReading = {};
    for (const [id, value] of readings) reading[id] = value;
    this.cached = { at, reading };
    return reading;
  }

  private async probeTarget(target: DirectUpstreamTarget): Promise<ExternalMonitorReading> {
    try {
      const startedAt = performance.now();
      const response = await this.fetcher(target.url, {
        method: "GET",
        redirect: "manual",
        headers: target.headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      // 计时到响应头为止；正文立即释放，探测不消费 body。
      const latencyMs = Math.round(performance.now() - startedAt);
      await response.body?.cancel().catch(() => {});
      // 拿到 HTTP 响应且状态码 < 500 说明对端在应答；5xx 才是服务端故障。
      // 403 与 429 例外：那是对端在封禁或限流**我们**，应答本身不能证明服务可用，
      // 记成正常会让「出口 IP 被封」的状态页仍一片绿，读作没有结论才诚实。
      if (response.status === 403 || response.status === 429)
        return { level: "unknown", latencyMs: null };
      const level = response.status < 500 ? "operational" : "degraded";
      return { level, latencyMs: level === "operational" ? latencyMs : null };
    } catch {
      return { level: "degraded", latencyMs: null };
    }
  }
}
