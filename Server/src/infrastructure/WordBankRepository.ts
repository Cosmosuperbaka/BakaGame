import { sql } from "drizzle-orm";

import { normalizeWordPair } from "../domain/Rules";
import type { Database } from "./db/Database";
import { wordPair } from "./db/Schema";

/** 出题人提交过的词对仓储：只追加，重复提交累加使用次数。 */
export interface WordBankRepository {
  savePair(pair: [string, string]): Promise<void>;
  /** 等待已发起的写入落定（停机排空用）。 */
  drainWrites(): Promise<void>;
}

export class DatabaseWordBankRepository implements WordBankRepository {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly database: Database) {}

  savePair(pair: [string, string]): Promise<void> {
    const [wordA, wordB] = normalizeWordPair(pair);
    const operation = this.database.ready.then(async () => {
      await this.database.db
        .insert(wordPair)
        .values({ wordA, wordB })
        .onDuplicateKeyUpdate({
          set: { useCount: sql`${wordPair.useCount} + 1`, lastUsedAt: new Date() },
        });
    });
    // 跟踪用的 Promise 没有调用方持有：吞掉拒绝，失败只经返回的 operation 上报一次，
    // 否则每次写库失败都会多出一条未处理拒绝。
    const tracked: Promise<void> = operation
      .catch(() => undefined)
      .finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
    return operation;
  }

  async drainWrites(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }
}
