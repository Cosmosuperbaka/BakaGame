import { Database } from "bun:sqlite";
import { openDataset } from "./OpenDataset";
import { discoverNewSubjects, type DiscoveryResult } from "./SubjectDiscovery";
import { AppError } from "../domain/Errors";
import type { CEERankedCandidate } from "../domain/CEERankedSolver";
import type {
  CEECharacterSummary,
  CEECharacterView,
  CEEDirectoryResult,
  CEEExtraTagSection,
  CEEImageSize,
  CEESettings,
  CEESubjectSummary,
} from "../shared/CEE";
import type { CEEDataOptions, CEEDataProvider, CEERawAppearance, CEERawCharacter } from "./CEEData";
import { CEEEnrichment } from "./CEEEnrichment";
import { deriveCEECharacter, resolveCEESubjectTypes } from "./CEECharacterDerivation";
import { BangumiSearchIndex } from "./BangumiSearchIndex";

interface CharacterRow {
  id: number;
  name: string;
  name_cn: string;
  gender: string;
  aliases: string;
  summary: string;
  comments: number;
  collects: number;
}
interface SubjectRow {
  id: number;
  type: number;
  name: string;
  name_cn: string;
  date: string;
  raw_tags: string;
  meta_tags: string;
  score: number;
  rating_count: number;
  heat: number;
  relation_type?: number;
}
const boundedLimit = (limit: number, maximum = 50) =>
  Math.min(maximum, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 20));
const like = (keyword: string) => `%${keyword.replace(/[\\%_]/g, "\\$&")}%`;
const positiveId = (id: number) => Number.isSafeInteger(id) && id > 0;
const validTypes = (types: number[]) =>
  [...new Set(types)].filter((type) => [1, 2, 3, 4, 6].includes(type));

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

/** 出题随机落点：把 `[0,1)` 的随机数折算成某个集合的下标（越界夹到端点）。 */
type SubjectRoll = (size: number) => number;

/** 年份模式里已经抽到的落点：年份、年份上界与热度榜下标。 */
interface YearSubjectDraw {
  settings: CEESettings;
  year: number;
  endYear: number;
  index: number;
}

/** Galgame 条目名本身就是标签，直接锁定这一档；其余只剔除平台类目噪音标签。 */
const subjectMetaTags = (metaTags: string[]): string[] =>
  metaTags[0] === "Galgame"
    ? ["Galgame"]
    : metaTags.filter((tag) => tag && !["游戏", "书籍", "三次元", "全部"].includes(tag));

/** 已同步过索引的角色编号上限：超出后按插入顺序淘汰最旧的，避免长期运行后无限增长。 */
const SYNCED_CHARACTER_CAP = 8192;

/** 生产环境由 CEECharacterWorker 独占：SQLite 同步查询不会占用游戏主循环。 */
export class CEECharacterRepository implements CEEDataProvider {
  private readonly db: Database;
  private readonly enrichment: CEEEnrichment;
  private readonly now: () => number;
  private readonly directoryImports = new Map<number, Promise<CEEDirectoryResult>>();
  private readonly search?: BangumiSearchIndex;
  private readonly ready: Promise<void>;
  /**
   * 本进程已同步过索引的角色编号。
   *
   * 补全带来的中文名与别名写进索引后长期生效，而 `cee.character.image` 在列表滚动时
   * 会逐卡片触发：每次都同步等于让「取一张图」附带一次 Meilisearch 任务等待
   * （`updateCharacter` 会等任务落定，数百毫秒到数秒），因此每个角色每进程只同步一次。
   */
  private readonly syncedCharacters = new Set<number>();
  private closed = false;

