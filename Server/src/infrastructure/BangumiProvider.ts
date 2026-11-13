import { AppError } from "../domain/Errors";
import { LRUCache } from "lru-cache";
import PQueue from "p-queue";
import { bangumiImageUrl } from "./BangumiImagePaths";
import { asArray, asRecord, readNumber, readString } from "./JsonReaders";
import { pickRandomSubject } from "./BangumiDataProvider";
import { extractBangumiMusicTracks, extractPerformers } from "./BangumiMusicParsing";
import type {
  AnimeAutoFilters,
  BangumiSubjectDetails,
  BangumiSubjectSearchResult,
} from "../shared/Index";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface BangumiProviderOptions {
  apiUrl: string;
  imageUrl?: string;
  fetcher?: Fetcher;
  now?: () => number;
  maxConcurrentRequests?: number;
  rateLimitCooldownMs?: number;
  cacheMaxEntries?: number;
  maxQueuedRequests?: number;
  /** 排队、请求与响应体读取共用截止预算。 */
  requestTimeoutMs?: number;
}

const SEARCH_TTL_MS = 6 * 60 * 60_000;
const SUBJECT_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_CACHE_MAX_ENTRIES = 512;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 3;
const DEFAULT_MAX_QUEUED_REQUESTS = 64;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 5_000;

const parseYear = (value: unknown) => {
  const match = readString(value)?.match(/\d{4}/);
  return match ? Number(match[0]) : undefined;
};

/**
 * 上游原始 URL → 对外 URL：镜像前缀 + 图床缓存路径（档位选定见 BangumiImagePaths，
 * 与构建脚本严格一致）。映射不了的形状退回「只换 host」的历史行为，交给图床路由的
 * 缺失回源兜底。
 */
export const rewriteBangumiImageUrl = (value: unknown, imageUrl = "") => {
  const raw = readString(value);
  if (!raw || !imageUrl) return raw;
  return bangumiImageUrl(raw, imageUrl) ?? raw;
};

const normalizeSubject = (
  raw: unknown,
  imageUrl: string
): BangumiSubjectSearchResult | undefined => {
  const item = asRecord(raw);
  const id = readString(item.id);
  const name = readString(item.name);
  if (!id || !name) return undefined;
  const images = asRecord(item.images);
  const tags = asArray(item.tags)
    .map((tag) => readString(asRecord(tag).name ?? tag))
    .filter((tag): tag is string => Boolean(tag));
  const metaTags = asArray(item.meta_tags)
    .map(readString)
    .filter((tag): tag is string => Boolean(tag));
  return {
    id,
    name,
    nameCn: readString(item.name_cn) ?? name,
    imageUrl: rewriteBangumiImageUrl(images.large, imageUrl),
    year: parseYear(item.date),
    rating: readNumber(asRecord(item.rating).score),
    ratingCount: readNumber(asRecord(item.rating).total),
    tags,
    metaTags,
  };
};

export class BangumiProvider {
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly imageUrl: string;
  private readonly apiUrl: string;
  private readonly cooldownMs: number;
  private readonly maxQueuedRequests: number;
  private readonly queue: PQueue;
  private readonly pendingRequests = new Map<number, AbortController>();
  private readonly requestTimeoutMs: number;
  private requestIdCounter = 0;
  private cooldownUntil = 0;
  /** 响应缓存：过期交给 lru-cache 原生 `ttl`，每个键按自己的时效写入。 */
  private readonly cache: LRUCache<string, { value: unknown }>;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  /** 角色立绘成功缓存。见 `resolveCharacterImage`：失败结果不得进入任何缓存。有界（LRU），否则长进程按累计角色数无上限增长。 */
  private readonly characterImageCache: LRUCache<number, string>;
  /** 作品封面成功缓存，口径与角色立绘一致：只缓存成功结果、有界。 */
  private readonly subjectImageCache: LRUCache<number, string>;

