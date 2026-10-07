import { Database } from "bun:sqlite";
import { AppError } from "../domain/Errors";
import type { CCBCharacterSummary, CCBCharacterView, CCBDirectoryResult, CCBExtraTagSection, CCBSettings, CCBSubjectSummary } from "../shared/CCB";
import type { CCBDataOptions, CCBDataProvider, CCBRawAppearance, CCBRawCharacter } from "./CCBData";
import { CCBEnrichment } from "./CCBEnrichment";
import { deriveCCBCharacter, resolveCCBSubjectTypes } from "./CCBCharacterDerivation";
import { CCBMeilisearch } from "./CCBMeilisearch";

interface CharacterRow { id: number; name: string; name_cn: string; gender: string; aliases: string; summary: string; comments: number; collects: number }
interface SubjectRow { id: number; type: number; name: string; name_cn: string; date: string; raw_tags: string; meta_tags: string; score: number; rating_count: number; heat: number; relation_type?: number }
const boundedLimit = (limit: number, maximum = 50) => Math.min(maximum, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 20));
const like = (keyword: string) => `%${keyword.replace(/[\\%_]/g, "\\$&")}%`;
const positiveId = (id: number) => Number.isSafeInteger(id) && id > 0;
const validTypes = (types: number[]) => [...new Set(types)].filter((type) => [1, 2, 3, 4, 6].includes(type));

/** 生产环境由 CCBCharacterWorker 独占：SQLite 同步查询不会占用游戏主循环。 */
export class CCBCharacterRepository implements CCBDataProvider {
  private readonly db: Database;
  private readonly enrichment: CCBEnrichment;
  private readonly now: () => number;
  private readonly directoryImports = new Map<number, Promise<CCBDirectoryResult>>();
  private readonly search?: CCBMeilisearch;
  private readonly ready: Promise<void>;
  private closed = false;

  constructor(options: CCBDataOptions) {
    this.db = new Database(options.characterPath, { readonly: true });
    try { this.enrichment = new CCBEnrichment(options); } catch (error) { this.db.close(); throw error; }
    this.now = options.now ?? Date.now;
    this.search = options.meilisearch ? new CCBMeilisearch(options.meilisearch) : undefined;
    this.ready = this.search?.initialize(this.db, options.characterPath) ?? Promise.resolve();
  }

  async initialize(): Promise<void> { await this.ready; }

  async searchCharacters(keyword: string, limit = 20): Promise<CCBCharacterSummary[]> {
    this.assertOpen();
    await this.ready;
    const query = keyword.trim().slice(0, 80);
    const count = boundedLimit(limit);
    if (this.search) {
      const result = await this.search.searchCharacters(query, count);
      if (!result.ids.length) return [];
      const placeholders = result.ids.map(() => "?").join(",");
      const rows = this.db.query(`SELECT * FROM characters WHERE id IN (${placeholders})`).all(...result.ids) as CharacterRow[];
      const byId = new Map(rows.map((row) => [row.id, row]));
      return result.ids.flatMap((id) => { const row = byId.get(id); return row ? [this.toSummary(row)] : []; });
    }
    const pattern = like(query);
    let rows: CharacterRow[];
    if (!query) {
      rows = this.db.query("SELECT * FROM characters ORDER BY collects DESC,id LIMIT ?").all(count) as CharacterRow[];
    } else if ([...query].length < 3) {
      rows = this.db.query(`SELECT * FROM characters WHERE name LIKE ? ESCAPE '\\' OR name_cn LIKE ? ESCAPE '\\' OR aliases LIKE ? ESCAPE '\\' OR id=?
        ORDER BY CASE WHEN name=? OR name_cn=? THEN 0 ELSE 1 END,collects DESC,id LIMIT ?`).all(pattern, pattern, pattern, Number(query) || -1, query, query, count) as CharacterRow[];
    } else {
      const phrase = `"${query.replace(/"/g, '""')}"`;
      rows = this.db.query(`SELECT c.* FROM character_search f JOIN characters c ON c.id=f.rowid WHERE character_search MATCH ?
        ORDER BY CASE WHEN c.name=? OR c.name_cn=? THEN 0 ELSE 1 END,c.collects DESC,c.id LIMIT ?`).all(phrase, query, query, count) as CharacterRow[];
      if (/^\d+$/.test(query)) {
        const exact = this.db.query("SELECT * FROM characters WHERE id=?").get(Number(query)) as CharacterRow | null;
        if (exact && !rows.some((row) => row.id === exact.id)) rows.unshift(exact);
      }
    }
    if (query) {
      const updated = this.enrichment.db.query<{ id: number }, [string, string, string, number]>(`SELECT id FROM ccb_character_enrichment WHERE schema_version=1 AND
        (json_extract(payload,'$.name') LIKE ? ESCAPE '\\' OR json_extract(payload,'$.nameCn') LIKE ? ESCAPE '\\' OR json_extract(payload,'$.aliases') LIKE ? ESCAPE '\\')
        ORDER BY id LIMIT ?`).all(pattern, pattern, pattern, count);
      for (const { id } of updated) {
        if (rows.some((row) => row.id === id)) continue;
        const row = this.db.query("SELECT * FROM characters WHERE id=?").get(id) as CharacterRow | null;
        if (row) rows.push(row);
      }
    }
    // 每个候选只读一次补充资料；比较器不执行 SQLite I/O。
    const candidates = rows.map(row => ({ row, summary: this.toSummary(row) }));
    if (query) {
      candidates.sort((a, b) => {
        const aSummary = a.summary, bSummary = b.summary;
        const aExact = Number(aSummary.name !== query && aSummary.nameCn !== query);
        const bExact = Number(bSummary.name !== query && bSummary.nameCn !== query);
        return aExact - bExact || b.row.collects - a.row.collects || a.row.id - b.row.id;
      });
    }
    return candidates.slice(0, count).map(({ summary }) => summary);
  }