  constructor(options: CEEDataOptions) {
    this.db = openDataset(options.dbPath, options.readonly);
    try {
      this.enrichment = new CEEEnrichment(options);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.now = options.now ?? Date.now;
    this.search = options.meilisearch ? new BangumiSearchIndex(options.meilisearch) : undefined;
    this.ready = this.search?.initialize(this.db, options.dbPath) ?? Promise.resolve();
  }

  async initialize(): Promise<void> {
    await this.ready;
  }

  async searchCharacters(keyword: string, limit = 20): Promise<CEECharacterSummary[]> {
    this.assertOpen();
    await this.ready;
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
      return row ? [this.toSummary(row)] : [];
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
    const phrase = `"${query.replace(/"/g, '""')}"`;
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
    const candidates = rows.map((row) => ({ row, summary: this.toSummary(row) }));
    if (query) candidates.sort((a, b) => compareCharacterMatchRank(a, b, query));
    return candidates.slice(0, count).map(({ summary }) => summary);
  }

  async searchSubjects(
    keyword: string,
    limit = 20,
    types = [1, 2, 4, 6]
  ): Promise<CEESubjectSummary[]> {
    this.assertOpen();
    await this.ready;
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
        return row ? [this.toSubject(row)] : [];
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
    return rows.map((row) => this.toSubject(row));
  }

  async getSubjects(subjectIds: number[]): Promise<CEESubjectSummary[]> {
    this.assertOpen();
    await this.ready;
    const ids = [...new Set(subjectIds.filter(positiveId))].slice(0, 500);
    if (!ids.length) return [];
    const rows = this.db
      .query(`SELECT * FROM subjects WHERE nsfw=0 AND id IN (${ids.map(() => "?").join(",")})`)
      .all(...ids) as SubjectRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [this.toSubject(row)] : [];
    });
  }

  async getSubjectCharacters(subjectId: number, limit = 50): Promise<CEECharacterSummary[]> {
    this.assertOpen();
    await this.ready;
    if (!positiveId(subjectId)) throw new AppError("CEE_SUBJECT_NOT_FOUND", "作品不存在");
    const rows = this.db
      .query(
        `SELECT c.* FROM character_subject_relations r JOIN characters c ON c.id=r.character_id
      JOIN subjects s ON s.id=r.subject_id WHERE r.subject_id=? AND r.relation_type IN (1,2) AND s.nsfw=0
      ORDER BY r.relation_order,c.id LIMIT ?`
      )
      .all(subjectId, boundedLimit(limit, 100)) as CharacterRow[];
    return rows.map((row) => this.toSummary(row));
  }

  /**
   * 应用角色标签增量（上游 CCB-TagsCI 的 diff）。
   *
   * 同一角色的标签是**一整组**：`position` 是它在 id_tags 数组里的下标，原版按
   * `slice(0, characterTagNum)` 取前若干个，所以只能整组替换、不能逐条增删（会错位）。
   * `removed` 必须一起处理，否则留下指向不存在角色的悬空行。
   */
  async applyTagChanges(replaced: Array<[number, string[]]>, removed: number[]): Promise<void> {
    this.assertOpen();
    const apply = this.db.transaction(() => {
      for (const [characterId, tags] of replaced) {
        this.db.query("DELETE FROM character_tags WHERE character_id=?").run(characterId);
        tags.forEach((tag, position) => {
          this.db
            .query("INSERT OR IGNORE INTO character_tags VALUES (?,?,?)")
            .run(characterId, position, tag);
        });
      }
      for (const characterId of removed) {
        this.db.query("DELETE FROM character_tags WHERE character_id=?").run(characterId);
      }
    });
    apply();
  }

  /**
   * 发现并导入新条目（每日维护调用）。
   *
   * 数据集是构建产物，两份 dump 之间新出的作品不会自己出现 —— 没有这一步，
   * 搜索永远搜不到新番。判据与全量构建一致：没角色也没关联音乐的直接跳过。
   */
  async discoverNewSubjects(base: string, since?: string): Promise<DiscoveryResult> {
    this.assertOpen();
    await this.ready;
    return discoverNewSubjects({ db: this.db, base, search: this.search, since });
  }

  async getRawCharacter(id: number): Promise<CEERawCharacter> {
    this.assertOpen();
    await this.ready;
    if (!positiveId(id)) throw new AppError("CEE_CHARACTER_NOT_FOUND", "本地角色资料不存在");
    const row = this.db.query("SELECT * FROM characters WHERE id=?").get(id) as CharacterRow | null;
    if (!row) throw new AppError("CEE_CHARACTER_NOT_FOUND", "本地角色资料不存在");
    const supplement = this.enrichment.readCharacter(id);
    const appearances = this.db
      .query(
        `SELECT s.*,r.relation_type FROM character_subject_relations r JOIN subjects s ON s.id=r.subject_id
      WHERE r.character_id=? AND r.relation_type IN (1,2) AND s.nsfw=0 ORDER BY r.subject_id LIMIT 2001`
      )
      .all(id) as SubjectRow[];
    if (appearances.length > 2000)
      throw new AppError("CEE_CHARACTER_TOO_LARGE", "角色登场作品过多，无法用于本局");
    const tags = this.db
      .query<{ tag: string }, [number]>(
        "SELECT tag FROM character_tags WHERE character_id=? ORDER BY position"
      )
      .all(id);
    const voices = this.db
      .query<{ name: string }, [number]>(
        "SELECT name FROM character_vas WHERE character_id=? ORDER BY position"
      )
      .all(id);
    const extraRows = this.db
      .query<{ subject_id: number; section: string; tag: string }, [number]>(
        "SELECT subject_id,section,tag FROM character_extra_tags WHERE character_id=? ORDER BY subject_id,section_position,tag_position"
      )
      .all(id);
    const extraTagsBySubject: Record<number, CEEExtraTagSection[]> = {};
    for (const row of extraRows) {
      const sections = (extraTagsBySubject[row.subject_id] ??= []);
      let section = sections.at(-1);
      if (!section || section.section !== row.section) {
        section = { section: row.section, tags: [] };
        sections.push(section);
      }
      section.tags.push(row.tag);
    }
    return {
      ...this.toSummary(row),
      aliases: supplement.aliases ?? (JSON.parse(row.aliases) as string[]),
      gender:
        supplement.gender ?? (row.gender === "male" || row.gender === "female" ? row.gender : "?"),
      popularity: supplement.popularity ?? row.collects + row.comments,
      summary: supplement.summary ?? row.summary,
      appearances: appearances.map((item): CEERawAppearance => ({
        id: item.id,
        type: item.type,
        name: item.name,
        nameCn: item.name_cn || item.name,
        date: item.date,
        relationType: item.relation_type!,
        rating: item.score,
        ratingCount: item.rating_count,
        heat: item.heat,
        rawTags: JSON.parse(item.raw_tags) as Record<string, number>,
        metaTags: JSON.parse(item.meta_tags) as string[],
      })),
      characterTags: tags.map((item) => item.tag),
      voiceActors: [...new Set(voices.map((item) => item.name))],
      extraTagsBySubject,
    };
  }

  async getCharacter(id: number, settings: CEESettings): Promise<CEECharacterView> {
    return deriveCEECharacter(await this.getRawCharacter(id), settings, this.now());
  }

  async chooseRandomCharacter(
    settings: CEESettings,
    random = Math.random
  ): Promise<CEECharacterView> {
    this.assertOpen();
    await this.ready;
    const roll = (size: number) => Math.min(size - 1, Math.max(0, Math.floor(random() * size)));
    const subjectId = settings.useIndex
      ? this.pickSubjectFromDirectory(settings, roll)
      : this.pickSubjectByYearRange(settings, roll);
    return this.pickCharacterOfSubject(subjectId, settings, roll);
  }

  /** 目录模式：从「目录内本地可用作品 + 手动追加作品」里抽一部。 */
  private pickSubjectFromDirectory(settings: CEESettings, roll: SubjectRoll): number {
    const directory = settings.indexId ? this.enrichment.getDirectory(settings.indexId) : undefined;
    if (!directory) throw new AppError("CEE_DIRECTORY_NOT_IMPORTED", "请先导入目录再开始游戏");
    const ids = [...directory.subjectIds, ...settings.addedSubjects];
    if (!ids.length) throw new AppError("CEE_NO_SUBJECT", "目录中没有本地可用作品");
    return ids[roll(ids.length)];
  }

  /**
   * 年份模式：`roll` 的调用顺序与抽取路径一一对应 ——
   * 按年抽时先定年份，再定「热度榜下标还是追加作品」，最后才落到作品本身。
   */
  private pickSubjectByYearRange(settings: CEESettings, roll: SubjectRoll): number {
    const currentYear = new Date(this.now()).getUTCFullYear();
    const endYear = Math.min(currentYear, settings.endYear);
    if (endYear < settings.startYear)
      throw new AppError("CEE_NO_SUBJECT", "年份范围内没有已上映作品");
    const yearCount = endYear - settings.startYear + 1;
    const year = settings.useSubjectPerYear
      ? settings.startYear + roll(yearCount)
      : settings.startYear;
    const baseCount = settings.topNSubjects * (settings.useSubjectPerYear ? yearCount : 1);
    const index = roll(baseCount + settings.addedSubjects.length);
    if (index >= baseCount) return settings.addedSubjects[index - baseCount];
    return this.pickSubjectFromHeatPool({ settings, year, endYear, index }, roll);
  }

  /**
   * 按标签与年份窗口取热度榜候选作品编号（热度降序、同热度按编号升序）。
   *
   * 抽取与排位题库共用这一条口径：排位要把整档作品铺开算权重，若另写一份 SQL，
   * 两边的「哪些作品算主角作品」迟早会分叉。
   */
  private heatPoolSubjectIds(settings: CEESettings, year: number, endYear: number): number[] {
    const types = resolveCEESubjectTypes(settings.metaTags, true);
    const tags = subjectMetaTags(settings.metaTags);
    const endDate = `${settings.useSubjectPerYear ? year + 1 : endYear + 1}-01-01`;
    const rows = this.db
      .query(
        `SELECT s.id FROM subjects s WHERE s.nsfw=0 AND s.type IN (${types.map(() => "?").join(",")})
      AND s.date>=? AND s.date<? AND s.date<=?
      ${tags.map(() => "AND EXISTS(SELECT 1 FROM json_each(s.meta_tags) WHERE value=?)").join(" ")}
      ORDER BY s.heat DESC,s.id LIMIT ?`
      )
      .all(
        ...types,
        `${year}-01-01`,
        endDate,
        new Date(this.now()).toISOString().slice(0, 10),
        ...tags,
        settings.topNSubjects
      ) as { id: number }[];
    return rows.map((row) => row.id);
  }

  /** 热度榜里按抽到的下标落一部作品；下标越界或按年抽时改在候选内随机。 */
  private pickSubjectFromHeatPool(draw: YearSubjectDraw, roll: SubjectRoll): number {
    const { settings, year, endYear, index } = draw;
    const ids = this.heatPoolSubjectIds(settings, year, endYear);
    if (!ids.length) throw new AppError("CEE_NO_SUBJECT", "选不到符合条件的作品，请调整范围");
    return ids[settings.useSubjectPerYear || index >= ids.length ? roll(ids.length) : index];
  }

  /**
   * 一部作品里符合主角口径的角色编号。
   *
   * 主角模式下多取一条（`LIMIT 2001`）而不是直接夹到 2000：超限时抽取要报错、
   * 排位要跳过整部作品，两边都需要知道「确实超过 2000」而不是「恰好 2000」。
   */
  private subjectCharacterIds(subjectId: number, settings: CEESettings): number[] {
    const relation = settings.mainCharacterOnly ? "r.relation_type=1" : "r.relation_type IN (1,2)";
    return (
      this.db
        .query(
          `SELECT c.id FROM character_subject_relations r JOIN characters c ON c.id=r.character_id
        WHERE r.subject_id=? AND ${relation} ORDER BY r.relation_order,c.id LIMIT ?`
        )
        .all(subjectId, settings.mainCharacterOnly ? 2001 : settings.characterNum) as {
        id: number;
      }[]
    ).map((row) => row.id);
  }

  /** 从选定作品的登场角色里抽一个。 */
  private async pickCharacterOfSubject(
    subjectId: number,
    settings: CEESettings,
    roll: SubjectRoll
  ): Promise<CEECharacterView> {
    const subject = this.db.query("SELECT id FROM subjects WHERE id=? AND nsfw=0").get(subjectId);
    if (!subject) throw new AppError("CEE_SUBJECT_NOT_FOUND", "指定作品不在本地可用数据集中");
    const candidates = this.subjectCharacterIds(subjectId, settings);
    if (candidates.length > 2000)
      throw new AppError("CEE_SUBJECT_TOO_LARGE", "作品主角数量过多，请调整出题范围");
    if (!candidates.length)
      throw new AppError("CEE_NO_CHARACTER", "选到的作品没有符合条件的本地角色");
    return this.getCharacter(candidates[roll(candidates.length)], settings);
  }

  /**
   * 排位题库：把固定参数档下的全部主角铺开，并给出每位角色被抽为答案的先验权重。
   *
   * 权重口径与抽取一致 —— 先均匀抽一部作品，再在该作品主角里均匀抽一位，
   * 所以每部作品的主角数为 n、参与作品数为 S 时每位加 `1/(S×n)`；同一角色
   * 出现在多部作品里时权重累加（他在每次抽取里都有更多机会被抽到）。
   */
  async listRankedCandidates(settings: CEESettings): Promise<CEERankedCandidate[]> {
    this.assertOpen();
    await this.ready;
    if (
      settings.useIndex ||
      settings.useSubjectPerYear ||
      settings.addedSubjects.length > 0 ||
      !settings.mainCharacterOnly
    )
      throw new AppError("CEE_RANKED_SETTINGS_INVALID", "排位题库只支持固定参数档");
    const currentYear = new Date(this.now()).getUTCFullYear();
    const endYear = Math.min(currentYear, settings.endYear);
    const leadsBySubject: number[][] = [];
    for (const subjectId of this.heatPoolSubjectIds(settings, settings.startYear, endYear)) {
      const leads = this.subjectCharacterIds(subjectId, settings);
      // 与抽取同口径：超限或无主角的作品不出题，也就不参与权重分配（S 只数留下的作品）
      if (!leads.length || leads.length > 2000) continue;
      leadsBySubject.push(leads);
    }
    if (!leadsBySubject.length)
      throw new AppError("CEE_NO_SUBJECT", "选不到符合条件的作品，请调整范围");
    const weights = new Map<number, number>();
    for (const leads of leadsBySubject) {
      const share = 1 / (leadsBySubject.length * leads.length);
      for (const id of leads) weights.set(id, (weights.get(id) ?? 0) + share);
    }
    const candidates: CEERankedCandidate[] = [];
    for (const [id, weight] of [...weights].sort(([a], [b]) => a - b)) {
      candidates.push({ weight, character: await this.getCharacter(id, settings) });
    }
    return candidates;
  }

  async importDirectory(indexId: number): Promise<CEEDirectoryResult> {
    this.assertOpen();
    await this.ready;
    if (!positiveId(indexId)) throw new AppError("CEE_DIRECTORY_INVALID", "目录编号无效");
    const running = this.directoryImports.get(indexId);
    if (running) return structuredClone(await running);
    const request = this.loadDirectory(indexId).finally(() =>
      this.directoryImports.delete(indexId)
    );
    this.directoryImports.set(indexId, request);
    return structuredClone(await request);
  }

  private async loadDirectory(indexId: number): Promise<CEEDirectoryResult> {
    const ids = await this.enrichment.fetchDirectory(indexId);
    const available = new Set<number>();
    if (ids.length) {
      const rows = this.db
        .query(`SELECT id FROM subjects WHERE nsfw=0 AND id IN (${ids.map(() => "?").join(",")})`)
        .all(...ids) as { id: number }[];
      for (const row of rows) available.add(row.id);
    }
    const result: CEEDirectoryResult = {
      id: indexId,
      subjectIds: ids.filter((id) => available.has(id)),
      missingSubjectIds: ids.filter((id) => !available.has(id)),
      importedAt: this.now(),
    };
    this.enrichment.saveDirectory(result);
    return result;
  }

  async resolveCharacterImage(
    id: number,
    size: CEEImageSize = "large"
  ): Promise<string | undefined> {
    this.assertOpen();
    await this.ready;
    if (!positiveId(id) || !this.db.query("SELECT id FROM characters WHERE id=?").get(id))
      return undefined;
    const imageUrl = await this.enrichment.resolveCharacterImage(id, size);
    await this.syncCharacterIndexOnce(id);
    return imageUrl;
  }

  async resolveSubjectImage(id: number, size: CEEImageSize = "large"): Promise<string | undefined> {
    this.assertOpen();
    await this.ready;
    if (!positiveId(id) || !this.db.query("SELECT id FROM subjects WHERE id=? AND nsfw=0").get(id))
      return undefined;
    return this.enrichment.resolveSubjectImage(id, size);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([this.ready, ...this.directoryImports.values()]);
    await this.enrichment.close();
    this.db.close();
  }

  /** 封面只读已回填的那份，不在列表查询里回源；缺的由客户端按需经 `cee.subject.image` 补。 */
  private toSubject(row: SubjectRow): CEESubjectSummary {
    const imageUrl = this.enrichment.readImage(row.id, "subject");
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      nameCn: row.name_cn || row.name,
      year: /^\d{4}/.test(row.date) ? Number(row.date.slice(0, 4)) : null,
      rating: row.score,
      heat: row.heat,
      ...(imageUrl ? { imageUrl } : {}),
    };
  }

  /** 搜索列表是 36~40px 的方形框：取方格图，避免竖版大图被裁到只剩头顶。 */
  private toSummary(row: CharacterRow): CEECharacterSummary {
    const supplement = this.enrichment.readCharacter(row.id);
    return {
      id: row.id,
      name: supplement.name ?? row.name,
      nameCn: supplement.nameCn ?? (row.name_cn || row.name),
      imageUrl: this.enrichment.readImage(row.id, "character", "grid"),
    };
  }

  /** 每个角色只同步一次索引；未启用索引时直接空转。 */
  private async syncCharacterIndexOnce(id: number): Promise<void> {
    if (!this.search || this.syncedCharacters.has(id)) return;
    await this.syncCharacterIndex(id);
    if (this.syncedCharacters.size >= SYNCED_CHARACTER_CAP) {
      const oldest = this.syncedCharacters.values().next().value;
      if (oldest !== undefined) this.syncedCharacters.delete(oldest);
    }
    this.syncedCharacters.add(id);
  }

  private async syncCharacterIndex(id: number): Promise<void> {
    const row = this.db
      .query("SELECT id,name,name_cn,aliases,comments,collects FROM characters WHERE id=?")
      .get(id) as CharacterRow | null;
    if (!row || !this.search) return;
    const supplement = this.enrichment.readCharacter(id);
    await this.search.updateCharacter({
      id: row.id,
      name: supplement.name ?? row.name,
      aliases: [
        ...new Set(
          [
            supplement.nameCn ?? row.name_cn,
            ...(supplement.aliases ?? (JSON.parse(row.aliases) as string[])),
          ].filter(Boolean)
        ),
      ],
      comment: row.comments,
      collect: row.collects,
      nsfw: false,
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new AppError("CEE_DATA_UNAVAILABLE", "本地角色查询已关闭");
  }
}
