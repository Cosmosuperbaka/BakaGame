import sharp from 'sharp';
import PQueue from 'p-queue';
import { LRUCache } from 'lru-cache';
import { AppError } from '../domain/Errors';
type ImageFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class CCBImageHints {
  private readonly cache = new LRUCache<string, string>({ max: 128, maxSize: 16 * 1024 * 1024, sizeCalculation: value => value.length * 2, ttl: 60 * 60 * 1000 });
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly fetcher: ImageFetcher;
  private readonly queue: PQueue;
  private readonly maxQueuedRequests: number;
  private readonly requestTimeoutMs: number;
  constructor(options: { fetcher?: ImageFetcher; maxConcurrentRequests?: number; maxQueuedRequests?: number; requestTimeoutMs?: number } = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.queue = new PQueue({ concurrency: Math.max(1, options.maxConcurrentRequests ?? 2) });
    this.maxQueuedRequests = Math.max(1, options.maxQueuedRequests ?? 32);
    this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 10_000);
  }
  async render(imageUrl: string, level: number): Promise<string> {
    const normalized = Math.max(0, Math.min(100, Math.floor(level)));
    const key = `${imageUrl}:${normalized}`;
    const cached = this.cache.get(key); if (cached) return cached;
    const pending = this.inFlight.get(key); if (pending) return pending;
    if (this.queue.size >= this.maxQueuedRequests) throw new AppError('IMAGE_UNAVAILABLE', '图片提示请求排队过多');
    const deadline = Date.now() + this.requestTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new AppError('IMAGE_UNAVAILABLE', '图片提示请求超时')), this.requestTimeoutMs);
    const result = (this.queue.add(() => this.create(imageUrl, normalized, controller.signal, deadline), { signal: controller.signal }) as Promise<string>).then(value => { this.cache.set(key, value); return value; })
      .catch((error: unknown) => {
        if (error instanceof AppError) throw error;
        throw new AppError('IMAGE_UNAVAILABLE', '暂时无法生成图片提示');
      })
      .finally(() => { clearTimeout(timer); this.inFlight.delete(key); });
    this.inFlight.set(key, result); return result;
  }
  private async create(imageUrl: string, level: number, signal: AbortSignal, deadline: number): Promise<string> {
    const parsed = new URL(imageUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new AppError('IMAGE_UNAVAILABLE', '图片地址无效');
    const response = await this.fetcher(parsed, { signal });
    signal.throwIfAborted();
    if (!response.ok || !response.body) throw new AppError('IMAGE_UNAVAILABLE', '暂时无法读取图片提示');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    const cancelRead = () => { void reader.cancel(signal.reason).catch(() => {}); };
    signal.addEventListener('abort', cancelRead, { once: true });
    try {
      for (;;) {
        const chunk = await reader.read(); signal.throwIfAborted(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new AppError('IMAGE_TOO_LARGE', '图片超过大小限制'); }
        chunks.push(chunk.value);
      }
    } finally { signal.removeEventListener('abort', cancelRead); reader.releaseLock(); }
    let pipeline = sharp(Buffer.concat(chunks), { limitInputPixels: 20_000_000 }).timeout({ seconds: Math.max(1, Math.ceil((deadline - Date.now()) / 1000)) }).rotate().resize({ height: 200, width: 240, fit: 'inside', withoutEnlargement: true });
    if (level > 0) pipeline = pipeline.blur(Math.max(.3, level));
    signal.throwIfAborted();
    const cancelDecode = () => { pipeline.destroy(); };
    signal.addEventListener('abort', cancelDecode, { once: true });
    let output: Buffer;
    try { output = await pipeline.webp({ quality: 65 }).toBuffer(); }
    finally { signal.removeEventListener('abort', cancelDecode); }
    signal.throwIfAborted();
    return `data:image/webp;base64,${output.toString('base64')}`;
  }
}