  async searchSubjects(keyword: string, limit = 20, types = [1, 2, 4, 6]): Promise<CCBSubjectSummary[]> {
    this.assertOpen();
    await this.ready;
    const selected = validTypes(types);
    if (!selected.length) return [];
    const query = keyword.trim().slice(0, 80);
    if (this.search) {
      const result = await this.search.searchSubjects(query, boundedLimit(limit), selected);
      if (!result.ids.length) return [];
      const placeholders = result.ids.map(() => "?").join(",");
      const rows = this.db.query(`SELECT * FROM subjects WHERE id IN (${placeholders})`).all(...result.ids) as SubjectRow[];
      const byId = new Map(rows.map((row) => [row.id, row]));
      return result.ids.flatMap((id) => { const row = byId.get(id); return row ? [this.toSubject(row)] : []; });
    }
    const pattern = like(query);
    const rows = this.db.query(`SELECT * FROM subjects WHERE nsfw=0 AND type IN (${selected.map(() => "?").join(",")})
      AND (name LIKE ? ESCAPE '\\' OR name_cn LIKE ? ESCAPE '\\' OR id=?)
      ORDER BY CASE WHEN name=? OR name_cn=? THEN 0 ELSE 1 END,heat DESC,id LIMIT ?`).all(...selected, pattern, pattern, Number(query) || -1, query, query, boundedLimit(limit)) as SubjectRow[];
    return rows.map((row) => this.toSubject(row));
  }

  async getSubjects(subjectIds: number[]): Promise<CCBSubjectSummary[]> {
    this.assertOpen();
    await this.ready;
    const ids = [...new Set(subjectIds.filter(positiveId))].slice(0, 500);
    if (!ids.length) return [];
    const rows = this.db.query(`SELECT * FROM subjects WHERE nsfw=0 AND id IN (${ids.map(() => "?").join(",")})`).all(...ids) as SubjectRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.flatMap((id) => { const row = byId.get(id); return row ? [this.toSubject(row)] : []; });
  }

  async getSubjectCharacters(subjectId: number, limit = 50): Promise<CCBCharacterSummary[]> {
    this.assertOpen();
    await this.ready;
    if (!positiveId(subjectId)) throw new AppError("CCB_SUBJECT_NOT_FOUND", "作品不存在");
    const rows = this.db.query(`SELECT c.* FROM character_subject_relations r JOIN characters c ON c.id=r.character_id
      JOIN subjects s ON s.id=r.subject_id WHERE r.subject_id=? AND r.relation_type IN (1,2) AND s.nsfw=0
      ORDER BY r.relation_order,c.id LIMIT ?`).all(subjectId, boundedLimit(limit, 100)) as CharacterRow[];
    return rows.map((row) => this.toSummary(row));
  }

