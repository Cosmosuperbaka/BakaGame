import { Database } from "bun:sqlite";
import { AppError } from "../domain/Errors";
import { isBangumiCreditsEntry } from "../shared/Index";
import type { AnimeAutoFilters, BangumiMusicTrack, BangumiSubjectDetails, BangumiSubjectSearchResult } from "../shared/Index";

export interface BangumiDataProvider {
  searchSubjects(keyword: string, limit?: number, filters?: AnimeAutoFilters): Promise<BangumiSubjectSearchResult[]>;
  getSubject(subjectId: string): Promise<BangumiSubjectDetails>;
  chooseRandomSubject(filters?: AnimeAutoFilters, random?: () => number): Promise<BangumiSubjectDetails>;
}

const parseList = (value: string) => { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []; } catch { return []; } };
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
    const source = new URL(value);
    if (!imageBase || source.hostname !== "lain.bgm.tv") return value;
    return `${imageBase}${source.pathname}${source.search}${source.hash}`;
  } catch {
    return undefined;
  }
};
const toResult = (row: any, imageBase = ""): BangumiSubjectSearchResult => ({ id: String(row.id), name: row.name, nameCn: row.name_cn || row.name, imageUrl: rewriteImage(row.image, imageBase) ?? undefined, year: row.date ? Number(String(row.date).slice(0, 4)) : undefined, rating: row.score || undefined, ratingCount: row.rating_count || undefined, tags: parseList(row.tags), metaTags: parseList(row.meta_tags) });

export class LocalBangumiProvider implements BangumiDataProvider {
  private readonly song: Database;
  private readonly character: Database;
  constructor(songPath: string, characterPath: string, imageBase = "https://lain.bgm.tv", apiBase = "", fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch) {
    this.imageBase = imageBase.replace(/\/+$/, "");
    this.apiBase = apiBase.replace(/\/+$/, "");
    this.fetcher = fetcher;
    this.song = new Database(songPath, { readonly: true });
    this.character = new Database(characterPath, { readonly: true });
  }
  private readonly imageBase: string;
  private readonly apiBase: string;
  private readonly fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly imageCache = new Map<number, string | undefined>();

  private async resolveImage(id: number): Promise<string | undefined> {
    if (!this.apiBase) return undefined;
    if (this.imageCache.has(id)) return this.imageCache.get(id);
    try {
      const response = await this.fetcher(`${this.apiBase}/v0/subjects/${id}`, { headers: { Accept: "application/json", "User-Agent": "BakaGame/1.0" }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { images?: Record<string, unknown> };
      const images = body.images ?? {};
      const image = rewriteImage(images.medium ?? images.large ?? images.common ?? images.grid, this.imageBase);
      this.imageCache.set(id, image);
      return image;
    } catch {
      this.imageCache.set(id, undefined);
      return undefined;
    }
  }
  async searchSubjects(keyword: string, limit = 20, filters: AnimeAutoFilters = {}) {
    const q = keyword.trim();
    const clauses = ["type = 2"];
    const args: any[] = [];
    if (filters.startYear) { clauses.push("date >= ?"); args.push(`${filters.startYear}-01-01`); }
    if (filters.endYear) { clauses.push("date < ?"); args.push(`${filters.endYear + 1}-01-01`); }
    let rows: any[];
    if (q) {
      rows = this.song.query(`SELECT s.* FROM subject_search f JOIN subjects s ON s.id=f.rowid WHERE subject_search MATCH ? AND ${clauses.join(" AND ")} ORDER BY CASE WHEN s.name = ? OR s.name_cn = ? THEN 0 WHEN s.name LIKE ? OR s.name_cn LIKE ? THEN 1 ELSE 2 END, s.heat DESC, s.rank ASC, s.score DESC, s.id ASC LIMIT ?`).all(`${q.replace(/["*]/g, " ")}*`, ...args, q, q, `${q}%`, `${q}%`, Math.min(50, Math.max(1, limit)));
    } else {
      rows = this.song.query(`SELECT * FROM subjects WHERE ${clauses.join(" AND ")} ORDER BY heat DESC, rank ASC, score DESC, id ASC LIMIT ?`).all(...args, Math.min(50, Math.max(1, limit)));
    }
    return rows.map((row) => toResult(row, this.imageBase));
  }
  async getSubject(subjectId: string): Promise<BangumiSubjectDetails> {
    const id = Number(subjectId); if (!Number.isInteger(id) || id <= 0) throw new AppError("BANGUMI_SUBJECT_NOT_FOUND", "番剧条目不存在");
    const row: any = this.song.query("SELECT * FROM subjects WHERE id = ? AND type = 2").get(id);
    if (!row) throw new AppError("BANGUMI_SUBJECT_NOT_FOUND", "番剧条目不存在");
    // 只取真实音乐实体（music_id > 0）。负数 music_id 是 Bangumi 关联条目里的
    // 合成占位行——版权署名、制作委员会、动画师/作家署名等，共 7762 条，
    // 全被标成 opening 而排在真实曲目之前，实测会把《Music For All》这类
    // 完全无关的歌曲当成番剧 OP。文本规则 isBangumiCreditsEntry 作为第二道防线，
    // 同时覆盖联网 API 路径。
    const relations = this.song.query("SELECT r.title, r.artist, r.kind, r.relation_type, r.relation_order FROM subject_music_relations r WHERE r.subject_id=? AND r.music_id > 0 ORDER BY r.relation_order, r.music_id").all(id) as any[];
    const seen = new Set<string>();
    const musicTracks: BangumiMusicTrack[] = relations.filter((m) => typeof m.title === "string" && m.title.trim() && !isBangumiCreditsEntry(m.title)).map((m) => ({ title: m.title.trim(), artist: m.artist || undefined, kind: normalizeKind(m.kind || m.title, Number(m.relation_type)) })).filter((m) => { const key = `${m.kind}:${m.title.toLowerCase()}:${m.artist?.toLowerCase() ?? ""}`; if (seen.has(key)) return false; seen.add(key); return true; });
    const imageUrl = rewriteImage(row.image, this.imageBase) ?? await this.resolveImage(id);
    return { ...toResult({ ...row, image: imageUrl }, ""), summary: row.summary || undefined, locked: false, musicTracks };
  }
  async chooseRandomSubject(filters: AnimeAutoFilters = {}, random = Math.random) { const rows = await this.searchSubjects("", Math.min(filters.subjectLimit ?? 50, 50), filters); if (!rows.length) throw new AppError("BANGUMI_NO_SUBJECT", "选不到符合条件的番剧"); return this.getSubject(rows[Math.min(rows.length - 1, Math.floor(random() * rows.length))].id); }
  close() { this.song.close(); this.character.close(); }
}
