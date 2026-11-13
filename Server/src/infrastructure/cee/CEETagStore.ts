import type { Database } from "bun:sqlite";

/** 角色标签的整组写入：增量应用与整表重建；事务内同步完成。 */
export class CEETagStore {
  constructor(private readonly db: Database) {}

  /**
   * 应用角色标签增量（上游 CCB-TagsCI 的 diff）。
   *
   * 同一角色的标签是**一整组**：`position` 是它在 id_tags 数组里的下标，原版按
   * `slice(0, characterTagNum)` 取前若干个，所以只能整组替换、不能逐条增删（会错位）。
   * `removed` 必须一起处理，否则留下指向不存在角色的悬空行。
   */
  applyTagChanges(replaced: Array<[number, string[]]>, removed: number[]): void {
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
   * 用全量产物整表重建角色标签：增量基线对不上时的唯一安全出路。
   * 单事务内先清后灌，任何一步失败都整体回滚，不会留下半张标签表。
   */
  replaceAllTags(entries: Array<[number, string[]]>): void {
    const insert = this.db.query("INSERT OR IGNORE INTO character_tags VALUES (?,?,?)");
    this.db.transaction(() => {
      this.db.query("DELETE FROM character_tags").run();
      for (const [characterId, tags] of entries) {
        tags.forEach((tag, position) => insert.run(characterId, position, tag));
      }
    })();
  }
}
