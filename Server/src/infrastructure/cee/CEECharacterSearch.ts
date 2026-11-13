import type { Database } from "bun:sqlite";
import { AppError } from "../../domain/Errors";
import type { CEECharacterSummary, CEESubjectSummary } from "../../shared/CEE";
import type { BangumiSearchIndex } from "../BangumiSearchIndex";
import type { CEEEnrichment } from "../CEEEnrichment";
import { ftsPhrase } from "../db/FtsQuery";
import {
  boundedLimit,
  like,
  positiveId,
  toCharacterSummary,
  toSubjectSummary,
  validTypes,
  type CEEContext,
  type CharacterRow,
  type SubjectRow,
} from "./Rows";

/** 搜索候选：本地行连同其补充资料后的摘要，排序阶段只读内存、不再触库。 */
interface CharacterCandidate {
  row: CharacterRow;
  summary: CEECharacterSummary;
}

/** 原文名或中文名完全命中的排在最前，其次按收藏数、最后按编号稳定决胜。 */
const compareCharacterMatchRank = (
  a: CharacterCandidate,
  b: CharacterCandidate,
  query: string
): number => {
  const aExact = Number(a.summary.name !== query && a.summary.nameCn !== query);
  const bExact = Number(b.summary.name !== query && b.summary.nameCn !== query);
  return aExact - bExact || b.row.collects - a.row.collects || a.row.id - b.row.id;
};

/** 角色与作品的搜索、按编号取作品、作品下的角色；只读，不持有可变状态。 */
export class CEESearch {
  private readonly db: Database;
  private readonly enrichment: CEEEnrichment;
  private readonly search?: BangumiSearchIndex;

  constructor(ctx: CEEContext) {
    this.db = ctx.db;
    this.enrichment = ctx.enrichment;
    this.search = ctx.search;
  }

  async searchCharacters(keyword: string, limit = 20): Promise<CEECharacterSummary[]> {
    const query = keyword.trim().slice(0, 80);
    const count = boundedLimit(limit);
    if (this.search) return this.searchCharactersViaIndex(this.search, query, count);

    const rows = this.queryLocalCharacterRows(query, count);
    this.appendEnrichedCharacterRows(rows, query, count);
    // 每个候选只读一次补充资料；比较器不执行 SQLite I/O。
    return this.rankCharacterRows(rows, query, count);
  }

