/**
 * CCB 本地角色库读取。
 *
 * 只读 `Server/data/bangumi-character.sqlite`（LFS 产物，由 CI 每周重建）。
 *
 * **派生字段一律在这里运行时算**：登场作品与标签池都是「关联 × 作品」的函数，其中标签池
 * 还依赖房间设置 `gameSettings.metaTags`（决定只看哪几个大类）与「过滤后为空则回退全部类型」
 * 这条兜底 —— 物化任意一份都会把某一种设置写死（见 `Agents/BangumiApi.md §标签池禁止落库`）。
 * 原版在 `getCharacterAppearances` 里也是这么做的，这里只是把 axios 换成 SQLite。
 */

import { Database } from "bun:sqlite";

import {
  resolveCCBAppearanceTypes,
  resolveCCBSubjectSearchMetaTags,
  resolveCCBSubjectSearchTypes,
  type CCBCharacterView,
} from "../domain/CCBRules";
import type { CCBCharacterSearchResult, CCBGameSettings, CCBGender } from "../shared/Index";

/** 原版 `stuffFactor`：主角 3 倍、配角 1 倍；同时也定义了「哪些关联算登场作品」。 */
const MAIN_ROLE_TYPE = 1;
const SUPPORT_ROLE_TYPE = 2;
const MAIN_ROLE_FACTOR = 3;
const SUPPORT_ROLE_FACTOR = 1;

/** 来源标签单独收集、不参与普通标签计数（原版 `sourceTagSet` / `sourceTagMap`）。 */
const SOURCE_TAGS = new Set(["原创", "游戏改", "小说改", "漫画改"]);
const SOURCE_ALIASES = new Map([
  ["GAL改", "游戏改"],
  ["轻小说改", "小说改"],
  ["轻改", "小说改"],
  ["原创动画", "原创"],
  ["网文改", "小说改"],
  ["漫改", "漫画改"],
  ["漫画改编", "漫画改"],
  ["游戏改编", "游戏改"],
  ["小说改编", "小说改"],
]);
const REGION_TAGS = new Set([
  "日本", "欧美", "美国", "中国", "法国", "韩国", "英国", "俄罗斯",
  "中国香港", "苏联", "捷克", "中国台湾", "马来西亚",
]);
/** 原版 `getSubjectDetails` 只对动画(2)与游戏(4)填充 `details.tags`。 */
const TAGGED_SUBJECT_TYPES = new Set([2, 4]);
/** 原版的彩蛋：这 4 个角色的标签与声优里会各多一个「展开」。 */
const EASTER_EGG_CHARACTER_IDS = new Set([56822, 56823, 17529, 10956]);
const EASTER_EGG_TAG = "展开";

/** 原版 `getRandomCharacter` 的硬上限：`Math.min(topNSubjects, 1000)`。 */
const SUBJECT_POOL_LIMIT = 1000;
const SEARCH_LIMIT_MAX = 50;
/** FTS5 trigram 对短于 3 个字符的查询必然 0 命中，必须回退 LIKE。 */
const FTS_MIN_LENGTH = 3;

interface CharacterRow {
  name: string;
  name_cn: string;
  gender: string;
  collects: number;
  comments: number;
}

interface AppearanceQueryRow {
  subject_id: number;
  relation_type: number;
  subject_type: number;
  name: string;
  name_cn: string;
  date: string;
  raw_tags: string;
  meta_tags: string;
  rating: number;
  rating_count: number;
}

/** 一件登场作品的全部运行时派生信息。 */
interface AppearanceEntry {
  subjectId: number;
  subjectType: number;
  /** `null`＝作品无有效年份（原版 `details.year === null`），会被整条丢弃。 */
  year: number | null;
  rating: number;
  relationType: number;
  ratingCount: number;
  /** 原始 `date`，用于判「未上映」。 */
  date: string;
  name: string;
  nameCn: string;
  rawTags: Array<[string, number]>;
  metaTags: string[];
}

/** 通过年份与上映检查之后的登场作品。 */
type ValidAppearance = AppearanceEntry & { year: number };

export interface CCBCharacterRepositoryOptions {
  characterDbPath: string;
  /** 注入时钟，便于测试「未上映作品」的判定。 */
  now?: () => number;
  /** 注入随机源，便于测试两级采样。 */
  random?: () => number;
}

export interface CCBSubjectPick {
  id: number;
  name: string;
  nameCn: string;
}

