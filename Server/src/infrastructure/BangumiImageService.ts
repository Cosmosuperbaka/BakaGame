import { BangumiImageStore, type StoredImage } from "./BangumiImageStore";
import { BANGUMI_USER_AGENT } from "./BangumiUserAgent";
import { fetchWithGuardedRedirects } from "./OutboundGuard";
import { SlidingWindowRateLimiter, type RateLimitVerdict } from "./RateLimiter";

/**
 * 自建图床的读取侧（主线程）。路由请求先查分片缓存；缺失时按需回源抓一份
 * avif（`Accept: image/avif`，经反代），并交给数据 Worker 落库——维持
 * **单写者**原则：主线程只读分片、绝不直接写，写操作全部转给 Worker。
 *
 * 回源是尽力而为：抓取失败或上游给的不是 avif 都按「这张图暂时没有」处理，下一次请求或后台更新器会补。
 * 但**配额耗尽不能伪装成「没有这张图」**：那是调用方该退避的信号，混进 404 里就只能靠重试猜。
 * 双层配额（单客户端 + 全局）见 `BangumiImageServiceOptions`。
 */
export interface BangumiImageServiceOptions {
  directory: string;
  /** 回源前缀（Bangumi 镜像地址，如 `https://bangumi.example.com`）；为空则只读缓存、不回源。 */
  sourceBase?: string;
  fetcher?: typeof fetch;
  logger?: { warn: (message: string, context?: Record<string, unknown>) => void };
  /** 把新抓到的图转交数据 Worker 落库；失败只记警告（这张图下次再抓）。 */
  persist?: (path: string, image: StoredImage) => void;
  /** 全局每分钟最多回源多少张（默认 120）：上游侧总预算，与来者是谁无关。 */
  upstreamPerMinute?: number;
  /**
   * 单客户端每分钟最多回源多少张（默认 30）。
   * 只有全局预算时，一个客户端批量扫新路径就能在一分钟内吃光 120 张额度，
   * 之后所有人的首访都拿不到图——按来源地址再卡一层才谈得上公平。
   */
  perClientPerMinute?: number;
  now?: () => number;
}

/** 一次读取的三种结局：拿到图、确实没有、配额用完（最后一种必须让调用方退避）。 */
export type BangumiImageOutcome =
  | { state: "ok"; image: StoredImage }
  | { state: "missing" }
  | { state: "limited"; verdict: RateLimitVerdict };

const AVIF_MAGIC = "ftypav";

/** 与构建脚本同款校验：avif 魔数必须出现在前 16 字节内。 */
export function hasAvifMagic(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 16);
  for (let i = 0; i + AVIF_MAGIC.length <= head.length; i += 1) {
    let hit = true;
    for (let j = 0; j < AVIF_MAGIC.length; j += 1) {
      if (head[i + j] !== AVIF_MAGIC.charCodeAt(j)) {
        hit = false;
        break;
      }
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
  private readonly globalLimiter: SlidingWindowRateLimiter;
  private readonly clientLimiter: SlidingWindowRateLimiter;
  private readonly inflight = new Map<string, Promise<BangumiImageOutcome>>();
  private readonly now: () => number;

  constructor(options: BangumiImageServiceOptions) {
    this.store = BangumiImageStore.open(options.directory, { readOnly: true });
    this.sourceBase = (options.sourceBase ?? "").replace(/\/+$/, "");
    this.fetcher = options.fetcher ?? fetch;
    this.logger = options.logger;
    this.persist = options.persist;
    this.now = options.now ?? Date.now;
    this.globalLimiter = new SlidingWindowRateLimiter({
      windowMs: 60_000,
      maxRequests: options.upstreamPerMinute ?? 120,
    });
    this.clientLimiter = new SlidingWindowRateLimiter({
      windowMs: 60_000,
      maxRequests: options.perClientPerMinute ?? 30,
    });
  }

  get available(): boolean {
    return this.store !== undefined;
  }

  /**
   * 路由入口：缓存命中直接回；缺失才回源（带双层限速与在途合并）。
   *
   * 先扣单客户端额度再扣全局额度：反过来会让一个滥用者把共享预算连本带利吃掉，
   * 而它的请求根本不该进入全局计数。在途合并的后续请求不重复占额度。
   */
  async fetch(path: string, clientIp = "anonymous"): Promise<BangumiImageOutcome> {
    const hit = this.store?.get(path);
    if (hit) return { state: "ok", image: hit };
    if (!this.sourceBase) return { state: "missing" };
    const running = this.inflight.get(path);
    if (running) return running;
    const verdict = this.clientLimiter.consume(clientIp, this.now());
    if (!verdict.allowed) return { state: "limited", verdict };
    const global = this.globalLimiter.consume("upstream", this.now());
    if (!global.allowed) return { state: "limited", verdict: global };
    const request = this.fetchUpstream(path)
      .then((image): BangumiImageOutcome => (image ? { state: "ok", image } : { state: "missing" }))
      .finally(() => this.inflight.delete(path));
    this.inflight.set(path, request);
    return request;
  }

  private async fetchUpstream(path: string): Promise<StoredImage | undefined> {
    try {
      const response = await fetchWithGuardedRedirects(
        this.fetcher,
        `${this.sourceBase}${path}`,
        {
          headers: { Accept: "image/avif", "User-Agent": BANGUMI_USER_AGENT },
          signal: AbortSignal.timeout(8_000),
        },
        { pinOrigin: true }
      );
      if (!response.ok) return undefined;
      const bytes = new Uint8Array(await response.arrayBuffer());
      // 只认 avif：上游异常时不要把 jpeg / 错误页写进库（坏字节一旦入库就不会再重下）。
      if (!hasAvifMagic(bytes)) return undefined;
      const image: StoredImage = { bytes, contentType: "image/avif" };
      this.persist?.(path, image);
      return image;
    } catch (error) {
      this.logger?.warn("图床回源失败", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  close(): void {
    this.store?.close();
  }
}
