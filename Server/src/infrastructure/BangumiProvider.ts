import { AppError } from "../domain/Errors";
import type {
  AnimeAutoFilters,
  BangumiMusicTrack,
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
}

const SEARCH_TTL_MS = 6 * 60 * 60_000;
const SUBJECT_TTL_MS = 24 * 60 * 60_000;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const readString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim()
    ? value.trim()
    : typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : undefined;
const readNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const parseYear = (value: unknown) => {
  const match = readString(value)?.match(/\d{4}/);
  return match ? Number(match[0]) : undefined;
};

const normalizeKind = (key: string): BangumiMusicTrack["kind"] => {
  if (/片头|片頭|opening|\bop\b/i.test(key)) return "opening";
  if (/片尾|片尾|ending|\bed\b/i.test(key)) return "ending";
  if (/插入|insert/i.test(key)) return "insert";
  return "theme";
};

const parseTrackText = (value: string, kind: BangumiMusicTrack["kind"]): BangumiMusicTrack[] => {
  const result: BangumiMusicTrack[] = [];
  for (const item of value.split(/[\r\n]+|[；;]+/)) {
    const text = item.replace(/^\s*[（(【\[]?(?:OP|ED|片头曲|片尾曲|插入曲|主题歌)[^：:：-]*[:：-]?\s*/i, "").trim();
    if (!text || text.length < 2 || text.length > 200) continue;
    const parts = text.split(/\s+[-－—]\s+|\s+\/\s+/).map((part) => part.trim()).filter(Boolean);
    const title = parts[0];
    if (!title) continue;
    result.push({ title, artist: parts[1], kind });
  }
  return result;
};

const extractTracks = (infobox: unknown): BangumiMusicTrack[] => {
  const tracks: BangumiMusicTrack[] = [];
  for (const entry of asArray(infobox)) {
    const record = asRecord(entry);
    const key = readString(record.key ?? record.name) ?? "";
    if (!/(主题歌|片头|片尾|插入曲|opening|ending|insert|\bop\b|\bed\b)/i.test(key)) continue;
    const kind = normalizeKind(key);
    const values = asArray(record.value);
    if (values.length === 0) {
      const text = readString(record.value);
      if (text) tracks.push(...parseTrackText(text, kind));
      continue;
    }
    for (const value of values) {
      if (typeof value === "string") tracks.push(...parseTrackText(value, kind));
      else {
        const item = asRecord(value);
        const title = readString(item.v ?? item.value ?? item.title ?? item.name);
        if (title) tracks.push({ title, artist: readString(item.k ?? item.artist), kind });
      }
    }
  }
  const seen = new Set<string>();
  return tracks.filter((track) => {
    const key = `${track.kind}:${track.title.toLowerCase()}:${track.artist?.toLowerCase() ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const rewriteBangumiImageUrl = (value: unknown, imageUrl = "") => {
  const raw = readString(value);
  if (!raw || !imageUrl) return raw;
  try {
    const source = new URL(raw);
    if (source.hostname !== "lain.bgm.tv") return raw;
    const prefix = imageUrl.replace(/\/+$/, "");
    return `${prefix}${source.pathname}${source.search}${source.hash}`;
  } catch {
    return raw;
  }
};

const normalizeSubject = (raw: unknown, imageUrl: string): BangumiSubjectSearchResult | undefined => {
  const item = asRecord(raw);
  const id = readString(item.id);
  const name = readString(item.name);
  if (!id || !name) return undefined;
  const images = asRecord(item.images);
  const tags = asArray(item.tags).map((tag) => readString(asRecord(tag).name ?? tag)).filter((tag): tag is string => Boolean(tag));
  const metaTags = asArray(item.meta_tags).map(readString).filter((tag): tag is string => Boolean(tag));
  return {
    id,
    name,
    nameCn: readString(item.name_cn) ?? name,
    imageUrl: rewriteBangumiImageUrl(images.medium ?? images.large ?? images.common ?? images.grid, imageUrl),
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
  private readonly maxConcurrent: number;
  private readonly cooldownMs: number;
  private activeRequests = 0;
  private cooldownUntil = 0;
  private readonly cache = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(options: BangumiProviderOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.apiUrl = options.apiUrl.replace(/\/+$/, "");
    this.imageUrl = options.imageUrl?.replace(/\/+$/, "") ?? "";
    this.maxConcurrent = Math.max(1, options.maxConcurrentRequests ?? 3);
    this.cooldownMs = Math.max(500, options.rateLimitCooldownMs ?? 5_000);
  }

  async searchSubjects(keyword: string, limit = 20, filters: AnimeAutoFilters = {}): Promise<BangumiSubjectSearchResult[]> {
    const normalizedKeyword = keyword.trim();
    const payload = {
      keyword: normalizedKeyword,
      sort: "heat",
      filter: {
        type: [2],
        ...(filters.startYear || filters.endYear ? { air_date: [`>=${filters.startYear ?? 1900}-01-01`, `<${(filters.endYear ?? 2200) + 1}-01-01`] } : {}),
        ...(filters.minRating !== undefined ? { rating: [`>=${filters.minRating}`] } : {}),
        ...(filters.tags?.length ? { tag: filters.tags } : {}),
        ...(filters.metaTags?.length ? { meta_tags: filters.metaTags } : {}),
        ...(filters.catalogIds?.length ? { catalog: filters.catalogIds } : {}),
      },
    };
    const key = `search:${JSON.stringify(payload)}:${limit}`;
    return this.cached(key, SEARCH_TTL_MS, async () => {
      const body = await this.requestJson(`/v0/search/subjects?limit=${Math.min(50, Math.max(1, limit))}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
      });
      return asArray(asRecord(body).data)
        .map((item) => normalizeSubject(item, this.imageUrl))
        .filter((item): item is BangumiSubjectSearchResult => Boolean(item))
        .filter((item) => item.rating === undefined || item.rating >= (filters.minRating ?? 0))
        .filter((item) => item.ratingCount === undefined || item.ratingCount >= (filters.minRatingCount ?? 0))
        .slice(0, limit);
    });
  }

  async getSubject(subjectId: string): Promise<BangumiSubjectDetails> {
    const id = subjectId.trim();
    if (!id) throw new AppError("BANGUMI_SUBJECT_NOT_FOUND", "番剧条目不存在");
    return this.cached(`subject:${id}`, SUBJECT_TTL_MS, async () => {
      const body = await this.requestJson(`/v0/subjects/${encodeURIComponent(id)}`);
      const subject = normalizeSubject(body, this.imageUrl);
      if (!subject) throw new AppError("BANGUMI_SUBJECT_NOT_FOUND", "番剧条目不存在");
      return {
        ...subject,
        summary: readString(asRecord(body).summary),
        locked: asRecord(body).locked === true,
        musicTracks: extractTracks(asRecord(body).infobox),
      };
    });
  }

  async chooseRandomSubject(filters: AnimeAutoFilters = {}, random = Math.random): Promise<BangumiSubjectDetails> {
    const subjectIds = filters.subjectIds?.filter(Boolean) ?? [];
    let candidates: BangumiSubjectSearchResult[];
    if (subjectIds.length > 0) {
      candidates = await Promise.all(subjectIds.map((id) => this.getSubject(id))).then((items) => items);
    } else {
      const result = await this.searchSubjects("", Math.min(filters.topN ?? 50, 50), filters);
      candidates = result;
    }
    if (candidates.length === 0) throw new AppError("BANGUMI_NO_SUBJECT", "选不到符合条件的番剧");
    const selected = candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))];
    return this.getSubject(selected.id);
  }

  private async cached<T>(key: string, ttl: number, loader: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > this.now()) return structuredClone(hit.value) as T;
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const request = loader().then((value) => {
      this.cache.set(key, { value: structuredClone(value), expiresAt: this.now() + ttl });
      return value;
    }).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  private async requestJson(path: string, init?: RequestInit): Promise<unknown> {
    while (this.activeRequests >= this.maxConcurrent || this.now() < this.cooldownUntil) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    this.activeRequests += 1;
    try {
      const response = await this.fetcher(`${this.apiUrl}${path}`, init);
      if (response.status === 429) {
        this.cooldownUntil = this.now() + this.cooldownMs;
        throw new AppError("BANGUMI_RATE_LIMITED", "Bangumi 请求过于频繁，请稍后重试");
      }
      if (!response.ok) throw new AppError("BANGUMI_UPSTREAM_ERROR", `Bangumi 请求失败（${response.status}）`);
      try {
        return await response.json();
      } catch {
        throw new AppError("BANGUMI_UPSTREAM_ERROR", "Bangumi 返回了无效数据");
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("BANGUMI_UPSTREAM_ERROR", "Bangumi 请求失败", { cause: String(error) });
    } finally {
      this.activeRequests -= 1;
    }
  }
}

export const extractBangumiMusicTracks = extractTracks;
