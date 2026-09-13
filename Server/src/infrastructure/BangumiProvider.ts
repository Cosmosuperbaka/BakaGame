import { AppError } from "../domain/Errors";
import { LRUCache } from "lru-cache";
import PQueue from "p-queue";
import { isBangumiCreditsEntry } from "../shared/Index";
import type {
  AnimeAutoFilters,
  BangumiMusicTrack,
  BangumiMusicTrackKind,
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
}

const SEARCH_TTL_MS = 6 * 60 * 60_000;
const SUBJECT_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_CACHE_MAX_ENTRIES = 512;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 3;
const DEFAULT_MAX_QUEUED_REQUESTS = 64;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 5_000;

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

const STAFF_KEY_PATTERN =
  /分[镜鏡]|演出|作画|動画|动画|制作|製作|设定|設定|设计|設計|监[督修]|企画|企划|录音|録音|混音|音效|音响|音響|选曲|選曲|协助|協力|协力|角色[设設]|主要角色|CAST|STAFF|作[词詞]|作曲|编曲|編曲|制作人|制片人/i;

const KIND_PRIORITY: Record<BangumiMusicTrackKind, number> = {
  opening: 1,
  ending: 2,
  insert: 3,
  theme: 4,
  character: 5,
  ost: 6,
  single: 7,
  collection: 8,
  remix: 9,
  image: 10,
  doujin: 11,
  vocal: 12,
  vocaloid: 13,
  arrange: 14,
  artistAlbum: 15,
  drama: 16,
  radio: 17,
  reading: 18,
};

const VERSION_MARKER_PATTERN =
  /(?:伴奏|纯音乐|电视尺寸|动画剪辑|\b(?:inst(?:rumental)?\.?|off\s*vocal|karaoke|tv\s*size|anime\s*edit|radio\s*edit|ver(?:sion)?\.?|version|mix|edit|remaster(?:ed)?|live|acoustic|demo|cover|remix|feat(?:uring)?\.?)\b)/iu;
const BRACKETED_VERSION_PATTERN = /\s*[（(【[]\s*([^）)】\]]*)\s*[）)】\]]/gu;
const DECORATED_VERSION_SUFFIX_PATTERN = /\s*[-~～–—]+\s*(.*?)\s*(?:[-~～–—]+\s*)?$/u;
const BARE_VERSION_SUFFIX_PATTERN =
  /\s+(?:inst(?:rumental)?\.?|off\s*vocal|karaoke|伴奏|纯音乐|电视尺寸|动画剪辑|tv\s*size|anime\s*edit|radio\s*edit|remix|(?:[^\s]+\s+)?ver(?:sion)?\.?)\s*$/iu;
const FEAT_SUFFIX_PATTERN = /\s*(?:[（(【[]\s*)?feat(?:uring)?\.?\s*[^）)】\]]+[）)】\]]?\s*$/iu;

const stripTrackVersion = (value: string) => {
  let result = value.replace(
    BRACKETED_VERSION_PATTERN,
    (match, metadata: string) => VERSION_MARKER_PATTERN.test(metadata) ? "" : match,
  );
  while (true) {
    const next = result
      .replace(
        DECORATED_VERSION_SUFFIX_PATTERN,
        (match, metadata: string) => VERSION_MARKER_PATTERN.test(metadata) ? "" : match,
      )
      .replace(BARE_VERSION_SUFFIX_PATTERN, "")
      .replace(FEAT_SUFFIX_PATTERN, "");
    if (next === result) return result;
    result = next;
  }
};

const extractPerformers = (infobox: unknown): string[] => {
  const artists: string[] = [];
  for (const entry of asArray(infobox)) {
    const record = asRecord(entry);
    const key = readString(record.key ?? record.name) ?? "";
    if (!/演出/.test(key) || !/歌|曲|主题|插入/.test(key)) continue;
    const text = readString(record.value);
    const values = asArray(record.value);
    const rawList = text ? [text] : values.map((v) => typeof v === "string" ? v : readString(asRecord(v).v ?? asRecord(v).value)).filter(Boolean) as string[];
    for (const raw of rawList) {
      for (const item of raw.split(/[\r\n/／；;,，]+/)) {
        const cleaned = item
          .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, "")
          .trim();
        if (cleaned && cleaned.length >= 2 && cleaned.length <= 50 && !/^(?:OP|ED|IN|TM)\d*$/i.test(cleaned)) {
          artists.push(cleaned);
        }
      }
    }
  }
  return [...new Set(artists)];
};

