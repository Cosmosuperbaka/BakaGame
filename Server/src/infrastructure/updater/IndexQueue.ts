import type { Database } from "bun:sqlite";
import type { BangumiSearchIndex } from "../BangumiSearchIndex";
import type { SubjectUpdaterLogger } from "./UpdaterLogger";

/** 索引待同步的失败次数上限：超过就丢弃（下一轮刷新会重新入队）。 */
const MAX_INDEX_ATTEMPTS = 5;

/**
 * 索引待同步队列：更新器落库后只登记条目编号，轮末批量写进搜索索引。
 * 队列表建在数据集里（与它描述的数据同生共死），建表由更新器统一初始化。
 */
export class IndexQueue {
  constructor(
    private readonly db: Database,
    private readonly search: BangumiSearchIndex | undefined,
    private readonly logger: SubjectUpdaterLogger | undefined
  ) {}

  /** 把待同步队列里的条目批量写进索引；失败计数，超过上限就丢弃。 */
  /**
   * 登记一个待同步条目。没有配置索引时队列根本不该存在，直接忽略；重复登记时
   * 登记时刻严格递增，让「读到的那一版」与之后的重新登记分得清先后。
   */
  enqueue(subjectId: number, now: number): void {
    if (!this.search) return;
    this.db
      .query<never, [number, number]>(
        "INSERT INTO bangumi_index_pending (subject_id, queued_at, attempts) VALUES (?,?,0)" +
          " ON CONFLICT(subject_id) DO UPDATE SET queued_at = max(excluded.queued_at, queued_at + 1)"
      )
      .run(subjectId, now);
  }

  async flush(limit: number): Promise<number> {
    const pending = this.db
      .query<{ subject_id: number; attempts: number; queued_at: number }, [number]>(
        "SELECT subject_id, attempts, queued_at FROM bangumi_index_pending ORDER BY queued_at ASC LIMIT ?"
      )
      .all(limit);
    if (!pending.length) return 0;
    // 没有配置索引时队列根本不该存在（入队处已挡），这里只兜底清理。
    if (!this.search) {
      this.db.exec("DELETE FROM bangumi_index_pending");
      return 0;
    }
    const ids = pending.map((row) => Number(row.subject_id));
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .query(
        `SELECT id,name,name_cn,aliases,tags,meta_tags,date,score,rating_count,heat,rank,type FROM subjects WHERE id IN (${placeholders})`
      )
      .all(...ids) as Array<Record<string, unknown>>;
    try {
      await this.search.updateSubjects(rows.map((row) => this.search!.toSubjectDocument(row)));
      // 只清掉「读到时的那一版」：等索引任务期间条目可能被重新入队（`queued_at` 严格递增），
      // 按编号清会抹掉它，新内容就永远进不了索引。队列里已被裁掉的条目随这批一并清掉。
      const clear = this.db.query<never, [number, number]>(
        "DELETE FROM bangumi_index_pending WHERE subject_id = ? AND queued_at = ?"
      );
      this.db.transaction(() => {
        for (const row of pending) clear.run(Number(row.subject_id), Number(row.queued_at));
      })();
      return rows.length;
    } catch (error) {
      this.logger?.warn?.(
        `索引同步失败：${error instanceof Error ? error.message : String(error)}`
      );
      for (const row of pending) {
        const attempts = Number(row.attempts) + 1;
        if (attempts >= MAX_INDEX_ATTEMPTS) {
          this.db
            .query("DELETE FROM bangumi_index_pending WHERE subject_id = ?")
            .run(Number(row.subject_id));
          continue;
        }
        this.db
          .query("UPDATE bangumi_index_pending SET attempts = ? WHERE subject_id = ?")
          .run(attempts, Number(row.subject_id));
      }
      return 0;
    }
  }
}
