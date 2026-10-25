import PQueue from "p-queue";
import { describeError, type EventLogger } from "./EventLogger";
import { parseTTML } from "./LyricLines";
import { asRecord } from "./JsonReaders";
import type { MusicCache } from "./MusicCache";

export interface AmllLyricClientOptions {
  /** 按 ID 取正文的查询参数名：网易云 `ncmMusicId`、QQ 音乐 `qqMusicId`。 */
  idQueryParam: string;
  /** 歌词结果的缓存软 TTL（硬过期为 3 倍，见 `MusicCache`）。 */
  cacheTtlMs: number;
  /** 缓存实例由调用方注入：网易云共享 provider 缓存，QQ 音乐用独立缓存。 */
  cache: MusicCache;
  logger?: EventLogger;
  /** AMLL 独立于各平台风控队列的并发上限。 */
  maxConcurrentRequests?: number;
  /** AMLL 等待队列容量；超过后当次降级，不无限堆积。 */
  maxQueuedRequests?: number;
  /** 单次 AMLL 请求（含排队等待）的上界。 */
  requestTimeoutMs?: number;
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  /** 自定义按 ID 取正文（单元测试注入用）。 */
  fetchById?: (id: string) => Promise<string | undefined>;
  /** 自定义按歌名检索（单元测试注入用）。 */
  fetchBySearch?: (songName: string, artistName?: string) => Promise<string | undefined>;
}

/**
 * AMLL 官方 TTML 歌词库（api.amll.dev）的平台中立客户端：排队、超时、预算与
 * 「确定缺失缓存 / 瞬态失败不缓存」的边界都在这里收口，网易云与 QQ 音乐的 provider
 * 只负责把各自平台的歌曲 ID 形态与缓存实例注入进来。
 */
export class AmllLyricClient {
  private readonly options: AmllLyricClientOptions;
  private readonly queue: PQueue;
  private readonly maxQueuedRequests: number;
  private readonly requestTimeoutMs: number;

  constructor(options: AmllLyricClientOptions) {
    this.options = options;
    this.queue = new PQueue({
      concurrency: Math.max(1, options.maxConcurrentRequests ?? 3),
    });
    this.maxQueuedRequests = options.maxQueuedRequests ?? 64;
    this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 3_000);
  }

  async getTtmlLyrics(id: string, context: Record<string, string>): Promise<string | undefined> {
    return this.load(`amll:${id}`, context, async (signal) => {
      if (this.options.fetchById) return this.options.fetchById(id);
      const json = await this.requestJson(
        `get?${this.options.idQueryParam}=${encodeURIComponent(id)}`,
        signal
      );
      return this.readLyrics(json);
    });
  }

  async searchTtmlLyrics(
    songName: string,
    artistName: string | undefined,
    context: Record<string, string>
  ): Promise<string | undefined> {
    const title = songName.trim();
    if (!title) return undefined;
    return this.load(`amll-search:${title}:${artistName ?? ""}`, context, async (signal) => {
      if (this.options.fetchBySearch) return this.options.fetchBySearch(title, artistName);
      const query = artistName ? `${title} ${artistName}` : title;
      const json = await this.requestJson(
        `search?q=${encodeURIComponent(query)}&pageSize=5`,
        signal
      );
      if (!json) return undefined;
      const items = asRecord(json.data).items;
      if (!Array.isArray(items)) throw new Error("AMLL 搜索响应无效");
      if (!items.length) return undefined;
      const id = asRecord(items[0]).id;
      if (typeof id !== "string" && typeof id !== "number") throw new Error("AMLL 搜索条目无效");
      return this.readLyrics(
        await this.requestJson(`get?id=${encodeURIComponent(String(id))}`, signal)
      );
    });
  }

  private async load(
    key: string,
    context: Record<string, string>,
    loader: (signal: AbortSignal) => Promise<string | undefined>
  ): Promise<string | undefined> {
    try {
      // 瞬态失败 reject cached loader，当次降级但不固化为空；只有确定缺失缓存 undefined。
      return await this.options.cache.cached(key, this.options.cacheTtlMs, async () => {
        if (this.queue.size >= this.maxQueuedRequests) throw new Error("AMLL 请求排队过多");
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(new Error("AMLL 请求超时")),
          this.requestTimeoutMs
        );
        try {
          return await this.queue.add(
            async () => {
              const lyrics = await loader(controller.signal);
              controller.signal.throwIfAborted();
              if (lyrics !== undefined && !parseTTML(lyrics).length)
                throw new Error("AMLL TTML 歌词无效");
              return lyrics;
            },
            { signal: controller.signal }
          );
        } finally {
          clearTimeout(timer);
        }
      });
    } catch (error) {
      this.options.logger?.warn?.("获取 AMLL 歌词失败", { ...context, ...describeError(error) });
      return undefined;
    }
  }

  private async requestJson(
    path: string,
    signal: AbortSignal
  ): Promise<Record<string, unknown> | undefined> {
    const response = await (this.options.fetcher ?? fetch)(
      `https://api.amll.dev/v1/lyrics/${path}`,
      {
        signal,
        headers: { "User-Agent": "BakaGame-Songuessr/1.0" },
      }
    );
    signal.throwIfAborted();
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`AMLL 请求失败（${response.status}）`);
    const json = asRecord(await response.json());
    signal.throwIfAborted();
    if (json.status === 404) return undefined;
    if (json.status !== 200) throw new Error("AMLL 返回无效状态");
    return json;
  }

  private readLyrics(json: Record<string, unknown> | undefined): string | undefined {
    if (!json) return undefined;
    // QQ 音乐早期响应把 lyrics 放在顶层；网易云固定在 data 下，两者都认。
    const lyrics = asRecord(json.data).lyrics ?? json.lyrics;
    if (typeof lyrics !== "string") throw new Error("AMLL 返回无效歌词");
    if (!lyrics.trim()) throw new Error("AMLL 返回空歌词");
    return lyrics.trim();
  }
}
