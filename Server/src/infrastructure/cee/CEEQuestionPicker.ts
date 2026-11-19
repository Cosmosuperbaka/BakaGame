import type { Database } from "bun:sqlite";
import { AppError } from "../../domain/Errors";
import type { CEERankedCandidate } from "../../domain/CEERankedSolver";
import type { CEECharacterView, CEESettings } from "../../shared/CEE";
import type { CEEEnrichment } from "../CEEEnrichment";
import { resolveCEESubjectTypes } from "../CEECharacterDerivation";
import type { CEEContext } from "./Rows";
import type { CEERawCharacterReader } from "./CEERawCharacterReader";

/** 铺开排位题库时每处理这么多角色让出一次事件循环。 */
const RANKED_YIELD_EVERY = 50;

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

/** 出题抽样与排位题库：先选作品、再选角色；热度池 SQL 只写一份，抽取与排位共用。 */
export class CEEQuestionPicker {
  private readonly db: Database;
  private readonly enrichment: CEEEnrichment;
  private readonly now: () => number;
  private readonly reader: CEERawCharacterReader;

  constructor(ctx: CEEContext, reader: CEERawCharacterReader) {
    this.db = ctx.db;
    this.enrichment = ctx.enrichment;
    this.now = ctx.now;
    this.reader = reader;
  }

  async chooseRandomCharacter(
    settings: CEESettings,
    random = Math.random
  ): Promise<CEECharacterView> {
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
    return this.reader.getCharacter(candidates[roll(candidates.length)], settings);
  }

  /**
   * 排位题库：把固定参数档下的全部主角铺开，并给出每位角色被抽为答案的先验权重。
   *
   * 权重口径与抽取一致 —— 先均匀抽一部作品，再在该作品主角里均匀抽一位，
   * 所以每部作品的主角数为 n、参与作品数为 S 时每位加 `1/(S×n)`；同一角色
   * 出现在多部作品里时权重累加（他在每次抽取里都有更多机会被抽到）。
   */
  async listRankedCandidates(settings: CEESettings): Promise<CEERankedCandidate[]> {
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
      candidates.push({ weight, character: await this.reader.getCharacter(id, settings) });
      // getCharacter 内部只有微任务级等待，整个循环不会让出线程：数据线程在这期间对其他请求
      // （猜歌查询、搜索、头像）完全失声。周期性让出一个宏任务，让它们能插队被处理。
      if (candidates.length % RANKED_YIELD_EVERY === 0) await Bun.sleep(0);
    }
    return candidates;
  }
}