  async getRawCharacter(id: number): Promise<CCBRawCharacter> {
    this.assertOpen();
    await this.ready;
    if (!positiveId(id)) throw new AppError("CCB_CHARACTER_NOT_FOUND", "本地角色资料不存在");
    const row = this.db.query("SELECT * FROM characters WHERE id=?").get(id) as CharacterRow | null;
    if (!row) throw new AppError("CCB_CHARACTER_NOT_FOUND", "本地角色资料不存在");
    const supplement = this.enrichment.readCharacter(id);
    const appearances = this.db.query(`SELECT s.*,r.relation_type FROM character_subject_relations r JOIN subjects s ON s.id=r.subject_id
      WHERE r.character_id=? AND r.relation_type IN (1,2) AND s.nsfw=0 ORDER BY r.subject_id LIMIT 2001`).all(id) as SubjectRow[];
    if (appearances.length > 2000) throw new AppError("CCB_CHARACTER_TOO_LARGE", "角色登场作品过多，无法用于本局");
    const tags = this.db.query<{ tag: string }, [number]>("SELECT tag FROM character_tags WHERE character_id=? ORDER BY position").all(id);
    const voices = this.db.query<{ name: string }, [number]>("SELECT name FROM character_vas WHERE character_id=? ORDER BY position").all(id);
    const extraRows = this.db.query<{ subject_id: number; section: string; tag: string }, [number]>(
      "SELECT subject_id,section,tag FROM character_extra_tags WHERE character_id=? ORDER BY subject_id,section_position,tag_position").all(id);
    const extraTagsBySubject: Record<number, CCBExtraTagSection[]> = {};
    for (const row of extraRows) {
      const sections = extraTagsBySubject[row.subject_id] ??= [];
      let section = sections.at(-1);
      if (!section || section.section !== row.section) { section = { section: row.section, tags: [] }; sections.push(section); }
      section.tags.push(row.tag);
    }
    return {
      ...this.toSummary(row), aliases: supplement.aliases ?? JSON.parse(row.aliases) as string[],
      gender: supplement.gender ?? (row.gender === "male" || row.gender === "female" ? row.gender : "?"),
      popularity: supplement.popularity ?? row.collects + row.comments, summary: supplement.summary ?? row.summary,
      appearances: appearances.map((item): CCBRawAppearance => ({
        id: item.id, type: item.type, name: item.name, nameCn: item.name_cn || item.name, date: item.date,
        relationType: item.relation_type!, rating: item.score, ratingCount: item.rating_count, heat: item.heat,
        rawTags: JSON.parse(item.raw_tags) as Record<string, number>, metaTags: JSON.parse(item.meta_tags) as string[],
      })),
      characterTags: tags.map((item) => item.tag), voiceActors: [...new Set(voices.map((item) => item.name))], extraTagsBySubject,
    };
  }

  async getCharacter(id: number, settings: CCBSettings): Promise<CCBCharacterView> {
    return deriveCCBCharacter(await this.getRawCharacter(id), settings, this.now());
  }

  async chooseRandomCharacter(settings: CCBSettings, random = Math.random): Promise<CCBCharacterView> {
    this.assertOpen();
    await this.ready;
    const roll = (size: number) => Math.min(size - 1, Math.max(0, Math.floor(random() * size)));
    let subjectId: number;
    if (settings.useIndex) {
      const directory = settings.indexId ? this.enrichment.getDirectory(settings.indexId) : undefined;
      if (!directory) throw new AppError("CCB_DIRECTORY_NOT_IMPORTED", "请先导入目录再开始游戏");
      const ids = [...directory.subjectIds, ...settings.addedSubjects];
      if (!ids.length) throw new AppError("CCB_NO_SUBJECT", "目录中没有本地可用作品");
      subjectId = ids[roll(ids.length)];
    } else {
      const currentYear = new Date(this.now()).getUTCFullYear();
      const endYear = Math.min(currentYear, settings.endYear);
      if (endYear < settings.startYear) throw new AppError("CCB_NO_SUBJECT", "年份范围内没有已上映作品");
      const yearCount = endYear - settings.startYear + 1;
      const year = settings.useSubjectPerYear ? settings.startYear + roll(yearCount) : settings.startYear;
      const baseCount = settings.topNSubjects * (settings.useSubjectPerYear ? yearCount : 1);
      const index = roll(baseCount + settings.addedSubjects.length);
      if (index >= baseCount) subjectId = settings.addedSubjects[index - baseCount];
      else {
        const types = resolveCCBSubjectTypes(settings.metaTags, true);
        const tags = settings.metaTags[0] === "Galgame" ? ["Galgame"] : settings.metaTags.filter((tag) => tag && !["游戏", "书籍", "三次元", "全部"].includes(tag));
        const endDate = `${settings.useSubjectPerYear ? year + 1 : endYear + 1}-01-01`;
        const rows = this.db.query(`SELECT s.id FROM subjects s WHERE s.nsfw=0 AND s.type IN (${types.map(() => "?").join(",")})
          AND s.date>=? AND s.date<? AND s.date<=?
          ${tags.map(() => "AND EXISTS(SELECT 1 FROM json_each(s.meta_tags) WHERE value=?)").join(" ")}
          ORDER BY s.heat DESC,s.id LIMIT ?`).all(...types, `${year}-01-01`, endDate, new Date(this.now()).toISOString().slice(0, 10), ...tags, settings.topNSubjects) as { id: number }[];
        if (!rows.length) throw new AppError("CCB_NO_SUBJECT", "选不到符合条件的作品，请调整范围");
        subjectId = rows[settings.useSubjectPerYear || index >= rows.length ? roll(rows.length) : index].id;
      }
    }
    const subject = this.db.query("SELECT id FROM subjects WHERE id=? AND nsfw=0").get(subjectId);
    if (!subject) throw new AppError("CCB_SUBJECT_NOT_FOUND", "指定作品不在本地可用数据集中");
    const relation = settings.mainCharacterOnly ? "r.relation_type=1" : "r.relation_type IN (1,2)";
    const candidates = this.db.query(`SELECT c.id FROM character_subject_relations r JOIN characters c ON c.id=r.character_id
      WHERE r.subject_id=? AND ${relation} ORDER BY r.relation_order,c.id LIMIT ?`).all(subjectId, settings.mainCharacterOnly ? 2001 : settings.characterNum) as { id: number }[];
    if (candidates.length > 2000) throw new AppError("CCB_SUBJECT_TOO_LARGE", "作品主角数量过多，请调整出题范围");
    if (!candidates.length) throw new AppError("CCB_NO_CHARACTER", "选到的作品没有符合条件的本地角色");
    return this.getCharacter(candidates[roll(candidates.length)].id, settings);
  }