export class CCBCharacterRepository {
  private readonly character: Database;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(options: CCBCharacterRepositoryOptions) {
    this.character = new Database(options.characterDbPath, { readonly: true });
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
  }

  close(): void {
    this.character.close();
  }

  // ==================== 出题：两级采样（原版 `getRandomCharacter`） ====================

  /**
   * 第一级：按大类 + 年份区间 + meta 过滤项抽一部作品。
   *
   * 线上是 `POST /v0/search/subjects { sort: "heat" }`，本地按 `subjects.heat` 降序取前
   * `min(topNSubjects, 1000)` 条再等概率抽一条 —— 与原版「随机 offset + 空批重试」的净效果一致。
   */
  pickRandomSubject(settings: CCBGameSettings): CCBSubjectPick | undefined {
    const types = resolveCCBSubjectSearchTypes(settings.metaTags);
    const metaFilter = resolveCCBSubjectSearchMetaTags(settings.metaTags);
    const today = this.localDate(this.now());

    const startYear = settings.startYear ?? 1900;
    const currentYear = Number(today.slice(0, 4));
    const endYear = Math.min(settings.endYear ?? currentYear, currentYear);
    if (endYear < startYear) return undefined;

    // 原版 `new Date(Math.min(endDate, today))`：区间上界不会超过今天，因此当天及以后的
    // 新作不会被抽到（这是原版对「未上映」的隐式过滤）。
    let lower: string;
    let upper: string;
    if (settings.useSubjectPerYear) {
      const span = endYear - startYear + 1;
      const year = startYear + Math.floor(this.random() * span);
      lower = `${year}-01-01`;
      upper = minDate(`${year + 1}-01-01`, today);
    } else {
      lower = `${startYear}-01-01`;
      upper = minDate(`${endYear + 1}-01-01`, today);
    }
    if (lower >= upper) return undefined;

    // `topNSubjects` 为 0 视为「不限」，但硬上限仍是 1000（原版就是这么夹的）。
    const poolLimit =
      settings.topNSubjects > 0
        ? Math.min(settings.topNSubjects, SUBJECT_POOL_LIMIT)
        : SUBJECT_POOL_LIMIT;

    const typePlaceholders = types.map(() => "?").join(",");
    const metaClauses = metaFilter.map(() => "AND meta_tags LIKE ? ESCAPE '\\'").join(" ");
    const params: Array<string | number> = [...types, lower, upper];
    for (const tag of metaFilter) params.push(`%"${escapeLike(tag)}"%`);
    params.push(poolLimit);

    const rows = this.character
      .query(
        `SELECT id, name, name_cn FROM subjects
         WHERE type IN (${typePlaceholders}) AND date >= ? AND date < ? ${metaClauses}
         ORDER BY heat DESC, id ASC LIMIT ?`,
      )
      .all(...(params as never[])) as Array<{ id: number; name: string; name_cn: string }>;
    if (rows.length === 0) return undefined;

    const picked = rows[Math.floor(this.random() * rows.length)]!;
    return { id: picked.id, name: picked.name, nameCn: picked.name_cn };
  }

  /**
   * 第二级：从作品的角色里抽一个。
   *
   * `mainCharacterOnly` 只取主角且**不截断**；否则取「主角 + 配角」的前 `characterNum` 个
   * （原版 `.filter(...).slice(0, characterNum)`），再等概率抽一个。
   */
  pickRandomCharacter(subjectId: number, settings: CCBGameSettings): number | undefined {
    const onlyMain = settings.mainCharacterOnly;
    const types = onlyMain ? [MAIN_ROLE_TYPE] : [MAIN_ROLE_TYPE, SUPPORT_ROLE_TYPE];
    const placeholders = types.map(() => "?").join(",");
    const limitClause = onlyMain ? "" : " LIMIT ?";
    const params: number[] = [subjectId, ...types];
    if (!onlyMain) params.push(Math.max(1, settings.characterNum));

    const rows = this.character
      .query(
        `SELECT character_id FROM character_subject_relations
         WHERE subject_id = ? AND relation_type IN (${placeholders})
         ORDER BY relation_order, character_id${limitClause}`,
      )
      .all(...(params as never[])) as Array<{ character_id: number }>;
    if (rows.length === 0) return undefined;

    return rows[Math.floor(this.random() * rows.length)]!.character_id;
  }

  // ==================== 反馈视图 ====================

