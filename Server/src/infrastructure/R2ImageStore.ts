import type { ImageStore, StoredImage } from "./BangumiImageStore";

/**
 * 图床的 R2 后端。**写入侧**：新图直接进 Cloudflare R2，本地 SQLite 只留一条
 * 「这张图在 R2」的索引，不再存字节；**读取侧**由路由 302 到 CDN（见
 * `BakaGameImageService` 的 `cdnBase`）。
 *
 * 为什么不上 S3 SDK：`*.r2.cloudflarestorage.com` 在境内网络被 TLS 层阻断
 * （ClientHello 阶段 reset，本机与腾讯云都复现），SigV4 那条路走不通。Cloudflare
 * 的 REST API（`api.cloudflare.com`）境内可达，且同样支持对象 PUT，所以这里用
 * Bearer Token 直传，不引任何 SDK。
 *
 * 上传失败**不吞掉**：抛给调用方（Worker 的 `images.put`、更新器的 `ensureImage`），
 * 由它们决定重试或跳过。吞掉会让索引与 R2 不一致——路由 302 过去就是 404 裂图。
 */
export interface R2Config {
  accountId: string;
  apiToken: string;
  bucket: string;
}

/** 对象路径与线上一致：桶内前缀 `bangumi` + 源站路径（`/r/200/...`）。 */
const KEY_PREFIX = "bangumi";

/**
 * 路径即内容，可以放心长缓存。**上限受 int32 约束**：EdgeOne 的 `X-Swift-CacheTime`
 * 按有符号 32 位存秒数，写 100 年（3,153,600,000）会回绕成 -1,141,367,296，
 * 表现为「永远已过期」，每个请求都回源。1 年（或任何 < 2,147,483,647 的值）安全。
 */
const CACHE_CONTROL = "public, max-age=31536000, immutable";

export class R2ImageUploader {
  private readonly endpoint: string;
  private readonly apiToken: string;

  constructor(config: R2Config) {
    this.endpoint =
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}` +
      `/r2/buckets/${config.bucket}/objects`;
    this.apiToken = config.apiToken;
  }

  async put(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const key = `${KEY_PREFIX}${path}`;
    const encoded = key.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(`${this.endpoint}/${encoded}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${this.apiToken}`,
        "content-type": contentType,
        "cache-control": CACHE_CONTROL,
      },
      // 运行时是 Bun（Uint8Array 可直接作为 body），DOM 的类型定义只认 ArrayBuffer 视图。
      body: bytes as unknown as BodyInit,
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok) return;
    const detail = await response.text().catch(() => "");
    throw new Error(`R2 写入失败 ${response.status}: ${detail.slice(0, 200)}`);
  }
}

/**
 * 以本地分片作索引、R2 作字节存储的组合。
 *
 * 索引不是可有可无的：路由要先知道「这张图存在」才能 302，否则每次请求都得先
 * 问 R2（HEAD 跨洋 ~400ms），等于把 CDN 的意义抹掉。索引只存 path，一条几十字节。
 */
export class R2ImageStore implements ImageStore {
  constructor(
    private readonly index: ImageStore,
    private readonly uploader: R2ImageUploader
  ) {}

  get shardCount(): number {
    return this.index.shardCount;
  }

  has(path: string): boolean {
    return this.index.has(path);
  }

  isRemote(path: string): boolean {
    return this.index.isRemote(path);
  }

  markRemote(path: string, contentType?: string): void {
    this.index.markRemote(path, contentType);
  }

  get(path: string): StoredImage | undefined {
    return this.index.get(path);
  }

  /** 先写 R2，成功了才落索引——顺序反了会留下「索引说有、R2 没有」的裂图。 */
  async put(path: string, bytes: Uint8Array, contentType = "image/avif"): Promise<void> {
    await this.uploader.put(path, bytes, contentType);
    this.index.markRemote(path, contentType);
  }

  count(): number {
    return this.index.count();
  }

  close(): void {
    this.index.close();
  }
}