  async importDirectory(indexId: number): Promise<CCBDirectoryResult> {
    this.assertOpen();
    await this.ready;
    if (!positiveId(indexId)) throw new AppError("CCB_DIRECTORY_INVALID", "目录编号无效");
    const running = this.directoryImports.get(indexId);
    if (running) return structuredClone(await running);
    const request = this.loadDirectory(indexId).finally(() => this.directoryImports.delete(indexId));
    this.directoryImports.set(indexId, request);
    return structuredClone(await request);
  }

  private async loadDirectory(indexId: number): Promise<CCBDirectoryResult> {
    const ids = await this.enrichment.fetchDirectory(indexId);
    const available = new Set<number>();
    if (ids.length) {
      const rows = this.db.query(`SELECT id FROM subjects WHERE nsfw=0 AND id IN (${ids.map(() => "?").join(",")})`).all(...ids) as { id: number }[];
      for (const row of rows) available.add(row.id);
    }
    const result: CCBDirectoryResult = { id: indexId, subjectIds: ids.filter((id) => available.has(id)), missingSubjectIds: ids.filter((id) => !available.has(id)), importedAt: this.now() };
    this.enrichment.saveDirectory(result);
    return result;
  }

  async resolveCharacterImage(id: number): Promise<string | undefined> {
    this.assertOpen();
    await this.ready;
    if (!positiveId(id) || !this.db.query("SELECT id FROM characters WHERE id=?").get(id)) return undefined;
    const imageUrl = await this.enrichment.resolveCharacterImage(id);
    if (this.search) await this.syncCharacterIndex(id);
    return imageUrl;
  }

  async resolveSubjectImage(id: number): Promise<string | undefined> {
    this.assertOpen();
    await this.ready;
    if (!positiveId(id) || !this.db.query("SELECT id FROM subjects WHERE id=? AND nsfw=0").get(id)) return undefined;
    return this.enrichment.resolveSubjectImage(id);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([this.ready, ...this.directoryImports.values()]);
    await this.enrichment.close();
    this.db.close();
  }

  /** 封面只读已回填的那份，不在列表查询里回源；缺的由客户端按需经 `ccb.subject.image` 补。 */
  private toSubject(row: SubjectRow): CCBSubjectSummary {
    const imageUrl = this.enrichment.readImage(row.id, "subject");
    return {
      id: row.id, type: row.type, name: row.name, nameCn: row.name_cn || row.name,
      year: /^\d{4}/.test(row.date) ? Number(row.date.slice(0, 4)) : null, rating: row.score, heat: row.heat,
      ...(imageUrl ? { imageUrl } : {}),
    };
  }

  private toSummary(row: CharacterRow): CCBCharacterSummary {
    const supplement = this.enrichment.readCharacter(row.id);
    return { id: row.id, name: supplement.name ?? row.name, nameCn: supplement.nameCn ?? (row.name_cn || row.name), imageUrl: this.enrichment.readImage(row.id) };
  }

  private async syncCharacterIndex(id: number): Promise<void> {
    const row = this.db.query("SELECT id,name,name_cn,aliases,comments,collects FROM characters WHERE id=?").get(id) as CharacterRow | null;
    if (!row || !this.search) return;
    const supplement = this.enrichment.readCharacter(id);
    await this.search.updateCharacter({
      id: row.id, name: supplement.name ?? row.name,
      aliases: [...new Set([supplement.nameCn ?? row.name_cn, ...supplement.aliases ?? JSON.parse(row.aliases) as string[]].filter(Boolean))],
      comment: row.comments, collect: row.collects, nsfw: false,
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new AppError("CCB_DATA_UNAVAILABLE", "本地角色查询已关闭");
  }
}
