import { Database } from "bun:sqlite";
import { AppError } from "../domain/Errors";
import type { AnimeAutoFilters, BangumiMusicTrack, BangumiSubjectDetails, BangumiSubjectSearchResult } from "../shared/Index";

export interface BangumiDataProvider {
  searchSubjects(keyword: string, limit?: number, filters?: AnimeAutoFilters): Promise<BangumiSubjectSearchResult[]>;
  getSubject(subjectId: string): Promise<BangumiSubjectDetails>;
  chooseRandomSubject(filters?: AnimeAutoFilters, random?: () => number): Promise<BangumiSubjectDetails>;
}

const parseList = (value: string) => { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []; } catch { return []; } };
const normalizeKind = (value: string): BangumiMusicTrack["kind"] => {
  const text = value.toLowerCase();
  if (/片头|片頭|opening|\bop\b/.test(text)) return "opening";
  if (/片尾|ending|\bed\b/.test(text)) return "ending";
  if (/插入|插曲|insert|\bin\b/.test(text)) return "insert";
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
const toResult = (row: any, imageBase = ""): BangumiSubjectSearchResult => ({ id: String(row.id), name: row.name, nameCn: row.name_cn || row.name, imageUrl: row.image || (imageBase ? `${imageBase}/pic/cover/l/${row.id}.jpg` : undefined), year: row.date ? Number(String(row.date).slice(0, 4)) : undefined, rating: row.score || undefined, ratingCount: row.rating_count || undefined, tags: parseList(row.tags), metaTags: parseList(row.meta_tags) });

export class LocalBangumiProvider implements BangumiDataProvider {
  private readonly song: Database;
  private readonly character: Database;
  constructor(songPath: string, characterPath: string, imageBase = "https://lain.bgm.tv") {
    this.imageBase = imageBase.replace(/\/+$/, "");
    this.song = new Database(songPath, { readonly: true });
    this.character = new Database(characterPath, { readonly: true });
  }
  private readonly imageBase: string;
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
    const relations = this.song.query("SELECT r.title, r.artist, r.kind, r.relation_type, r.relation_order FROM subject_music_relations r WHERE r.subject_id=? ORDER BY r.relation_order, r.music_id").all(id) as any[];
    const seen = new Set<string>();
    const musicTracks: BangumiMusicTrack[] = relations.filter((m) => typeof m.title === "string" && m.title.trim()).map((m) => ({ title: m.title.trim(), artist: m.artist || undefined, kind: normalizeKind(m.kind || m.title) })).filter((m) => { const key = `${m.kind}:${m.title.toLowerCase()}:${m.artist?.toLowerCase() ?? ""}`; if (seen.has(key)) return false; seen.add(key); return true; });
    return { ...toResult(row, this.imageBase), summary: row.summary || undefined, locked: false, musicTracks };
  }
  async chooseRandomSubject(filters: AnimeAutoFilters = {}, random = Math.random) { const rows = await this.searchSubjects("", Math.min(filters.subjectLimit ?? 50, 50), filters); if (!rows.length) throw new AppError("BANGUMI_NO_SUBJECT", "选不到符合条件的番剧"); return this.getSubject(rows[Math.min(rows.length - 1, Math.floor(random() * rows.length))].id); }
  close() { this.song.close(); this.character.close(); }
}