const extractRelatedMusicTracks = (
  relations: unknown,
  performers: string[] = [],
): BangumiMusicTrack[] => {
  const tracks: BangumiMusicTrack[] = [];
  for (const item of asArray(relations)) {
    const record = asRecord(item);
    if (record.type !== 3) continue;
    const relation = readString(record.relation) ?? "";
    const rawName = readString(record.name) ?? "";
    if (!rawName) continue;
    // 版权署名 / 制作委员会伪条目不是歌曲，混进曲目池会被当成 OP 拿去联网搜歌。
    if (isBangumiCreditsEntry(rawName)) continue;

    let kind = normalizeKind(relation);
    if (kind === "theme" && relation === "其他") {
      if (/原声|soundtrack|\bost\b/i.test(rawName)) kind = "ost";
      else if (/remix|重混/i.test(rawName)) kind = "remix";
      else if (/drama|广播剧|ドラマ/i.test(rawName)) kind = "drama";
    }

    const quoteMatches = [...rawName.matchAll(/「([^」]+)」/g)].map((m) => m[1].trim()).filter(Boolean);
    const subTitle = quoteMatches.length > 0 ? quoteMatches.at(-1) : undefined;
    let artist: string | undefined;
    if (quoteMatches.length > 0) {
      let remaining = rawName;
      for (const q of quoteMatches) {
        remaining = remaining.replace(`「${q}」`, "");
      }
      remaining = remaining.replace(/TVアニメ|キャラクターソング|イメージソング|[「」]/gi, "").trim();
      const artistMatch = remaining.match(/[/／]\s*(.+)$/) || remaining.match(/^(.+?)\s*[/／]/);
      if (artistMatch) artist = artistMatch[1].trim();
      else if (remaining.length >= 2 && remaining.length <= 20) artist = remaining;
    }
    if (!artist && performers.length === 1) {
      artist = performers[0];
    }

    if (subTitle && subTitle.length >= 2) {
      tracks.push({ title: subTitle, artist, kind });
    }

    const stripped = stripTrackVersion(rawName).trim();
    if (stripped && stripped !== rawName && stripped.length >= 2) {
      tracks.push({ title: stripped, artist, kind });
    }

    const splitCandidates = rawName
      .split(/\s*[\/／]\s*/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2 && !/^(?:instrumental|off\s*vocal|tv\s*size|ver(?:sion)?)$/i.test(s));

    if (splitCandidates.length > 1) {
      for (const part of splitCandidates) {
        if (artist && part.toLowerCase() === artist.toLowerCase()) continue;
        const cleanPart = stripTrackVersion(part).trim();
        if (cleanPart.length >= 2) {
          tracks.push({ title: cleanPart, artist, kind });
        }
      }
    }

    tracks.push({ title: rawName, artist, kind });
  }
  return tracks;
};

const normalizeKind = (key: string): BangumiMusicTrackKind => {
  const normalized = key.trim();
  if (/片头|片頭|opening|\bop\d*\b/i.test(normalized)) return "opening";
  if (/片尾|ending|\bed\d*\b/i.test(normalized)) return "ending";
  if (/插[入]?[曲歌]|insert|\bin\d*\b/i.test(normalized)) return "insert";
  if (/原声|soundtrack|\bost\b/i.test(normalized)) return "ost";
  if (/角色[歌曲]|character(?:\s*song)?/i.test(normalized)) return "character";
  if (/\bremix\b|重混/i.test(normalized)) return "remix";
  if (/同人/i.test(normalized)) return "doujin";
  if (/印象[曲歌]|image(?:\s*song)?/i.test(normalized)) return "image";
  if (/vocaloid/i.test(normalized)) return "vocaloid";
  if (/\bdrama\b|广播剧|廣播劇/i.test(normalized)) return "drama";
  if (/\bvocal\b/i.test(normalized)) return "vocal";
  if (/\bradio\b|广播|廣播/i.test(normalized)) return "radio";
  if (/\barrange\b|改编|改編|编曲|編曲/i.test(normalized)) return "arrange";
  if (/单曲|單曲|\bsingle\b/i.test(normalized)) return "single";
  if (/精选|精選|\bbest\b|collection/i.test(normalized)) return "collection";
  if (/朗读|朗讀/i.test(normalized)) return "reading";
  if (/艺人|藝人|album/i.test(normalized)) return "artistAlbum";
  if (/主题|主題|theme|\btm\d*\b/i.test(normalized)) return "theme";
  return "theme";
};

