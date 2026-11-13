import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { BangumiSearchIndex } from "../src/infrastructure/BangumiSearchIndex";
import type { CEEEnrichment } from "../src/infrastructure/CEEEnrichment";
import { CEEIndexSync } from "../src/infrastructure/cee/CEEIndexSync";

const makeSync = (options: { fail?: boolean } = {}) => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE characters (id INTEGER PRIMARY KEY, name TEXT, name_cn TEXT, aliases TEXT, comments INTEGER, collects INTEGER);
    INSERT INTO characters VALUES (1,'a','甲','[]',0,0), (2,'b','乙','[]',0,0);`);
  let updates = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const search = {
    toCharacterDocument: (row: Record<string, unknown>) => ({ id: Number(row.id) }),
    // 模拟「等 Meilisearch 任务落定」：门未放行前一直挂着。
    updateCharacter: async () => {
      updates += 1;
      await gate;
      if (options.fail) throw new Error("索引不可用");
    },
  } as unknown as BangumiSearchIndex;
  const enrichment = { readCharacter: () => ({}) } as unknown as CEEEnrichment;
  const sync = new CEEIndexSync({ db, enrichment, now: Date.now, search });
  return { sync, release, updates: () => updates, db };
};

describe("角色索引按需同步", () => {
  test("同一角色并发同步只等一次索引任务，之后不再同步", async () => {
    const { sync, release, updates, db } = makeSync();
    const first = sync.syncCharacterIndexOnce(1);
    const second = sync.syncCharacterIndexOnce(1);
    const other = sync.syncCharacterIndexOnce(2);
    release();
    await Promise.all([first, second, other]);
    expect(updates()).toBe(2);
    await sync.syncCharacterIndexOnce(1);
    expect(updates()).toBe(2);
    db.close();
  });

  test("同步失败不记为已同步，下次还会再试", async () => {
    const { sync, release, updates, db } = makeSync({ fail: true });
    release();
    await expect(sync.syncCharacterIndexOnce(1)).rejects.toThrow("索引不可用");
    await expect(sync.syncCharacterIndexOnce(1)).rejects.toThrow("索引不可用");
    expect(updates()).toBe(2);
    db.close();
  });
});