  /** 组装原版 `getCharacterDetails` + `getCharacterAppearances` 的返回值。 */
  buildCharacterView(characterId: number, settings: CCBGameSettings): CCBCharacterView | undefined {
    const character = this.character
      .query<CharacterRow, [number]>(
        "SELECT name, name_cn, gender, collects, comments FROM characters WHERE id = ?",
      )
      .get(characterId);
    if (!character) return undefined;

    const entries = this.loadAppearances(characterId, settings);
    const ordered = [...entries].sort(
      (a, b) => b.ratingCount - a.ratingCount || a.subjectId - b.subjectId,
    );

    const characterTags = (
      this.character
        .query("SELECT tag FROM character_tags WHERE character_id = ? ORDER BY position")
        .all(characterId) as Array<{ tag: string }>
    ).map((row) => row.tag);

    const animeVAs = (
      this.character
        .query("SELECT name FROM character_vas WHERE character_id = ? ORDER BY position")
        .all(characterId) as Array<{ name: string }>
    ).map((row) => row.name);
    if (EASTER_EGG_CHARACTER_IDS.has(characterId)) animeVAs.push(EASTER_EGG_TAG);

    const years = ordered.map((entry) => entry.year);
    // 原版有两个不同的空集哨兵：一件作品关联都没有 → `highestRating: 0`；
    // 有关联但全被过滤掉 → 保持初始值 `-1`。两者在 `rating` 反馈里表现不同（0 参与比较，-1 给 `?`）。
    const hasAnyRelation =
      (
        this.character
          .query<{ n: number }, [number]>(
            "SELECT count(*) AS n FROM character_subject_relations WHERE character_id = ?",
          )
          .get(characterId) ?? { n: 0 }
      ).n > 0;

    const pools = this.derivePools(entries, characterId, settings, characterTags);

    return {
      id: characterId,
      name: character.name,
      nameCn: character.name_cn,
      gender: normalizeGender(character.gender),
      popularity: character.collects + character.comments,
      appearances: ordered.map((entry) => entry.name),
      appearancesCn: ordered.map((entry) => entry.nameCn || entry.name),
      appearanceIds: ordered.map((entry) => entry.subjectId),
      latestAppearance: years.length > 0 ? Math.max(...years) : -1,
      earliestAppearance: years.length > 0 ? Math.min(...years) : -1,
      highestRating: ordered.length > 0 ? Math.max(...ordered.map((e) => e.rating)) : hasAnyRelation ? -1 : 0,
      metaTags: pools.metaTags,
      rawTags: pools.rawTags,
      characterTags,
      animeVAs,
    };
  }

  // ==================== 角色检索 ====================

  /**
   * 按关键词检索角色。**短于 3 个字符必须走 LIKE 回退** ——
   * `character_search` 是 FTS5 trigram，`牧濑` 这类两字简称必然 0 命中。
   */
  searchCharacters(keyword: string, limit = 20): CCBCharacterSearchResult[] {
    const query = keyword.trim();
    if (!query) return [];
    const capped = Math.min(SEARCH_LIMIT_MAX, Math.max(1, limit));
    const fields = "c.id, c.name, c.name_cn, c.gender, c.collects, c.comments";
    const order = "ORDER BY c.collects DESC, c.id ASC LIMIT ?";

    if ([...query].length >= FTS_MIN_LENGTH) {
      // 与歌库检索同一套写法：先剔掉会破坏 FTS 语法的字符，再用前缀查询。
      const match = `${query.replace(/["*]/g, " ")}*`;
      return this.mapSearchRows(
        this.character
          .query(
            `SELECT ${fields} FROM character_search f JOIN characters c ON c.id = f.rowid
             WHERE character_search MATCH ? ${order}`,
          )
          .all(match, capped),
      );
    }

    const pattern = `%${escapeLike(query)}%`;
    return this.mapSearchRows(
      this.character
        .query(
          `SELECT ${fields} FROM characters c
           WHERE c.name LIKE ? ESCAPE '\\' OR c.name_cn LIKE ? ESCAPE '\\' OR c.aliases LIKE ? ESCAPE '\\'
           ${order}`,
        )
        .all(pattern, pattern, pattern, capped),
    );
  }

  private mapSearchRows(rows: unknown): CCBCharacterSearchResult[] {
    return (rows as Array<{
      id: number;
      name: string;
      name_cn: string;
      gender: string;
      collects: number;
      comments: number;
    }>).map((row) => ({
      id: row.id,
      name: row.name,
      nameCn: row.name_cn || row.name,
      gender: normalizeGender(row.gender),
      popularity: row.collects + row.comments,
    }));
  }