  constructor(options: BangumiProviderOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 10_000);
    this.now = options.now ?? (() => Date.now());
    this.apiUrl = options.apiUrl.replace(/\/+$/, "");
    this.imageUrl = options.imageUrl?.replace(/\/+$/, "") ?? "";
    this.cooldownMs = Math.max(500, options.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS);
    this.maxQueuedRequests = Math.max(1, options.maxQueuedRequests ?? DEFAULT_MAX_QUEUED_REQUESTS);
    this.cache = new LRUCache({
      max: Math.max(1, options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES),
      // 写入时必须带 ttl（见 `cached`）；这里给一个兜底值，防止漏传的键永不过期。
      ttl: SUBJECT_TTL_MS,
    });
    this.characterImageCache = new LRUCache({
      max: Math.max(1, options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES),
    });
    this.subjectImageCache = new LRUCache({
      max: Math.max(1, options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES),
    });
    this.queue = new PQueue({
      concurrency: Math.max(1, options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS),
    });
  }

  async searchSubjects(
    keyword: string,
    limit = 20,
    filters: AnimeAutoFilters = {}
  ): Promise<BangumiSubjectSearchResult[]> {
    const normalizedKeyword = keyword.trim();
    const payload = {
      keyword: normalizedKeyword,
      sort: "heat",
      filter: {
        type: [2],
        ...(filters.startYear || filters.endYear
          ? {
              air_date: [
                `>=${filters.startYear ?? 1900}-01-01`,
                `<${(filters.endYear ?? 2200) + 1}-01-01`,
              ],
            }
          : {}),
      },
    };
    const key = `search:${JSON.stringify(payload)}:${limit}`;
    return this.cached(key, SEARCH_TTL_MS, async () => {
      const body = await this.requestJson(
        `/v0/search/subjects?limit=${Math.min(50, Math.max(1, limit))}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(payload),
        }
      );
      return asArray(asRecord(body).data)
        .map((item) => normalizeSubject(item, this.imageUrl))
        .filter((item): item is BangumiSubjectSearchResult => Boolean(item))
        .slice(0, limit);
    });
  }

  async getSubject(subjectId: string): Promise<BangumiSubjectDetails> {
    const id = subjectId.trim();
    if (!id) throw new AppError("BANGUMI_SUBJECT_NOT_FOUND", "番剧条目不存在");
    return this.cached(`subject:${id}`, SUBJECT_TTL_MS, async () => {
      const [body, relationsBody] = await Promise.all([
        this.requestJson(`/v0/subjects/${encodeURIComponent(id)}`),
        this.requestJson(`/v0/subjects/${encodeURIComponent(id)}/subjects`).catch(() => []),
      ]);
      const subject = normalizeSubject(body, this.imageUrl);
      if (!subject) throw new AppError("BANGUMI_SUBJECT_NOT_FOUND", "番剧条目不存在");
      const performers = extractPerformers(asRecord(body).infobox);
      return {
        ...subject,
        summary: readString(asRecord(body).summary),
        locked: asRecord(body).locked === true,
        musicTracks: extractBangumiMusicTracks(asRecord(body).infobox, relationsBody, performers),
      };
    });
  }

  chooseRandomSubject(
    filters: AnimeAutoFilters = {},
    random = Math.random
  ): Promise<BangumiSubjectDetails> {
    return pickRandomSubject(this, filters, random);
  }

  /**
   * 角色立绘。只缓存**成功**结果，刻意不复用 `cached()`：它会把失败与空结果一并缓存 24 小时，
   * 一次瞬时故障就让该角色长期没有立绘（本地 provider 的历史实现踩过同一个坑）。
   */
  async resolveCharacterImage(characterId: number): Promise<string | undefined> {
    if (!Number.isInteger(characterId) || characterId <= 0) return undefined;
    const cachedImage = this.characterImageCache.get(characterId);
    if (cachedImage) return cachedImage;
    try {
      const body = asRecord(await this.requestJson(`/v0/characters/${characterId}`));
      const images = asRecord(body.images);
      const image = rewriteBangumiImageUrl(images.large, this.imageUrl);
      if (image) this.characterImageCache.set(characterId, image);
      return image;
    } catch {
      return undefined;
    }
  }

  /** 番剧封面：与角色立绘同一套回源与缓存口径，只缓存成功结果。 */
  async resolveSubjectImage(subjectId: string): Promise<string | undefined> {
    const id = Number(subjectId);
    if (!Number.isInteger(id) || id <= 0) return undefined;
    const cachedImage = this.subjectImageCache.get(id);
    if (cachedImage) return cachedImage;
    try {
      const body = asRecord(await this.requestJson(`/v0/subjects/${id}`));
      const images = asRecord(body.images);
      const image = rewriteBangumiImageUrl(images.large, this.imageUrl);
      if (image) this.subjectImageCache.set(id, image);
      return image;
    } catch {
      return undefined;
    }
  }

  private async cached<T>(key: string, ttl: number, loader: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit) return structuredClone(hit.value) as T;
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) return structuredClone(await existing);
    const request = loader()
      .then((value) => {
        const cachedValue = structuredClone(value);
        this.cache.set(key, { value: cachedValue }, { ttl });
        return cachedValue;
      })
      .finally(() => {
        if (this.inFlight.get(key) === request) this.inFlight.delete(key);
      });
    this.inFlight.set(key, request);
    return structuredClone(await request);
  }

  private async requestJson(path: string, init?: RequestInit): Promise<unknown> {
    return this.scheduleRequest(async (signal) => {
      try {
        const response = await this.fetcher(`${this.apiUrl}${path}`, { ...init, signal });
        if (response.status === 429) {
          this.enterRateLimitCooldown();
          throw this.rateLimitError();
        }
        if (!response.ok)
          throw new AppError("BANGUMI_UPSTREAM_ERROR", `Bangumi 请求失败（${response.status}）`);
        try {
          return await response.json();
        } catch {
          throw new AppError("BANGUMI_UPSTREAM_ERROR", "Bangumi 返回了无效数据");
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError("BANGUMI_UPSTREAM_ERROR", "Bangumi 请求失败", { cause: String(error) });
      }
    }, init?.signal);
  }

  private scheduleRequest<T>(
    task: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal | null
  ): Promise<T> {
    if (this.now() < this.cooldownUntil) return Promise.reject(this.rateLimitError());
    if (this.queue.size >= this.maxQueuedRequests)
      return Promise.reject(this.rateLimitError("Bangumi 请求排队过多，请稍后重试"));

    const id = ++this.requestIdCounter;
    const controller = new AbortController();
    const signal = callerSignal
      ? AbortSignal.any([controller.signal, callerSignal])
      : controller.signal;
    this.pendingRequests.set(id, controller);
    const timer = setTimeout(
      () => controller.abort(new AppError("BANGUMI_UPSTREAM_ERROR", "Bangumi 请求超时")),
      this.requestTimeoutMs
    );
    return (
      this.queue.add(
        async () => {
          this.pendingRequests.delete(id);
          if (this.now() < this.cooldownUntil) throw this.rateLimitError();
          return task(signal);
        },
        { signal }
      ) as Promise<T>
    ).finally(() => {
      clearTimeout(timer);
      this.pendingRequests.delete(id);
    });
  }

  private enterRateLimitCooldown() {
    this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + this.cooldownMs);
    const error = this.rateLimitError();
    for (const controller of this.pendingRequests.values()) controller.abort(error);
    this.pendingRequests.clear();
  }

  private rateLimitError(message = "Bangumi 请求过于频繁，请稍后重试") {
    return new AppError("BANGUMI_RATE_LIMITED", message, {
      retryAfterMs: Math.max(0, this.cooldownUntil - this.now()),
    });
  }
}