  private async searchCharactersViaIndex(
    search: BangumiSearchIndex,
    query: string,
    count: number
  ): Promise<CEECharacterSummary[]> {
    const result = await search.searchCharacters(query, count);
    if (!result.ids.length) return [];
    const placeholders = result.ids.map(() => "?").join(",");
    const rows = this.db
      .query(`SELECT * FROM characters WHERE id IN (${placeholders})`)
      .all(...result.ids) as CharacterRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    return result.ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [toCharacterSummary(this.enrichment, row)] : [];
    });
  }

  /** 未启用检索索引时的本地查询：空词取热门、短词走 LIKE、长词走 FTS5。 */
  private queryLocalCharacterRows(query: string, count: number): CharacterRow[] {
    if (!query) {
      return this.db
        .query("SELECT * FROM characters ORDER BY collects DESC,id LIMIT ?")
        .all(count) as CharacterRow[];
    }
    const pattern = like(query);
    if ([...query].length < 3) {
      return this.db
        .query(
          `SELECT * FROM characters WHERE name LIKE ? ESCAPE '\\' OR name_cn LIKE ? ESCAPE '\\' OR aliases LIKE ? ESCAPE '\\' OR id=?
        ORDER BY CASE WHEN name=? OR name_cn=? THEN 0 ELSE 1 END,collects DESC,id LIMIT ?`
        )
        .all(pattern, pattern, pattern, Number(query) || -1, query, query, count) as CharacterRow[];
    }
    return this.queryCharacterPhraseRows(query, count);
  }

  /** FTS5 短语检索；纯数字关键词还要把精确 ID 命中的角色补到最前。 */
  private queryCharacterPhraseRows(query: string, count: number): CharacterRow[] {
    const phrase = ftsPhrase(query);
    const rows = this.db
      .query(
        `SELECT c.* FROM character_search f JOIN characters c ON c.id=f.rowid WHERE character_search MATCH ?
      ORDER BY CASE WHEN c.name=? OR c.name_cn=? THEN 0 ELSE 1 END,c.collects DESC,c.id LIMIT ?`
      )
      .all(phrase, query, query, count) as CharacterRow[];
    if (!/^\d+$/.test(query)) return rows;
    const exact = this.db
      .query("SELECT * FROM characters WHERE id=?")
      .get(Number(query)) as CharacterRow | null;
    if (exact && !rows.some((row) => row.id === exact.id)) rows.unshift(exact);
    return rows;
  }

  /** 补充资料（同步回来的中文名/别名）命中的角色并入候选，不覆盖本地查询顺序。 */
  private appendEnrichedCharacterRows(rows: CharacterRow[], query: string, count: number): void {
    if (!query) return;
    const pattern = like(query);
    const updated = this.enrichment.db
      .query<{ id: number }, [string, string, string, number]>(
        `SELECT id FROM cee_character_enrichment WHERE schema_version=1 AND
      (json_extract(payload,'$.name') LIKE ? ESCAPE '\\' OR json_extract(payload,'$.nameCn') LIKE ? ESCAPE '\\' OR json_extract(payload,'$.aliases') LIKE ? ESCAPE '\\')
      ORDER BY id LIMIT ?`
      )
      .all(pattern, pattern, pattern, count);
    for (const { id } of updated) {
      if (rows.some((row) => row.id === id)) continue;
      const row = this.db
        .query("SELECT * FROM characters WHERE id=?")
        .get(id) as CharacterRow | null;
      if (row) rows.push(row);
    }
  }

  private rankCharacterRows(
    rows: CharacterRow[],
    query: string,
    count: number
  ): CEECharacterSummary[] {
    const candidates = rows.map((row) => ({ row, summary: toCharacterSummary(this.enrichment, row) }));
    if (query) candidates.sort((a, b) => compareCharacterMatchRank(a, b, query));
    return candidates.slice(0, count).map(({ summary }) => summary);
  }

  async searchSubjects(
    keyword: string,
    limit = 20,
    types = [1, 2, 4, 6]
  ): Promise<CEESubjectSummary[]> {
    const selected = validTypes(types);
    if (!selected.length) return [];
    const query = keyword.trim().slice(0, 80);
    if (this.search) {
      const result = await this.search.searchSubjects({
        keyword: query,
        limit: boundedLimit(limit),
        types: selected,
      });
      if (!result.ids.length) return [];
      const placeholders = result.ids.map(() => "?").join(",");
      const rows = this.db
        .query(`SELECT * FROM subjects WHERE id IN (${placeholders})`)
        .all(...result.ids) as SubjectRow[];
      const byId = new Map(rows.map((row) => [row.id, row]));
      return result.ids.flatMap((id) => {
        const row = byId.get(id);
        return row ? [toSubjectSummary(this.enrichment, row)] : [];
      });
    }
    const pattern = like(query);
    const rows = this.db
      .query(
        `SELECT * FROM subjects WHERE nsfw=0 AND type IN (${selected.map(() => "?").join(",")})
      AND (name LIKE ? ESCAPE '\\' OR name_cn LIKE ? ESCAPE '\\' OR id=?)
      ORDER BY CASE WHEN name=? OR name_cn=? THEN 0 ELSE 1 END,heat DESC,id LIMIT ?`
      )
      .all(
        ...selected,
        pattern,
        pattern,
        Number(query) || -1,
        query,
        query,
        boundedLimit(limit)
      ) as SubjectRow[];
    return rows.map((row) => toSubjectSummary(this.enrichment, row));
  }

  async getSubjects(subjectIds: number[]): Promise<CEESubjectSummary[]> {
    const ids = [...new Set(subjectIds.filter(positiveId))].slice(0, 500);
    if (!ids.length) return [];
    const rows = this.db
      .query(`SELECT * FROM subjects WHERE nsfw=0 AND id IN (${ids.map(() => "?").join(",")})`)
      .all(...ids) as SubjectRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [toSubjectSummary(this.enrichment, row)] : [];
    });
  }

  async getSubjectCharacters(subjectId: number, limit = 50): Promise<CEECharacterSummary[]> {
    if (!positiveId(subjectId)) throw new AppError("CEE_SUBJECT_NOT_FOUND", "作品不存在");
    const rows = this.db
      .query(
        `SELECT c.* FROM character_subject_relations r JOIN characters c ON c.id=r.character_id
      JOIN subjects s ON s.id=r.subject_id WHERE r.subject_id=? AND r.relation_type IN (1,2) AND s.nsfw=0
      ORDER BY r.relation_order,c.id LIMIT ?`
      )
      .all(subjectId, boundedLimit(limit, 100)) as CharacterRow[];
    return rows.map((row) => toCharacterSummary(this.enrichment, row));
  }
}