  // ==================== 内部：登场作品与标签池 ====================

  /**
   * 原版 `filteredAppearances` 的等价物：**先按大类过滤、为空则回退全部类型**，
   * 再丢弃「无年份」与「未上映」的作品（原版 `getSubjectDetails` 对这两类返回 null）。
   *
   * 顺序保持 dump 的 `subject_id` 升序 —— 这正是原版累积标签时依赖的顺序
   * （登场作品输出时的 `rating_count` 降序是另一回事，在调用处再排）。
   */
  private loadAppearances(characterId: number, settings: CCBGameSettings): ValidAppearance[] {
    const rows = this.character
      .query(
        `SELECT r.subject_id, r.relation_type, s.type AS subject_type, s.name, s.name_cn, s.date,
                s.raw_tags, s.meta_tags, s.score AS rating, s.rating_count
         FROM character_subject_relations r JOIN subjects s ON s.id = r.subject_id
         WHERE r.character_id = ? AND r.relation_type IN (?, ?)
         ORDER BY r.subject_id`,
      )
      .all(characterId, MAIN_ROLE_TYPE, SUPPORT_ROLE_TYPE) as AppearanceQueryRow[];

    const entries = rows.map<AppearanceEntry>((row) => ({
      subjectId: row.subject_id,
      subjectType: row.subject_type,
      year: parseYear(row.date),
      rating: row.rating,
      relationType: row.relation_type,
      ratingCount: row.rating_count,
      date: row.date,
      name: row.name,
      nameCn: row.name_cn,
      rawTags: parseTagCounts(row.raw_tags),
      metaTags: parseTagNames(row.meta_tags),
    }));

    const allowed = resolveCCBAppearanceTypes(settings.metaTags);
    const typed = entries.filter((entry) => allowed.includes(entry.subjectType));
    const scoped = typed.length > 0 ? typed : entries;

    const today = this.localDate(this.now());
    return scoped.filter(
      (entry): entry is ValidAppearance => entry.year !== null && !isFuture(entry.date, today),
    );
  }

  /** 标签池：`commonTags` 与默认模式是两套互斥的算法（原版 `getCharacterAppearances` 的分支）。 */
  private derivePools(
    entries: ValidAppearance[],
    characterId: number,
    settings: CCBGameSettings,
    characterTags: string[],
  ): { metaTags: string[]; rawTags: Array<[string, number]> } {
    return settings.commonTags
      ? { metaTags: [], rawTags: this.deriveRawTagPool(entries, settings) }
      : { metaTags: this.deriveMetaTagPool(entries, characterId, settings, characterTags), rawTags: [] };
  }

  /**
   * 默认模式的标签池（原版 `allMetaTags`）：
   * 「来源标签只取权重最高的一个」+「meta 标签按权重补足到 `subjectTagNum`」+
   * 「普通标签接着补」+「角色标签取前 `characterTagNum` 个」+「地区标签全收」。
   */
  private deriveMetaTagPool(
    entries: ValidAppearance[],
    characterId: number,
    settings: CCBGameSettings,
    characterTags: string[],
  ): string[] {
    const sourceCounts = new Map<string, number>();
    const tagCounts = new Map<string, number>();
    const metaCounts = new Map<string, number>();
    const regionTags = new Set<string>();

    for (const entry of entries) {
      const stuff = entry.relationType === MAIN_ROLE_TYPE ? MAIN_ROLE_FACTOR : SUPPORT_ROLE_FACTOR;

      for (const tag of entry.metaTags) {
        if (SOURCE_TAGS.has(tag)) continue;
        if (REGION_TAGS.has(tag)) {
          regionTags.add(tag);
          continue;
        }
        // 权重取「同名普通标签已累积的计数」，没有则退回本次的 stuffFactor —— 因此
        // 累积顺序（作品顺序）会影响结果。
        metaCounts.set(tag, (metaCounts.get(tag) ?? 0) + (tagCounts.get(tag) || stuff));
      }

      if (!TAGGED_SUBJECT_TYPES.has(entry.subjectType)) continue;
      for (const [name, count] of entry.rawTags) {
        if (!name || name.includes("20")) continue;
        if (SOURCE_TAGS.has(name)) bump(sourceCounts, name, count * stuff);
        else if (REGION_TAGS.has(name)) regionTags.add(name);
        else if (SOURCE_ALIASES.has(name)) bump(sourceCounts, SOURCE_ALIASES.get(name)!, count * stuff);
        else if (regionTags.has(name)) continue;
        else bump(tagCounts, name, count * stuff);
      }
    }

    const all = new Set<string>();
    const topSource = sortByWeightDesc(sourceCounts)[0];
    if (topSource !== undefined) all.add(topSource);
    for (const tag of sortByWeightDesc(metaCounts)) {
      if (all.size >= settings.subjectTagNum) break;
      all.add(tag);
    }
    for (const tag of sortByWeightDesc(tagCounts)) {
      if (all.size >= settings.subjectTagNum) break;
      all.add(tag);
    }
    for (const tag of characterTags.slice(0, settings.characterTagNum)) all.add(tag);
    for (const tag of regionTags) all.add(tag);
    if (EASTER_EGG_CHARACTER_IDS.has(characterId)) all.add(EASTER_EGG_TAG);
    return [...all];
  }

