import { LRUCache } from "lru-cache";

import { AppError } from "../../domain/Errors";
import { qlogoUrlOf } from "../../shared/Account";

export type AvatarSize = 100 | 640;

export interface AvatarImage {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  /** 字节摘要（截断 SHA-256），用作站内头像 URL 的版本号。 */
  hash: string;
}

/** 单张头像上限：qlogo 640 图通常几十 KB，超出视为异常响应。 */
const MAX_AVATAR_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 5_000;

const digest = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => {
  const buffer = await crypto.subtle.digest("SHA-256", bytes);
  return Buffer.from(buffer).toString("hex").slice(0, 16);
};

/**
 * QQ 头像抓取与内存缓存。
 *
 * 浏览器永远拿站内代理地址（只含用户 ID），qlogo 的 `nk=QQ号` 不出现在任何他人可见的响应里。
 * 缓存按「QQ 号 + 尺寸」存字节，总量封顶；过期后由下一次请求重新回源。
 */
export class QQAvatarService {
  private readonly cache = new LRUCache<string, AvatarImage>({
    maxSize: 32 * 1024 * 1024,
    sizeCalculation: (image) => image.bytes.byteLength || 1,
    ttl: 6 * 60 * 60 * 1000,
  });
  private readonly inFlight = new Map<string, Promise<AvatarImage>>();

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  /** 读缓存，未命中则回源；`fresh` 跳过缓存（头像刷新用）。 */
  async get(qqNumber: string, size: AvatarSize, fresh = false): Promise<AvatarImage> {
    const key = `${qqNumber}:${size}`;
    if (!fresh) {
      const cached = this.cache.get(key);
      if (cached) return cached;
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const request = this.download(qqNumber, size)
      .then((image) => { this.cache.set(key, image); return image; })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  private async download(qqNumber: string, size: AvatarSize): Promise<AvatarImage> {
    let response: Response;
    try {
      response = await this.fetcher(qlogoUrlOf(qqNumber, size), {
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      throw new AppError("AVATAR_UNAVAILABLE", "QQ 头像暂时无法获取", { cause: String(error) });
    }
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (!response.ok || !contentType.startsWith("image/")) {
      throw new AppError("AVATAR_UNAVAILABLE", "QQ 头像暂时无法获取", { status: response.status, contentType });
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_AVATAR_BYTES) throw new AppError("AVATAR_UNAVAILABLE", "QQ 头像过大");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_AVATAR_BYTES) {
      throw new AppError("AVATAR_UNAVAILABLE", "QQ 头像响应异常", { byteLength: bytes.byteLength });
    }
    return { bytes, contentType, hash: await digest(bytes) };
  }

  /** 头像刷新后丢弃其余尺寸的旧缓存。 */
  invalidate(qqNumber: string): void {
    for (const size of [100, 640] as const) this.cache.delete(`${qqNumber}:${size}`);
  }

  close(): void {
    this.cache.clear();
    this.inFlight.clear();
  }
}
