import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "../domain/Errors";
import { isBangumiCreditsEntry } from "../shared/Index";
import type { AnimeAutoFilters, BangumiMusicTrack, BangumiSubjectDetails, BangumiSubjectSearchResult } from "../shared/Index";

export interface BangumiDataProvider {
  searchSubjects(keyword: string, limit?: number, filters?: AnimeAutoFilters): Promise<BangumiSubjectSearchResult[]>;
  getSubject(subjectId: string): Promise<BangumiSubjectDetails>;
  chooseRandomSubject(filters?: AnimeAutoFilters, random?: () => number): Promise<BangumiSubjectDetails>;
  /** 角色立绘：本地数据集不含图片，只能回源取，结果写进回填缓存。 */
  resolveCharacterImage(characterId: number): Promise<string | undefined>;
  /**
   * 释放底层资源（SQLite 句柄等）。声明为可选：远端 provider 不需要它。
   * 有了这个声明，回退 provider 就不必再写双重 `as unknown as` 去探测方法是否存在。
   */
  close?: () => void | Promise<void>;
}

const parseList = (value: string | null | undefined) => { if (typeof value !== "string" || !value) return []; try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []; } catch { return []; } };
/**
 * Bangumi 关联类型码到曲目类型的映射。
 *
 * 用真实数据集全量核对过，码值语义与旧映射（3002=opening / 3003=ending /
 * 3004=insert / 3005=character）恰好错位一格，旧映射会把**片头曲标成 ED、
 * 角色歌标成 OP**，并按曲目类型筛选出完全错误的曲目：
 * - 鬼滅の刃：紅蓮華（OP）3003、from the edge（ED）3004
 * - けいおん!：Cagayake!GIRLS（OP）3003、Don't say "lazy"（ED）3004、
 *   ふわふわ時間（插入歌）3005、イメージソング系列（角色歌）3002
 * - SPY×FAMILY：ミックスナッツ（OP）3003、喜劇（ED）3004
 * - 呪術廻戦：廻廻奇譚（OP）3003、LOST IN PARADISE（ED）3004
 * 3001 是主题歌 / 原声带（OST 专辑），3006 是印象曲，3007 / 3099 是其他。
 */
