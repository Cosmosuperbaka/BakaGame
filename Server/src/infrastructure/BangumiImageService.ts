import { BangumiImageStore, type StoredImage } from "./BangumiImageStore";
import { SlidingWindowRateLimiter } from "./RateLimiter";

/**
 * 自建图床的读取侧（主线程）。路由请求先查分片缓存；缺失时按需回源抓一份
 * avif（`Accept: image/avif`，经反代），并交给数据 Worker 落库——维持
 * **单写者**原则：主线程只读分片、绝不直接写，写操作全部转给 Worker。
 *
 * 回源是尽力而为：失败返回 undefined（路由 404），下一次请求或后台更新器会补。
 * 全局限速兜底：全新路径的批量请求（爬虫、异常页面）不会把上游打爆。
 */
export interface BangumiImageServiceOptions {
  directory: string;
  /** 回源前缀（Bangumi 反代地址，如 https://bangumi.baka.website）；为空则只读缓存、不回源。 */
  sourceBase?: string;
  fetcher?: typeof fetch;
  logger?: { warn: (message: string, context?: Record<string, unknown>) => void };
  /** 把新抓到的图转交数据 Worker 落库；失败只记警告（这张图下次再抓）。 */
  persist?: (path: string, image: StoredImage) => void;
  /** 每分钟最多回源多少张（默认 120）。 */
  upstreamPerMinute?: number;
  now?: () => number;
}

const AVIF_MAGIC = "ftypav";

/** 与构建脚本同款校验：avif 魔数必须出现在前 16 字节内。 */
export function hasAvifMagic(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 16);
  for (let i = 0; i + AVIF_MAGIC.length <= head.length; i += 1) {
    let hit = true;
    for (let j = 0; j < AVIF_MAGIC.length; j += 1) {
      if (head[i + j] !== AVIF_MAGIC.charCodeAt(j)) { hit = false; break; }
    }
    if (hit) return true;
  }
  return false;
}

export class BangumiImageService {
  private readonly store?: BangumiImageStore;
  private readonly sourceBase: string;
  private readonly fetcher: typeof fetch;
  private readonly logger?: BangumiImageServiceOptions["logger"];
  private readonly persist?: BangumiImageServiceOptions["persist"];
  private readonly limiter: SlidingWindowRateLimiter;
  private readonly inflight = new Map<string, Promise<StoredImage | undefined>>();
  private readonly now: () => number;

  constructor(options: BangumiImageServiceOptions) {
    this.store = BangumiImageStore.open(options.directory, { readOnly: true });
    this.sourceBase = (options.sourceBase ?? "").replace(/\/+$/, "");
    this.fetcher = options.fetcher ?? fetch;
    this.logger = options.logger;
    this.persist = options.persist;
    this.now = options.now ?? Date.now;
    this.limiter = new SlidingWindowRateLimiter({ windowMs: 60_000, maxRequests: options.upstreamPerMinute ?? 120 });
  }

  get available(): boolean {
    return this.store !== undefined;
  }

  /** 路由入口：缓存命中直接回；缺失才回源（带限速与在途合并）。 */
  async fetch(path: string): Promise<StoredImage | undefined> {
    const hit = this.store?.get(path);
    if (hit) return hit;
    if (!this.sourceBase) return undefined;
    const running = this.inflight.get(path);
    if (running) return running;
    if (!this.limiter.allow("upstream", this.now())) return undefined;
    const request = this.fetchUpstream(path).finally(() => this.inflight.delete(path));
    this.inflight.set(path, request);
    return request;
  }

  private async fetchUpstream(path: string): Promise<StoredImage | undefined> {
    try {
      const response = await this.fetcher(`${this.sourceBase}${path}`, {
        headers: { Accept: "image/avif", "User-Agent": "BakaGame/1.0" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) return undefined;
      const bytes = new Uint8Array(await response.arrayBuffer());
      // 只认 avif：上游异常时不要把 jpeg / 错误页写进库（坏字节一旦入库就不会再重下）。
      if (!hasAvifMagic(bytes)) return undefined;
      const image: StoredImage = { bytes, contentType: "image/avif" };
      this.persist?.(path, image);
      return image;
    } catch (error) {
      this.logger?.warn("图床回源失败", { path, error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  close(): void {
    this.store?.close();
  }
}