const LINE_PREFIX_REGEX =
  /^\s*[（(【\[]?(?:(OP\d*|ED\d*|IN\d*|TM\d*|片头曲\d*|片尾曲\d*|插入曲\d*|插曲\d*|主题歌\d*|主题曲\d*|OST|Remix|重混|角色[歌曲]\d*|同人音乐|印象曲|Vocaloid|Drama|VOCAL|Radio|Arrange|单曲|精选集|朗读剧|艺人专辑|Soundtrack|Character(?:\s*Song)?|Image(?:\s*Song)?))[^：:：-]*[:：-]?\s*/i;

const parseTrackText = (value: string, fallbackKind: BangumiMusicTrackKind): BangumiMusicTrack[] => {
  const result: BangumiMusicTrack[] = [];
  for (const item of value.split(/[\r\n]+|[；;]+/)) {
    const trimmed = item.trim();
    if (!trimmed || trimmed.length < 2 || trimmed.length > 200) continue;
    let trackKind = fallbackKind;
    const prefixMatch = trimmed.match(LINE_PREFIX_REGEX);
    if (prefixMatch && prefixMatch[1]) {
      trackKind = normalizeKind(prefixMatch[1]);
    }
    const text = trimmed.replace(LINE_PREFIX_REGEX, "").trim();
    if (!text || text.length < 2) continue;
    const parts = text.split(/\s+[-－—]\s+|\s+\/\s+/).map((part) => part.trim()).filter(Boolean);
    const title = parts[0];
    if (!title) continue;
    result.push({ title, artist: parts[1], kind: trackKind });
  }
  return result;
};

const extractTracks = (
  infobox: unknown,
  relations?: unknown,
  performers: string[] = [],
): BangumiMusicTrack[] => {
  const tracks: BangumiMusicTrack[] = [];
  if (relations) {
    tracks.push(...extractRelatedMusicTracks(relations, performers));
  }

  for (const entry of asArray(infobox)) {
    const record = asRecord(entry);
    const key = readString(record.key ?? record.name) ?? "";
    if (STAFF_KEY_PATTERN.test(key)) continue;
    if (!/(主题|片头|片尾|插入|插曲|opening|ending|insert|\bop\b|\bed\b|\bin\b|\btm\b|原声|\bost\b|soundtrack|remix|重混|角色|character|同人|印象|vocaloid|drama|vocal|radio|arrange|单曲|精选|朗读|艺人)/i.test(key)) continue;
    const kind = normalizeKind(key);
    const values = asArray(record.value);
    if (values.length === 0) {
      const text = readString(record.value);
      if (text) tracks.push(...parseTrackText(text, kind));
      continue;
    }
    for (const value of values) {
      if (typeof value === "string") {
        tracks.push(...parseTrackText(value, kind));
      } else {
        const item = asRecord(value);
        const rawTitle = readString(item.v ?? item.value ?? item.title ?? item.name);
        if (!rawTitle) continue;
        const rawKey = readString(item.k ?? item.name);
        const rawArtist = readString(item.artist);
        let trackKind = kind;
        let artist = rawArtist;
        if (rawKey) {
          if (STAFF_KEY_PATTERN.test(rawKey)) continue;
          if (/(主题|片头|片尾|插入|插曲|opening|ending|insert|\bop\b|\bed\b|\bin\b|\btm\b|原声|\bost\b|soundtrack|remix|重混|角色|character|同人|印象|vocaloid|drama|vocal|radio|arrange|单曲|精选|朗读|艺人)/i.test(rawKey)) {
            trackKind = normalizeKind(rawKey);
          } else if (!artist) {
            artist = rawKey;
          }
        }
        const parsed = parseTrackText(rawTitle, trackKind);
        if (parsed.length > 0) {
          for (const track of parsed) {
            tracks.push({
              title: track.title,
              artist: track.artist || artist,
              kind: track.kind,
            });
          }
        } else {
          tracks.push({ title: rawTitle, artist, kind: trackKind });
        }
      }
    }
  }
  const seen = new Set<string>();
  const uniqueTracks = tracks.filter((track) => {
    if (isBangumiCreditsEntry(track.title)) return false;
    const key = `${track.kind}:${track.title.trim().toLowerCase()}:${track.artist?.trim().toLowerCase() ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return uniqueTracks.sort((a, b) => (KIND_PRIORITY[a.kind] ?? 99) - (KIND_PRIORITY[b.kind] ?? 99));
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
  private readonly cooldownMs: number;
  private readonly maxQueuedRequests: number;
  private readonly queue: PQueue;
  private readonly pendingRejections = new Map<number, (error: AppError) => void>();
  private requestIdCounter = 0;
  private cooldownUntil = 0;
  private readonly cache: LRUCache<string, { value: unknown; expiresAt: number }>;
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(options: BangumiProviderOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.apiUrl = options.apiUrl.replace(/\/+$/, "");
    this.imageUrl = options.imageUrl?.replace(/\/+$/, "") ?? "";
    this.cooldownMs = Math.max(500, options.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS);
    this.maxQueuedRequests = Math.max(1, options.maxQueuedRequests ?? DEFAULT_MAX_QUEUED_REQUESTS);
    this.cache = new LRUCache({
      max: Math.max(1, options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES),
    });
    this.queue = new PQueue({
      concurrency: Math.max(1, options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS),
    });
  }

  async searchSubjects(keyword: string, limit = 20, filters: AnimeAutoFilters = {}): Promise<BangumiSubjectSearchResult[]> {
    const normalizedKeyword = keyword.trim();
    const payload = {
      keyword: normalizedKeyword,
      sort: "heat",
      filter: {
        type: [2],
        ...(filters.startYear || filters.endYear ? { air_date: [`>=${filters.startYear ?? 1900}-01-01`, `<${(filters.endYear ?? 2200) + 1}-01-01`] } : {}),
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
        musicTracks: extractTracks(asRecord(body).infobox, relationsBody, performers),
      };
    });
  }

  async chooseRandomSubject(filters: AnimeAutoFilters = {}, random = Math.random): Promise<BangumiSubjectDetails> {
    const result = await this.searchSubjects("", Math.min(filters.subjectLimit ?? 50, 50), filters);
    const candidates = result;
    if (candidates.length === 0) throw new AppError("BANGUMI_NO_SUBJECT", "选不到符合条件的番剧");
    const selected = candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))];
    return this.getSubject(selected.id);
  }

  private async cached<T>(key: string, ttl: number, loader: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > this.now()) return structuredClone(hit.value) as T;
    if (hit) this.cache.delete(key);
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) return structuredClone(await existing);
    const request = loader().then((value) => {
      const cachedValue = structuredClone(value);
      this.cache.set(key, { value: cachedValue, expiresAt: this.now() + ttl });
      return cachedValue;
    }).finally(() => {
      if (this.inFlight.get(key) === request) this.inFlight.delete(key);
    });
    this.inFlight.set(key, request);
    return structuredClone(await request);
  }

  private async requestJson(path: string, init?: RequestInit): Promise<unknown> {
    return this.scheduleRequest(async () => {
      try {
        const response = await this.fetcher(`${this.apiUrl}${path}`, init);
        if (response.status === 429) {
          this.enterRateLimitCooldown();
          throw this.rateLimitError();
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
      }
    });
  }

  private scheduleRequest<T>(task: () => Promise<T>): Promise<T> {
    if (this.now() < this.cooldownUntil) return Promise.reject(this.rateLimitError());
    if (this.queue.size >= this.maxQueuedRequests) return Promise.reject(this.rateLimitError("Bangumi 请求排队过多，请稍后重试"));

    const id = ++this.requestIdCounter;
    const cancelled = new Promise<never>((_, reject) => {
      this.pendingRejections.set(id, reject);
    });
    const execution = this.queue.add(async () => {
      this.pendingRejections.delete(id);
      if (this.now() < this.cooldownUntil) throw this.rateLimitError();
      return task();
    }) as Promise<T>;
    return Promise.race([execution, cancelled]).finally(() => this.pendingRejections.delete(id));
  }

  private enterRateLimitCooldown() {
    this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + this.cooldownMs);
    const error = this.rateLimitError();
    const rejections = [...this.pendingRejections.values()];
    this.queue.clear();
    this.pendingRejections.clear();
    for (const reject of rejections) reject(error);
  }

  private rateLimitError(message = "Bangumi 请求过于频繁，请稍后重试") {
    return new AppError("BANGUMI_RATE_LIMITED", message, {
      retryAfterMs: Math.max(0, this.cooldownUntil - this.now()),
    });
  }
}

export const extractBangumiMusicTracks = extractTracks;
