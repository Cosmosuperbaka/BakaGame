import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Meilisearch } from "meilisearch";
import {
  BangumiSearchIndex,
  CHARACTER_FILTERABLE,
  CHARACTER_RANKING_RULES,
  SUBJECT_FILTERABLE,
  SUBJECT_RANKING_RULES,
} from "../src/infrastructure/BangumiSearchIndex";

/** 只记录 search 调用的假 client；这些用例不触发 init，不需要其余索引方法。 */
function createClient() {
  const requests: Array<{ index: string; query: string | undefined; options: unknown }> = [];
  const documents: Array<{ index: string; documents: unknown[] }> = [];
  const client = {
    health: async () => ({ status: "available" }),
    createIndex: () => ({ waitTask: async () => ({ status: "succeeded" }) }),
    index(uid: string) {
      return {
        uid,
        search: async (query?: string | null, options?: unknown) => {
          requests.push({ index: uid, query: query ?? undefined, options });
          return { hits: [{ id: uid === "characters" ? 2 : 11 }], estimatedTotalHits: 1 };
        },
        addDocuments: (items: unknown[]) => {
          documents.push({ index: uid, documents: items });
          return { waitTask: async () => ({ status: "succeeded" }) };
        },
        deleteAllDocuments: () => ({ waitTask: async () => ({ status: "succeeded" }) }),
        getStats: async () => ({ numberOfDocuments: 0 }),
        fetchInfo: async () => ({ uid }),
        updateSettings: () => ({ waitTask: async () => ({ status: "succeeded" }) }),
        // 元数据索引：返回陈旧 revision，配合 getStats 的 0 文档 → 必定走重建分支。
        getDocument: async () => ({ revision: "stale" }),
      };
    },
  } as unknown as Meilisearch;
  return { client, requests, documents };
}

describe("统一搜索索引契约", () => {
  test("角色搜索保留 Meilisearch 命中顺序，且不再带 nsfw 过滤", async () => {
    const { client, requests } = createClient();
    const search = new BangumiSearchIndex({ client });

    expect((await search.searchCharacters("牧濑", 20)).ids).toEqual([2]);
    // 数据里已无 nsfw 条目，filter 整体去掉 —— 留着会要求 filterable 声明 nsfw。
    expect(requests[0]).toEqual({ index: "characters", query: "牧濑", options: { limit: 20 } });
    expect(CHARACTER_FILTERABLE).toEqual([]);
    expect(CHARACTER_RANKING_RULES).toEqual([
      "exactness", "words", "typo", "proximity", "attribute", "sort", "id:asc", "comment:desc", "collect:desc",
    ]);
  });

  test("CCB 的作品搜索：类型按 OR 分组，无 nsfw 过滤", async () => {
    const { client, requests } = createClient();
    const search = new BangumiSearchIndex({ client });

    expect((await search.searchSubjects({ keyword: "作品", limit: 20, types: [1, 2, 4, 6] })).ids).toEqual([11]);
    expect(requests[0]).toEqual({
      index: "subjects", query: "作品",
      options: { limit: 20, filter: [["type = 1", "type = 2", "type = 4", "type = 6"]], sort: undefined },
    });
  });

  test("猜歌的作品搜索：只取动画、带年份区间，无关键词时按热度排序", async () => {
    const { client, requests } = createClient();
    const search = new BangumiSearchIndex({ client });

    await search.searchSubjects({ keyword: "", limit: 50, types: [2], startYear: 2010, endYear: 2020, sortByHeat: true });
    expect(requests[0]).toEqual({
      index: "subjects", query: "",
      options: {
        limit: 50,
        filter: [["type = 2"], "date >= 20100101", "date <= 20201231"],
        sort: ["heat:desc", "rank:asc", "score:desc", "id:asc"],
      },
    });

    // 有关键词时交给 rankingRules，不再显式 sort。
    await search.searchSubjects({ keyword: "命运石", limit: 20, types: [2], sortByHeat: false });
    expect((requests[1].options as { sort?: unknown }).sort).toBeUndefined();
  });

  test("作品索引的 rankingRules 与 filterable 对齐官方，且都不含 nsfw", async () => {
    expect(SUBJECT_RANKING_RULES).toEqual([
      "exactness", "words", "typo", "proximity", "attribute", "sort", "id:asc", "rank:asc", "score:desc",
    ]);
    expect(SUBJECT_FILTERABLE).toEqual(["tag", "meta_tag", "date", "score", "rating_count", "rank", "type"]);
  });

  test("作品文档的 tag 取标签名数组（官方口径），不是 raw_tags 的票数对象", async () => {
    const { client, documents } = createClient();
    const db = new Database(join(tmpdir(), `bangumi-index-${crypto.randomUUID()}.sqlite`));
    db.exec(`
      CREATE TABLE subjects(id INTEGER PRIMARY KEY,type INTEGER,name TEXT,name_cn TEXT,aliases TEXT,infobox TEXT,summary TEXT,date TEXT,nsfw INTEGER,tags TEXT,raw_tags TEXT,meta_tags TEXT,score REAL,rating_count INTEGER,heat INTEGER,rank INTEGER,image TEXT);
      CREATE TABLE characters(id INTEGER PRIMARY KEY,role INTEGER,name TEXT,name_cn TEXT,gender TEXT,aliases TEXT,summary TEXT,comments INTEGER,collects INTEGER);
    `);
    db.query("INSERT INTO subjects VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      8, 2, "コードギアス", "反叛的鲁路修", '["鲁路修"]', "", "", "2006-10-05", 0,
      '["机战","原创"]', '{"机战":10}', '["2006年"]', 8.6, 18740, 84, 123, "",
    );
    const path = join(tmpdir(), `bangumi-index-src-${crypto.randomUUID()}.sqlite`);
    new Database(path).close();
    try {
      await new BangumiSearchIndex({ client }).initialize(db, path);
      const written = documents.find((entry) => entry.index === "subjects")!.documents[0] as Record<string, unknown>;
      expect(written).toMatchObject({
        id: 8, name: "コードギアス", tag: ["机战", "原创"], meta_tag: ["2006年"],
        date: 20061005, score: 8.6, rating_count: 18740, heat: 84, rank: 123, type: 2,
      });
      // nsfw 不再进文档：filterable 已去掉该字段。
      expect(written.nsfw).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