const RELATION_KINDS: Record<number, BangumiMusicTrack["kind"]> = {
  3001: "theme",
  3002: "character",
  3003: "opening",
  3004: "ending",
  3005: "insert",
  3006: "image",
};
const normalizeKind = (value: string, relationType?: number): BangumiMusicTrack["kind"] => {
  const mapped = relationType ? RELATION_KINDS[relationType] : undefined;
  if (mapped) return mapped;
  const text = value.toLowerCase();
  if (/片头|片頭|opening|\bop\b/.test(text)) return "opening";
  if (/片尾|ending|\bed\d*\b/.test(text)) return "ending";
  if (/插入|插曲|insert|\bin\d*\b/.test(text)) return "insert";
  if (/原声|soundtrack|\bost\b/.test(text)) return "ost";
  if (/角色|character/.test(text)) return "character";
  if (/remix|重混/.test(text)) return "remix";
  if (/同人/.test(text)) return "doujin";
  if (/印象|image/.test(text)) return "image";
  if (/vocaloid/.test(text)) return "vocaloid";
  if (/drama|广播剧/.test(text)) return "drama";
  if (/radio|广播/.test(text)) return "radio";
  if (/arrange|改编|編曲/.test(text)) return "arrange";
  if (/单曲|single/.test(text)) return "single";
  if (/精选|collection|best/.test(text)) return "collection";
  if (/朗读|reading/.test(text)) return "reading";
  if (/艺人|album/.test(text)) return "artistAlbum";
  return "theme";
};
const rewriteImage = (value: unknown, imageBase: string) => {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = new URL(value);
    if (!imageBase || parsed.hostname !== "lain.bgm.tv") return value;
    return `${imageBase}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return undefined;
  }
};
/** `subjects` 表的行形状：SQLite 返回的是裸对象，这里显式钉住字段，避免 `any` 一路扩散。 */
export interface SubjectRow {
  id: number | string;
  name: string;
  name_cn?: string | null;
  image?: string | null;
  date?: string | null;
  score?: number | null;
  rating_count?: number | null;
  tags?: string | null;
  meta_tags?: string | null;
  summary?: string | null;
  type?: number;
  heat?: number | null;
  rank?: number | null;
}

/** `subject_music_relations` 表的行形状。 */
export interface MusicRelationRow {
  title: string;
  artist?: string | null;
  kind?: string | null;
  relation_type?: number | null;
  relation_order?: number | null;
}

const toResult = (row: SubjectRow, imageBase = ""): BangumiSubjectSearchResult => ({ id: String(row.id), name: row.name, nameCn: row.name_cn || row.name, imageUrl: rewriteImage(row.image, imageBase) ?? undefined, year: row.date ? Number(String(row.date).slice(0, 4)) : undefined, rating: row.score || undefined, ratingCount: row.rating_count || undefined, tags: parseList(row.tags), metaTags: parseList(row.meta_tags) });

/** 回填缓存的实体类型：番剧与角色共用同一张表。 */
export type EnrichmentEntity = "subject" | "character";

/** 回填缓存保存的补充字段。只存**上游原始 URL**，镜像地址在读取时重写。 */
export interface BangumiEnrichment {
  image?: string;
}

export interface LocalBangumiProviderOptions {
  songPath: string;
  characterPath: string;
  /**
   * Bangumi API 回填缓存（可写 SQLite）。缺省时不落盘，只走内存缓存。
   * 只读数据集是 LFS 产物、每周被 CI 重建，不能被运行时写入，所以补充数据单独存这里。
   */
  enrichmentPath?: string;
  imageBase?: string;
  apiBase?: string;
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

/** 可跨 Worker 传递的初始化参数：`fetcher` 是函数，无法结构化克隆。 */
export type BangumiProviderInit = Omit<LocalBangumiProviderOptions, "fetcher">;

/** 回源失败后的短期负缓存：只用于挡住重复打爆上游，重启即失效，**绝不落盘**。 */
const NEGATIVE_CACHE_TTL_MS = 5 * 60_000;

export class LocalBangumiProvider implements BangumiDataProvider {
  private readonly song: Database;
  private readonly character: Database;
  private readonly enrichment?: Database;
  private readonly imageBase: string;
  private readonly apiBase: string;
  private readonly fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly imageCache = new Map<string, string>();
  private readonly imageMissUntil = new Map<string, number>();

  constructor(options: LocalBangumiProviderOptions) {
    this.imageBase = (options.imageBase ?? "https://lain.bgm.tv").replace(/\/+$/, "");
    this.apiBase = (options.apiBase ?? "").replace(/\/+$/, "");
    this.fetcher = options.fetcher ?? fetch;
    this.song = new Database(options.songPath, { readonly: true });
    this.character = new Database(options.characterPath, { readonly: true });
    if (options.enrichmentPath) {
      // 路径配置错误必须在启动时暴露：静默降级会让回填缓存「悄悄不生效」。
      // 使用期的读写异常是另一回事，只记日志、不影响出题（见 read/writeEnrichment）。
      mkdirSync(dirname(options.enrichmentPath), { recursive: true });
      const enrichment = new Database(options.enrichmentPath, { create: true });
      enrichment.run(`
        CREATE TABLE IF NOT EXISTS enrichment (
          entity TEXT NOT NULL, id INTEGER NOT NULL,
          payload TEXT NOT NULL, fetched_at INTEGER NOT NULL,
          PRIMARY KEY(entity, id)
        )
      `);
      this.enrichment = enrichment;
    }
  }

  /** 从回填缓存读取补充字段；只读数据集不含图片，这是避免反复回源的唯一持久层。 */
  private readEnrichment(entity: EnrichmentEntity, id: number): BangumiEnrichment | undefined {
    if (!this.enrichment) return undefined;
    try {
      // bun:sqlite 的 Statement 泛型在多参数下会被推断成数组形态，这里显式声明参数元组。
      const row = this.enrichment.query<{ payload: string }, [string, number]>("SELECT payload FROM enrichment WHERE entity = ? AND id = ?").get(entity, id);
      if (!row) return undefined;
      return JSON.parse(row.payload) as BangumiEnrichment;
    } catch (error) {
      console.warn("Bangumi 回填缓存读取失败，本次跳过", error);
      return undefined;
    }
  }

  private writeEnrichment(entity: EnrichmentEntity, id: number, payload: BangumiEnrichment): void {
    if (!this.enrichment) return;
    try {
      this.enrichment.query<null, [string, number, string, number]>(
        "INSERT INTO enrichment (entity, id, payload, fetched_at) VALUES (?,?,?,?) ON CONFLICT(entity, id) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at",
      ).run(entity, id, JSON.stringify(payload), Date.now());
    } catch (error) {
      console.warn("Bangumi 回填缓存写入失败，本次跳过", error);
    }
  }

  /**
   * 取实体图片（番剧或角色）。顺序：内存正缓存 → 回填缓存 → 上游 API。
   *
   * **失败绝不固化**：上游超时/报错既不写回填缓存，也不留内存正缓存，只记 5 分钟负缓存
   * 以免重复打爆上游。历史实现把失败也塞进内存正缓存，一次瞬时超时就会让该条目
   * 在进程剩余生命周期里再也没有图片。
   */
  private async resolveEntityImage(entity: EnrichmentEntity, id: number): Promise<string | undefined> {
    const key = `${entity}:${id}`;
    if (this.imageCache.has(key)) return this.imageCache.get(key);
    const missUntil = this.imageMissUntil.get(key);
    if (missUntil !== undefined && missUntil > Date.now()) return undefined;

    const persisted = this.readEnrichment(entity, id);
    if (persisted?.image) {
      const image = rewriteImage(persisted.image, this.imageBase);
      if (image) {
        this.imageCache.set(key, image);
        return image;
      }
    }

    if (!this.apiBase) return undefined;
    try {
      const path = entity === "subject" ? "subjects" : "characters";
      const response = await this.fetcher(`${this.apiBase}/v0/${path}/${id}`, { headers: { Accept: "application/json", "User-Agent": "BakaGame/1.0" }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { images?: Record<string, unknown> };
      const images = body.images ?? {};
      const candidate = images.medium ?? images.large ?? images.common ?? images.grid;
      const image = rewriteImage(candidate, this.imageBase);
      // 拿不到合法图片地址（上游确实没图，或返回的不是 URL）：只做短期负缓存，
      // **不写回填缓存**，避免把「暂时没有」当成永久结论。
      if (typeof candidate !== "string" || !image) {
        this.imageMissUntil.set(key, Date.now() + NEGATIVE_CACHE_TTL_MS);
        return undefined;
      }
      // 存上游原始 URL：镜像地址在读取时重写，所以换镜像源既不用清缓存也不用重新回源。
      this.writeEnrichment(entity, id, { image: candidate });
      this.imageCache.set(key, image);
      return image;
    } catch {
      this.imageMissUntil.set(key, Date.now() + NEGATIVE_CACHE_TTL_MS);
      return undefined;
    }
  }

  async resolveCharacterImage(characterId: number): Promise<string | undefined> {
    if (!Number.isInteger(characterId) || characterId <= 0) return undefined;
    return this.resolveEntityImage("character", characterId);
  }

  async searchSubjects(keyword: string, limit = 20, filters: AnimeAutoFilters = {}) {
    const q = keyword.trim();
    const clauses = ["type = 2"];
    const args: Array<string | number> = [];
    if (filters.startYear) { clauses.push("date >= ?"); args.push(`${filters.startYear}-01-01`); }
    if (filters.endYear) { clauses.push("date < ?"); args.push(`${filters.endYear + 1}-01-01`); }
    let rows: SubjectRow[];
    if (q) {
      rows = this.song.query(`SELECT s.* FROM subject_search f JOIN subjects s ON s.id=f.rowid WHERE subject_search MATCH ? AND ${clauses.join(" AND ")} ORDER BY CASE WHEN s.name = ? OR s.name_cn = ? THEN 0 WHEN s.name LIKE ? OR s.name_cn LIKE ? THEN 1 ELSE 2 END, s.heat DESC, s.rank ASC, s.score DESC, s.id ASC LIMIT ?`).all(`${q.replace(/["*]/g, " ")}*`, ...args, q, q, `${q}%`, `${q}%`, Math.min(50, Math.max(1, limit))) as SubjectRow[];
    } else {
      rows = this.song.query(`SELECT * FROM subjects WHERE ${clauses.join(" AND ")} ORDER BY heat DESC, rank ASC, score DESC, id ASC LIMIT ?`).all(...args, Math.min(50, Math.max(1, limit))) as SubjectRow[];
    }
    return rows.map((row) => toResult(row, this.imageBase));
  }
  async getSubject(subjectId: string): Promise<BangumiSubjectDetails> {
    const id = Number(subjectId); if (!Number.isInteger(id) || id <= 0) throw new AppError("BANGUMI_SUBJECT_NOT_FOUND", "番剧条目不存在");
    const row = this.song.query("SELECT * FROM subjects WHERE id = ? AND type = 2").get(id) as SubjectRow | undefined;
    if (!row) throw new AppError("BANGUMI_SUBJECT_NOT_FOUND", "番剧条目不存在");
    // 只取真实音乐实体（music_id > 0）。负数 music_id 是 Bangumi 关联条目里的
    // 合成占位行——版权署名、制作委员会、动画师/作家署名等，共 7762 条，
    // 全被标成 opening 而排在真实曲目之前，实测会把《Music For All》这类
    // 完全无关的歌曲当成番剧 OP。文本规则 isBangumiCreditsEntry 作为第二道防线，
    // 同时覆盖联网 API 路径。
    const relations = this.song.query("SELECT r.title, r.artist, r.kind, r.relation_type, r.relation_order FROM subject_music_relations r WHERE r.subject_id=? AND r.music_id > 0 ORDER BY r.relation_order, r.music_id").all(id) as MusicRelationRow[];
    const seen = new Set<string>();
    const musicTracks: BangumiMusicTrack[] = relations.filter((m) => typeof m.title === "string" && m.title.trim() && !isBangumiCreditsEntry(m.title)).map((m) => ({ title: m.title.trim(), artist: m.artist || undefined, kind: normalizeKind(m.kind || m.title, Number(m.relation_type)) })).filter((m) => { const key = `${m.kind}:${m.title.toLowerCase()}:${m.artist?.toLowerCase() ?? ""}`; if (seen.has(key)) return false; seen.add(key); return true; });
    const imageUrl = rewriteImage(row.image, this.imageBase) ?? await this.resolveEntityImage("subject", id);
    return { ...toResult({ ...row, image: imageUrl }, ""), summary: row.summary || undefined, locked: false, musicTracks };
  }
  async chooseRandomSubject(filters: AnimeAutoFilters = {}, random = Math.random) { const rows = await this.searchSubjects("", Math.min(filters.subjectLimit ?? 50, 50), filters); if (!rows.length) throw new AppError("BANGUMI_NO_SUBJECT", "选不到符合条件的番剧"); return this.getSubject(rows[Math.min(rows.length - 1, Math.floor(random() * rows.length))].id); }
  close() { this.song.close(); this.character.close(); this.enrichment?.close(); }
}
