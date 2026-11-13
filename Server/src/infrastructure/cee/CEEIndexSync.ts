import type { Database } from "bun:sqlite";
import type { BangumiSearchIndex } from "../BangumiSearchIndex";
import type { CEEEnrichment } from "../CEEEnrichment";
import type { CEEContext, CharacterRow } from "./Rows";

/** 已同步过索引的角色编号上限：超出后按插入顺序淘汰最旧的，避免长期运行后无限增长。 */
const SYNCED_CHARACTER_CAP = 8192;

/** 角色搜索索引的按需同步；未启用索引时直接空转。 */
export class CEEIndexSync {
  private readonly db: Database;
  private readonly enrichment: CEEEnrichment;
  private readonly search?: BangumiSearchIndex;
  /**
   * 本进程已同步过索引的角色编号。
   *
   * 补全带来的中文名与别名写进索引后长期生效，而 `cee.character.image` 在列表滚动时
   * 会逐卡片触发：每次都同步等于让「取一张图」附带一次 Meilisearch 任务等待
   * （`updateCharacter` 会等任务落定，数百毫秒到数秒），因此每个角色每进程只同步一次。
   */
  private readonly syncedCharacters = new Set<number>();

  constructor(ctx: CEEContext) {
    this.db = ctx.db;
    this.enrichment = ctx.enrichment;
    this.search = ctx.search;
  }

  /** 每个角色只同步一次索引；未启用索引时直接空转。 */
  async syncCharacterIndexOnce(id: number): Promise<void> {
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
    await this.search.updateCharacter(
      this.search.toCharacterDocument(row as unknown as Record<string, unknown>, supplement)
    );
  }
}
