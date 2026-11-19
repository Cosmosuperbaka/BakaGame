import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeilisearchApiError, type Meilisearch } from "meilisearch";
import {
  BangumiSearchIndex,
  CHARACTER_FILTERABLE,
  CHARACTER_RANKING_RULES,
  SUBJECT_FILTERABLE,
  SUBJECT_RANKING_RULES,
  SUBJECT_SORTABLE,
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
      "exactness",
      "words",
      "typo",
      "proximity",
      "attribute",
      "sort",
      "id:asc",
      "comment:desc",
      "collect:desc",
    ]);
  });

  test("CEE 的作品搜索：类型按 OR 分组，无 nsfw 过滤", async () => {
    const { client, requests } = createClient();
    const search = new BangumiSearchIndex({ client });

    expect(
      (await search.searchSubjects({ keyword: "作品", limit: 20, types: [1, 2, 4, 6] })).ids
    ).toEqual([11]);
    expect(requests[0]).toEqual({
      index: "subjects",
      query: "作品",
      options: {
        limit: 20,
        filter: [["type = 1", "type = 2", "type = 4", "type = 6"]],
        sort: undefined,
      },
    });
  });

  test("猜歌的作品搜索：只取动画、带年份区间，无关键词时按热度排序", async () => {
    const { client, requests } = createClient();
    const search = new BangumiSearchIndex({ client });

    await search.searchSubjects({
      keyword: "",
      limit: 50,
      types: [2],
      startYear: 2010,
      endYear: 2020,
      sortByHeat: true,
    });
    expect(requests[0]).toEqual({
      index: "subjects",
      query: "",
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
      "exactness",
      "words",
      "typo",
      "proximity",
      "attribute",
      "sort",
      "id:asc",
      "rank:asc",
      "score:desc",
    ]);
    expect(SUBJECT_FILTERABLE).toEqual([
      "tag",
      "meta_tag",
      "date",
      "score",
      "rating_count",
      "rank",
      "type",
    ]);
  });

  test("查询侧 sort 用到的字段必须全部声明为 sortable，否则 Meilisearch 400 拒绝", async () => {
    // 生产事故回归：无关键词出题时 sort 带 `id:asc` 稳定兜底，但 id 不在 sortable 里，
    // Meilisearch 直接以 `invalid_search_sort` 400 拒绝整个搜索，猜番无法开局。
    // 假 client 不校验 sortable，所以这里显式断言「sort 字段 ⊆ sortable」这条契约。
    const { client, requests } = createClient();
    const search = new BangumiSearchIndex({ client });

    await search.searchSubjects({ keyword: "", limit: 50, types: [2], sortByHeat: true });
    const sort = (requests[0].options as { sort?: string[] }).sort ?? [];
    const sortKeys = sort.map((clause) => clause.split(":")[0]);
    expect(sortKeys.length).toBeGreaterThan(0);
    for (const key of sortKeys) expect(SUBJECT_SORTABLE).toContain(key);
    expect(SUBJECT_SORTABLE).toContain("id");
  });

  test("作品文档的 tag 取标签名数组（官方口径），不是 raw_tags 的票数对象", async () => {
    const { client, documents } = createClient();
    const db = new Database(join(tmpdir(), `bangumi-index-${crypto.randomUUID()}.sqlite`));
    db.exec(`
      CREATE TABLE subjects(id INTEGER PRIMARY KEY,type INTEGER,name TEXT,name_cn TEXT,aliases TEXT,infobox TEXT,summary TEXT,date TEXT,nsfw INTEGER,tags TEXT,raw_tags TEXT,meta_tags TEXT,score REAL,rating_count INTEGER,heat INTEGER,rank INTEGER,image TEXT);
      CREATE TABLE characters(id INTEGER PRIMARY KEY,role INTEGER,name TEXT,name_cn TEXT,gender TEXT,aliases TEXT,summary TEXT,comments INTEGER,collects INTEGER);
    `);
    db.query("INSERT INTO subjects VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      8,
      2,
      "コードギアス",
      "反叛的鲁路修",
      '["鲁路修"]',
      "",
      "",
      "2006-10-05",
      0,
      '["机战","原创"]',
      '{"机战":10}',
      '["2006年"]',
      8.6,
      18740,
      84,
      123,
      ""
    );
    try {
      await new BangumiSearchIndex({ client }).initialize(db);
      const written = documents.find((entry) => entry.index === "subjects")!.documents[0] as Record<
        string,
        unknown
      >;
      expect(written).toMatchObject({
        id: 8,
        name: "コードギアス",
        tag: ["机战", "原创"],
        meta_tag: ["2006年"],
        date: 20061005,
        score: 8.6,
        rating_count: 18740,
        heat: 84,
        rank: 123,
        type: 2,
      });
      // nsfw 不再进文档：filterable 已去掉该字段。
      expect(written.nsfw).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

/** 有状态的假 Meilisearch：记住每个索引里的文档，才能验证「第二次初始化是否又重建」。 */
function createStatefulClient() {
  const stores = new Map<string, Map<unknown, Record<string, unknown>>>();
  const calls = { health: 0, deleteAll: 0, addDocuments: 0, updateSettings: 0 };
  const store = (uid: string) => {
    let docs = stores.get(uid);
    if (!docs) stores.set(uid, (docs = new Map()));
    return docs;
  };
  const done = { waitTask: async () => ({ status: "succeeded" }) };
  const client = {
    health: async () => {
      calls.health += 1;
      return { status: "available" };
    },
    createIndex: (uid: string) => {
      store(uid);
      return done;
    },
    index(uid: string) {
      return {
        uid,
        fetchInfo: async () => ({ uid }),
        updateSettings: () => {
          calls.updateSettings += 1;
          return done;
        },
        getStats: async () => ({ numberOfDocuments: store(uid).size }),
        getDocument: async (id: string) => {
          const doc = store(uid).get(id);
          if (!doc)
            throw new MeilisearchApiError({ status: 404, statusText: "", url: "" } as Response, {
              message: "not found",
              code: "document_not_found",
              type: "invalid_request",
              link: "",
            });
          return doc;
        },
        deleteAllDocuments: () => {
          calls.deleteAll += 1;
          store(uid).clear();
          return done;
        },
        addDocuments: (items: Array<Record<string, unknown>>) => {
          calls.addDocuments += 1;
          for (const item of items) store(uid).set(item.id, item);
          return done;
        },
      };
    },
  } as unknown as Meilisearch;
  return { client, calls, store };
}

function createDataset(options: { userVersion?: number } = {}) {
  const path = join(tmpdir(), `bangumi-index-rev-${crypto.randomUUID()}.sqlite`);
  const db = new Database(path);
  db.exec(`
    CREATE TABLE subjects(id INTEGER PRIMARY KEY,type INTEGER,name TEXT,name_cn TEXT,aliases TEXT,date TEXT,tags TEXT,meta_tags TEXT,score REAL,rating_count INTEGER,heat INTEGER,rank INTEGER);
    CREATE TABLE characters(id INTEGER PRIMARY KEY,name TEXT,name_cn TEXT,aliases TEXT,comments INTEGER,collects INTEGER);
    INSERT INTO subjects VALUES (1,2,'A','甲','[]','2020-01-01','[]','[]',8,10,5,1);
    INSERT INTO subjects VALUES (2,2,'B','乙','[]','2021-01-01','[]','[]',7,10,4,2);
    INSERT INTO characters VALUES (1,'X','叉','[]',1,1);
  `);
  if (options.userVersion) db.exec(`PRAGMA user_version = ${options.userVersion}`);
  return db;
}

describe("搜索索引初始化的修订号", () => {
  test("数据集文件在两次启动之间被正常写入（刷新、发现）不触发全量重灌", async () => {
    const { client, calls } = createStatefulClient();
    const db = createDataset();
    try {
      await new BangumiSearchIndex({ client }).initialize(db);
      expect(calls.addDocuments).toBeGreaterThan(0);
      const before = { ...calls };
      // 更新器每轮都在改库：文件字节变了，但索引内容由待同步队列增量维护。
      db.exec("UPDATE subjects SET heat = heat + 1, score = 9 WHERE id = 1");
      await new BangumiSearchIndex({ client }).initialize(db);
      expect(calls.deleteAll).toBe(before.deleteAll);
      expect(calls.addDocuments).toBe(before.addDocuments);
    } finally {
      db.close();
    }
  });

  test("基线标识变化（整库替换）或文档数与库不一致时才重灌", async () => {
    const { client, calls, store } = createStatefulClient();
    const db = createDataset();
    try {
      await new BangumiSearchIndex({ client }).initialize(db);
      const afterFirst = calls.deleteAll;
      // 文档数偏离：只重灌对应索引。
      store("characters").clear();
      await new BangumiSearchIndex({ client }).initialize(db);
      expect(calls.deleteAll).toBe(afterFirst + 1);
      expect(store("characters").size).toBe(1);
      // 基线标识提升：两个索引都重灌。
      db.exec("PRAGMA user_version = 7");
      await new BangumiSearchIndex({ client }).initialize(db);
      expect(calls.deleteAll).toBe(afterFirst + 3);
    } finally {
      db.close();
    }
  });

  test("同一适配器被多条链路并发初始化时只执行一次", async () => {
    const { client, calls } = createStatefulClient();
    const db = createDataset();
    try {
      const search = new BangumiSearchIndex({ client });
      await Promise.all([search.initialize(db), search.initialize(db), search.initialize(db)]);
      // 每次完整初始化会对两个索引各 updateSettings 一次。
      expect(calls.updateSettings).toBe(2);
      expect(calls.health).toBe(1);
    } finally {
      db.close();
    }
  });

  test("初始化失败后可以重试，不会把失败钉死", async () => {
    const { client } = createStatefulClient();
    const db = createDataset();
    try {
      let failures = 1;
      const original = client.health.bind(client);
      client.health = (async () => {
        if (failures-- > 0) throw new Error("暂时不可达");
        return original();
      }) as typeof client.health;
      const search = new BangumiSearchIndex({ client });
      await expect(search.initialize(db)).rejects.toThrow("暂时不可达");
      await expect(search.initialize(db)).resolves.toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("索引文档映射只有一份口径", () => {
  const { client } = createClient();
  const search = new BangumiSearchIndex({ client });

  test("作品文档：空列不写成字面 null，只有年月的日期按 parseDate 口径记 0", () => {
    const document = search.toSubjectDocument({
      id: 5,
      name: "作品",
      name_cn: null,
      aliases: null,
      tags: null,
      meta_tags: null,
      date: "2024-04",
      score: null,
      rating_count: null,
      heat: null,
      rank: null,
      type: 2,
    });
    expect(document.aliases).toEqual([]);
    expect(document.date).toBe(0);
    expect(document).toMatchObject({
      score: 0,
      rating_count: 0,
      heat: 0,
      rank: 0,
      tag: [],
      meta_tag: [],
    });
  });

  test("角色文档：中文名与别名合并去重，补充资料覆盖库内值，空列不写成 null", () => {
    expect(
      search.toCharacterDocument({
        id: 7,
        name: "甲",
        name_cn: null,
        aliases: '["乙","乙"]',
        comments: null,
        collects: 9,
      })
    ).toEqual({ id: 7, name: "甲", aliases: ["乙"], comment: 0, collect: 9 });
    expect(
      search.toCharacterDocument(
        { id: 7, name: "甲", name_cn: "旧中文名", aliases: '["旧别名"]', comments: 1, collects: 2 },
        { name: "新名", nameCn: "新中文名", aliases: ["新别名"] }
      )
    ).toEqual({ id: 7, name: "新名", aliases: ["新中文名", "新别名"], comment: 1, collect: 2 });
  });
});
