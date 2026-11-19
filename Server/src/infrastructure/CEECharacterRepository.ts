import type { Database } from "bun:sqlite";
import { openDataset } from "./OpenDataset";
import { discoverNewSubjects, type DiscoveryResult } from "./SubjectDiscovery";
import { AppError } from "../domain/Errors";
import type { CEERankedCandidate } from "../domain/CEERankedSolver";
import type {
  CEECharacterSummary,
  CEECharacterView,
  CEEDirectoryResult,
  CEEImageSize,
  CEESettings,
  CEESubjectSummary,
} from "../shared/CEE";
import type { CEEDataOptions, CEEDataProvider, CEERawCharacter } from "./CEEData";
import { CEEEnrichment } from "./CEEEnrichment";
import { BangumiSearchIndex } from "./BangumiSearchIndex";
import { CEESearch } from "./cee/CEECharacterSearch";
import { CEEIndexSync } from "./cee/CEEIndexSync";
import { CEEQuestionPicker } from "./cee/CEEQuestionPicker";
import { CEERawCharacterReader } from "./cee/CEERawCharacterReader";
import { CEETagStore } from "./cee/CEETagStore";
import { positiveId, type CEEContext } from "./cee/Rows";

/**
 * 生产环境由数据线程独占：SQLite 同步查询不会占用游戏主循环。
 *
 * 门面只持有两条连接（数据集与补全层）与生命周期，查询、抽样、标签与索引同步分在
 * `cee/` 下的各模块里。关闭顺序必须由门面统一：先排空在途资料请求，再关补全层，最后关数据集。
 */
export class CEECharacterRepository implements CEEDataProvider {
  private readonly db: Database;
  private readonly enrichment: CEEEnrichment;
  private readonly now: () => number;
  private readonly directoryImports = new Map<number, Promise<CEEDirectoryResult>>();
  private readonly search?: BangumiSearchIndex;
  private readonly ready: Promise<void>;
  private readonly searcher: CEESearch;
  private readonly reader: CEERawCharacterReader;
  private readonly picker: CEEQuestionPicker;
  private readonly tags: CEETagStore;
  private readonly indexSync: CEEIndexSync;
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
    this.search =
      options.search ??
      (options.meilisearch ? new BangumiSearchIndex(options.meilisearch) : undefined);
    this.ready = this.search?.initialize(this.db) ?? Promise.resolve();
    const context: CEEContext = {
      db: this.db,
      enrichment: this.enrichment,
      now: this.now,
      search: this.search,
    };
    this.searcher = new CEESearch(context);
    this.reader = new CEERawCharacterReader(context);
    this.picker = new CEEQuestionPicker(context, this.reader);
    this.tags = new CEETagStore(this.db);
    this.indexSync = new CEEIndexSync(context);
  }

  async initialize(): Promise<void> {
    await this.ready;
  }

  async searchCharacters(keyword: string, limit = 20): Promise<CEECharacterSummary[]> {
    this.assertOpen();
    await this.ready;
    return this.searcher.searchCharacters(keyword, limit);
  }

  async searchSubjects(
    keyword: string,
    limit = 20,
    types = [1, 2, 4, 6]
  ): Promise<CEESubjectSummary[]> {
    this.assertOpen();
    await this.ready;
    return this.searcher.searchSubjects(keyword, limit, types);
  }

  async getSubjects(subjectIds: number[]): Promise<CEESubjectSummary[]> {
    this.assertOpen();
    await this.ready;
    return this.searcher.getSubjects(subjectIds);
  }

  async getSubjectCharacters(subjectId: number, limit = 50): Promise<CEECharacterSummary[]> {
    this.assertOpen();
    await this.ready;
    return this.searcher.getSubjectCharacters(subjectId, limit);
  }

  /** 应用角色标签增量；细则见标签存取模块。 */
  async applyTagChanges(replaced: Array<[number, string[]]>, removed: number[]): Promise<void> {
    this.assertOpen();
    this.tags.applyTagChanges(replaced, removed);
  }

  /** 用全量产物整表重建角色标签。 */
  async replaceAllTags(entries: Array<[number, string[]]>): Promise<void> {
    this.assertOpen();
    this.tags.replaceAllTags(entries);
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
    return discoverNewSubjects({
      db: this.db,
      base,
      search: this.search,
      since,
      upstream: this.enrichment.upstream,
    });
  }

  async getRawCharacter(id: number): Promise<CEERawCharacter> {
    this.assertOpen();
    await this.ready;
    return this.reader.getRawCharacter(id);
  }

  async getCharacter(id: number, settings: CEESettings): Promise<CEECharacterView> {
    this.assertOpen();
    await this.ready;
    return this.reader.getCharacter(id, settings);
  }

  async chooseRandomCharacter(
    settings: CEESettings,
    random = Math.random
  ): Promise<CEECharacterView> {
    this.assertOpen();
    await this.ready;
    return this.picker.chooseRandomCharacter(settings, random);
  }

  async listRankedCandidates(settings: CEESettings): Promise<CEERankedCandidate[]> {
    this.assertOpen();
    await this.ready;
    return this.picker.listRankedCandidates(settings);
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
    await this.indexSync.syncCharacterIndexOnce(id);
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

  private assertOpen(): void {
    if (this.closed) throw new AppError("CEE_DATA_UNAVAILABLE", "本地角色查询已关闭");
  }
}