  /**
   * `commonTags` 模式的候选池（原版 `sortedRawTags`）：
   * 只用作品的**全量** `raw_tags`（不按类型过滤、不剔年份标签），合并最高权重来源标签后，
   * 按权重降序、剔除含 "20" 的名字，再按 10% 阈值或 `subjectTagNum` 截断。
   */
  private deriveRawTagPool(
    entries: ValidAppearance[],
    settings: CCBGameSettings,
  ): Array<[string, number]> {
    const sourceCounts = new Map<string, number>();
    const rawTags = new Map<string, number>();

    for (const entry of entries) {
      const stuff = entry.relationType === MAIN_ROLE_TYPE ? MAIN_ROLE_FACTOR : SUPPORT_ROLE_FACTOR;
      for (const [name, count] of entry.rawTags) {
        if (!name) continue;
        if (SOURCE_TAGS.has(name)) bump(sourceCounts, name, stuff * count);
        else if (SOURCE_ALIASES.has(name)) bump(sourceCounts, SOURCE_ALIASES.get(name)!, stuff * count);
        else bump(rawTags, name, stuff * count);
      }
    }

    const topSource = sortByWeightDesc(sourceCounts)[0];
    if (topSource !== undefined) bump(rawTags, topSource, sourceCounts.get(topSource)!);

    const sorted = [...rawTags.entries()]
      .filter(([name]) => !name.includes("20"))
      .sort((a, b) => b[1] - a[1]);
    const maxCount = sorted[0]?.[1] ?? 0;
    const threshold = maxCount * 0.1;
    const cutoff = sorted.findIndex(([, count]) => count < threshold);
    // 原版是 `Math.max(cutoffIndex, subjectTagNum)`，而 `findIndex` 找不到时返回 **-1**
    // —— 于是「没有任何标签低于阈值」时会退化成只留 `subjectTagNum` 个，必须照抄。
    return sorted.slice(0, Math.max(cutoff, settings.subjectTagNum));
  }

  private localDate(timestamp: number): string {
    const date = new Date(timestamp);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  }
}

const bump = (counts: Map<string, number>, key: string, delta: number): void => {
  counts.set(key, (counts.get(key) ?? 0) + delta);
};

/** 按权重降序；同权重保持首次出现顺序（等价于 JS `Array.prototype.sort` 的稳定性）。 */
const sortByWeightDesc = (counts: Map<string, number>): string[] =>
  [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);

const minDate = (a: string, b: string): string => (a < b ? a : b);

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (char) => `\\${char}`);

/** 非法 `date` 等价于原版 `details.year === null`，该作品会被整条丢弃。 */
const parseYear = (date: string): number | null => {
  const head = (date ?? "").slice(0, 4);
  return /^\d{4}$/.test(head) ? Number(head) : null;
};

/**
 * 未上映：按 ISO 前缀做字典序比较。
 * 原版是 `new Date(airDate) > new Date()`，对「只有年月」的日期会退化成当月 1 日，
 * 前缀比较在日期粒度上与之一致（当天不算未来）。
 */
const isFuture = (date: string, today: string): boolean => date !== "" && date.slice(0, 10) > today;

const parseTagCounts = (json: string): Array<[string, number]> => {
  try {
    const parsed = JSON.parse(json) as Record<string, number>;
    return Object.entries(parsed).filter(([name]) => name.length > 0);
  } catch {
    return [];
  }
};

const parseTagNames = (json: string): string[] => {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string" && tag.length > 0) : [];
  } catch {
    return [];
  }
};

const normalizeGender = (raw: string): CCBGender =>
  raw === "male" || raw === "female" ? raw : "?";
