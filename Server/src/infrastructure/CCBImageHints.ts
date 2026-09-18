import sharp from 'sharp';
import { LRUCache } from 'lru-cache';
import { AppError } from '../domain/Errors';
type ImageFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class CCBImageHints {
  private readonly cache = new LRUCache<string, string>({ max: 128, ttl: 60 * 60 * 1000 });
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly fetcher: ImageFetcher;
  constructor(options: { fetcher?: ImageFetcher } = {}) { this.fetcher = options.fetcher ?? fetch; }
  async render(imageUrl: string, level: number): Promise<string> {
    const normalized = Math.max(0, Math.min(100, Math.floor(level)));
    const key = `${imageUrl}:${normalized}`;
    const cached = this.cache.get(key); if (cached) return cached;
    const pending = this.inFlight.get(key); if (pending) return pending;
    const result = this.create(imageUrl, normalized).then(value => { this.cache.set(key, value); return value; })
      .catch((error: unknown) => {
        if (error instanceof AppError) throw error;
        throw new AppError('IMAGE_UNAVAILABLE', '暂时无法生成图片提示');
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, result); return result;
  }
  private async create(imageUrl: string, level: number): Promise<string> {
    const parsed = new URL(imageUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new AppError('IMAGE_UNAVAILABLE', '图片地址无效');
    const response = await this.fetcher(parsed, { signal: AbortSignal.timeout(10000) });
    if (!response.ok || !response.body) throw new AppError('IMAGE_UNAVAILABLE', '暂时无法读取图片提示');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new AppError('IMAGE_TOO_LARGE', '图片超过大小限制'); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    let pipeline = sharp(Buffer.concat(chunks), { limitInputPixels: 20_000_000 }).rotate().resize({ height: 200, width: 240, fit: 'inside', withoutEnlargement: true });
    if (level > 0) pipeline = pipeline.blur(Math.max(.3, level));
    const output = await pipeline.webp({ quality: 65 }).toBuffer();
    return `data:image/webp;base64,${output.toString('base64')}`;
  }
}
