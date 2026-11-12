import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { BangumiSearchIndex } from "../src/infrastructure/BangumiSearchIndex";
import { discoverNewSubjects, infoboxToWikitext } from "../src/infrastructure/SubjectDiscovery";
import { requestBodyText, requestUrlText } from "./RequestFixtures";

const BASE = "https://bgm.invalid";

/** 建一个与真实数据集同构的最小库（只建本模块会碰的表）。 */
const makeDb = () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE subjects(id INTEGER PRIMARY KEY,type INTEGER,name TEXT,name_cn TEXT,aliases TEXT,infobox TEXT,summary TEXT,date TEXT,nsfw INTEGER,tags TEXT,raw_tags TEXT,meta_tags TEXT,score REAL,rating_count INTEGER,heat INTEGER,rank INTEGER,image TEXT);
    CREATE TABLE characters(id INTEGER PRIMARY KEY,role INTEGER,name TEXT,name_cn TEXT,gender TEXT,aliases TEXT,summary TEXT,comments INTEGER,collects INTEGER);
    CREATE TABLE character_subject_relations(character_id INTEGER,subject_id INTEGER,relation_type INTEGER,relation_order INTEGER,PRIMARY KEY(character_id,subject_id));
    CREATE TABLE subject_music_relations(subject_id INTEGER,music_id INTEGER,relation_type INTEGER,relation_order INTEGER,title TEXT,artist TEXT,kind TEXT,PRIMARY KEY(subject_id,music_id));
  `);
  return db;
};

/** 假上游：搜索结果固定，按 URL 分派详情。 */
const makeFetcher = (payloads: Record<string, unknown>) => {
  const calls: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrlText(input);
    calls.push(init?.method === "POST" ? `POST ${url}` : url);
    if (url.includes("/v0/search/subjects")) {
      return Response.json({ data: [{ id: 900001 }, { id: 900002 }, { id: 8 }], total: 3 });
    }
    const body = payloads[url];
    if (body === undefined) return new Response(null, { status: 404 });
    return Response.json(body);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
};

test("发现新作品：入库详情、角色与关联，已在库里的跳过", async () => {
  const db = makeDb();
  db.query("INSERT INTO subjects VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    8,
    2,
    "已有作品",
    "",
    "[]",
    "",
    "",
    "2006-10-05",
    0,
    "[]",
    "{}",
    "[]",
    8.6,
    18740,
    84,
    123,
    ""
  );

  const { fetcher } = makeFetcher({
    [`${BASE}/v0/subjects/900001`]: {
      id: 900001,
      type: 2,
      name: "新番",
      name_cn: "新番中文",
      date: "2026-10-01",
      summary: "简介",
      meta_tags: ["原创"],
      tags: [
        { name: "机战", count: 10 },
        { name: "新番", count: 5 },
      ],
      images: { large: "https://lain.bgm.tv/pic/cover/l/aa/bb/900001.jpg" },
      rating: { score: 7.5, total: 120, rank: 3000 },
      collection: { wish: 40, collect: 30, doing: 20, on_hold: 5, dropped: 5 },
    },
    [`${BASE}/v0/subjects/900001/characters`]: [
      { id: 700001, name: "新角色", type: 1, relation: "主角" },
    ],
    [`${BASE}/v0/subjects/900001/subjects`]: [],
    [`${BASE}/v0/characters/700001`]: {
      id: 700001,
      name: "新角色",
      name_cn: "新角色中文",
      gender: "female",
      comments: 3,
      collects: 7,
    },
    // 既没角色也没关联音乐 —— 按裁剪判据必须丢弃。
    [`${BASE}/v0/subjects/900002`]: {
      id: 900002,
      type: 1,
      name: "孤立书籍",
      tags: [],
      meta_tags: [],
      rating: {},
      collection: {},
    },
    [`${BASE}/v0/subjects/900002/characters`]: [],
    [`${BASE}/v0/subjects/900002/subjects`]: [],
  });

  const result = await discoverNewSubjects({ db, base: BASE, fetcher, since: "2026-09-01" });

  expect(result.candidates).toBe(3);
  expect(result.added).toBe(1);
  expect(result.skipped).toBe(2); // 900002 被裁掉 + 8 已在库
  expect(result.failed).toBe(0);

  const row = db.query("SELECT * FROM subjects WHERE id=900001").get() as Record<string, unknown>;
  expect(row).toMatchObject({
    name: "新番",
    name_cn: "新番中文",
    type: 2,
    score: 7.5,
    rating_count: 120,
    rank: 3000,
    heat: 100, // heat = 收藏五桶之和
    image: "https://lain.bgm.tv/pic/cover/l/aa/bb/900001.jpg",
  });
  expect(JSON.parse(String(row.tags))).toEqual(["机战", "新番"]);
  // raw_tags 存 {名称: 票数}，与原版 details.raw_tags 同口径。
  expect(JSON.parse(String(row.raw_tags))).toEqual({ 机战: 10, 新番: 5 });

  expect(db.query("SELECT name FROM characters WHERE id=700001").get()).toEqual({ name: "新角色" });
  expect(
    db
      .query(
        "SELECT subject_id, relation_type FROM character_subject_relations WHERE character_id=700001"
      )
      .get()
  ).toEqual({ subject_id: 900001, relation_type: 1 });
  expect(db.query("SELECT count(*) AS n FROM subjects WHERE id=900002").get()).toEqual({ n: 0 });
  db.close();
});

test("nsfw 条目一律不入库（匿名拿不到，仍显式挡一道）", async () => {
  const db = makeDb();
  const { fetcher } = makeFetcher({
    [`${BASE}/v0/subjects/900001`]: {
      id: 900001,
      type: 2,
      name: "x",
      nsfw: true,
      tags: [],
      meta_tags: [],
      rating: {},
      collection: {},
    },
    [`${BASE}/v0/subjects/900001/characters`]: [{ id: 700001, type: 1 }],
    [`${BASE}/v0/subjects/900001/subjects`]: [],
  });
  const result = await discoverNewSubjects({ db, base: BASE, fetcher, since: "2026-09-01" });
  expect(result.added).toBe(0);
  expect(db.query("SELECT count(*) AS n FROM subjects").get()).toEqual({ n: 0 });
  db.close();
});

test("搜索窗口按 since 组装 air_date 过滤（不是 sort: date —— 官方 sort 白名单里没有它）", async () => {
  const db = makeDb();
  const seen: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(requestBodyText(init));
    return Response.json({ data: [], total: 0 });
  }) as unknown as typeof fetch;
  await discoverNewSubjects({ db, base: BASE, fetcher, since: "2026-09-15", pauseMs: 0 });
  expect(seen).toHaveLength(1);
  expect(JSON.parse(seen[0])).toMatchObject({
    filter: { air_date: [">=2026-09-15"], type: [1, 2, 3, 4, 6] },
    sort: "heat",
  });
  db.close();
});

test("翻页走查询串且按 total 结束：上游单页压到 20 时也要取全候选", async () => {
  const db = makeDb();
  const allIds = Array.from({ length: 45 }, (_, index) => index + 1);
  const urls: string[] = [];
  const bodies: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(requestUrlText(input));
    if (init?.method !== "POST") return new Response(null, { status: 404 });
    urls.push(url.search);
    bodies.push(requestBodyText(init));
    const size = Math.min(20, Number(url.searchParams.get("limit") ?? 10));
    const offset = Number(url.searchParams.get("offset") ?? 0);
    return Response.json({
      data: allIds.slice(offset, offset + size).map((id) => ({ id })),
      total: allIds.length,
    });
  }) as unknown as typeof fetch;

  const result = await discoverNewSubjects({ db, base: BASE, fetcher, pauseMs: 0 });

  expect(result.candidates).toBe(45);
  expect(urls).toEqual(["?limit=20&offset=0", "?limit=20&offset=20", "?limit=20&offset=40"]);
  expect(JSON.parse(bodies[0])).not.toHaveProperty("limit");
  db.close();
});

test("搜索失败要抛出，不能伪装成这段时间没有新条目", async () => {
  const db = makeDb();
  const fetcher = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
  await expect(discoverNewSubjects({ db, base: BASE, fetcher, pauseMs: 0 })).rejects.toThrow("503");
  db.close();
});

test("瞬时失败记为失败：限流不能把作品当成无角色裁掉", async () => {
  const db = makeDb();
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json({ data: [{ id: 900001 }], total: 1 });
    return requestUrlText(input).endsWith("/characters")
      ? new Response(null, { status: 429 })
      : Response.json([]);
  }) as unknown as typeof fetch;
  const result = await discoverNewSubjects({ db, base: BASE, fetcher, pauseMs: 0 });
  expect(result).toMatchObject({ added: 0, skipped: 0, failed: 1 });
  db.close();
});

test("接口形态的字段按 dump 口径落库：infobox、关系码、角色统计与曲目艺术家", async () => {
  const db = makeDb();
  const payloads: Record<string, unknown> = {
    [`${BASE}/v0/subjects/900001`]: {
      id: 900001,
      type: 2,
      name: "新番",
      infobox: [
        { key: "中文名", value: "新番中文" },
        { key: "别名", value: [{ v: "别名一" }, { k: "英文", v: "Alias" }] },
      ],
    },
    [`${BASE}/v0/subjects/900001/characters`]: [
      { id: 700001, name: "配角", type: 1, relation: "配角" },
    ],
    [`${BASE}/v0/subjects/900001/subjects`]: [{ id: 800001, type: 3, relation: "片头曲" }],
    [`${BASE}/v0/characters/700001`]: {
      id: 700001,
      type: 1,
      name: "配角",
      gender: null,
      stat: { comments: 3, collects: 7 },
      infobox: [
        { key: "简体中文名", value: "配角中文" },
        { key: "别名", value: [{ v: "小配" }] },
      ],
    },
    [`${BASE}/v0/subjects/800001`]: {
      id: 800001,
      type: 3,
      name: "OP",
      infobox: [{ key: "艺术家", value: [{ v: "甲" }, { v: "乙" }] }],
    },
  };
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json({ data: [{ id: 900001 }], total: 1 });
    const body = payloads[requestUrlText(input)];
    return body === undefined ? new Response(null, { status: 404 }) : Response.json(body);
  }) as unknown as typeof fetch;

  expect(await discoverNewSubjects({ db, base: BASE, fetcher, pauseMs: 0 })).toMatchObject({
    added: 1,
    failed: 0,
  });

  const subject = db.query("SELECT infobox FROM subjects WHERE id=900001").get() as {
    infobox: string;
  };
  expect(subject.infobox).toContain("|中文名= 新番中文");
  expect(subject.infobox).toContain("[别名一]");
  expect(subject.infobox).not.toContain("[object Object]");
  expect(db.query("SELECT * FROM characters WHERE id=700001").get()).toMatchObject({
    role: 1,
    name_cn: "配角中文",
    gender: "?",
    aliases: JSON.stringify(["小配"]),
    comments: 3,
    collects: 7,
  });
  expect(
    db.query("SELECT relation_type FROM character_subject_relations WHERE subject_id=900001").get()
  ).toEqual({ relation_type: 2 });
  expect(
    db.query("SELECT * FROM subject_music_relations WHERE subject_id=900001").get()
  ).toMatchObject({ relation_type: 3003, title: "OP", artist: "甲、乙" });
  db.close();
});

test("infobox 已是 wikitext 时原样保留，缺失时落空串", () => {
  expect(infoboxToWikitext("{{Infobox\r\n}}")).toBe("{{Infobox\r\n}}");
  expect(infoboxToWikitext(undefined)).toBe("");
  expect(infoboxToWikitext([])).toBe("");
});

/** 一部带两个新角色与一条音乐关联的作品，供原子性与并发用例复用。 */
const richPayloads = (): Record<string, unknown> => ({
  [`${BASE}/v0/subjects/900001`]: {
    id: 900001,
    type: 2,
    name: "新番",
    tags: [],
    meta_tags: [],
    rating: {},
    collection: {},
  },
  [`${BASE}/v0/subjects/900001/characters`]: [
    { id: 700001, name: "角色一", type: 1, relation: "主角" },
    { id: 700002, name: "角色二", type: 1, relation: "配角" },
  ],
  [`${BASE}/v0/subjects/900001/subjects`]: [{ id: 800001, type: 3, relation: "片头曲" }],
  [`${BASE}/v0/characters/700001`]: { id: 700001, name: "角色一", stat: {} },
  [`${BASE}/v0/characters/700002`]: { id: 700002, name: "角色二", stat: {} },
  [`${BASE}/v0/subjects/800001`]: { id: 800001, type: 3, name: "片头曲" },
});

const countRows = (db: Database) => ({
  subjects: (db.query("SELECT count(*) AS n FROM subjects").get() as { n: number }).n,
  characters: (db.query("SELECT count(*) AS n FROM characters").get() as { n: number }).n,
  relations: (
    db.query("SELECT count(*) AS n FROM character_subject_relations").get() as { n: number }
  ).n,
  music: (db.query("SELECT count(*) AS n FROM subject_music_relations").get() as { n: number }).n,
});

/** 搜索只返回 900001；`failing` 里的地址返回 500，其余按 payloads 分派。 */
const makeSingleSubjectFetcher = (payloads: Record<string, unknown>, failing: Set<string>) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrlText(input);
    if (init?.method === "POST") return Response.json({ data: [{ id: 900001 }], total: 1 });
    if (failing.has(url)) return new Response(null, { status: 500 });
    const body = payloads[url];
    return body === undefined ? new Response(null, { status: 404 }) : Response.json(body);
  }) as unknown as typeof fetch;

test("角色详情中途失败时整部作品不落库，下次发现仍当作新作品重试", async () => {
  const db = makeDb();
  const failing = new Set([`${BASE}/v0/characters/700002`]);
  const fetcher = makeSingleSubjectFetcher(richPayloads(), failing);
  const first = await discoverNewSubjects({ db, base: BASE, fetcher, pauseMs: 0 });
  expect(first).toMatchObject({ added: 0, failed: 1 });
  // 失败要带出作品编号与原因，运维才能排查。
  expect(first.failures).toHaveLength(1);
  expect(first.failures[0]).toMatchObject({ id: 900001 });
  expect(first.failures[0]!.message).toContain("500");
  // 不留半截：作品行、已拉到的角色、关联都不能落库。
  expect(countRows(db)).toEqual({ subjects: 0, characters: 0, relations: 0, music: 0 });

  failing.clear();
  const second = await discoverNewSubjects({ db, base: BASE, fetcher, pauseMs: 0 });
  expect(second).toMatchObject({ added: 1, failed: 0 });
  expect(countRows(db)).toEqual({ subjects: 1, characters: 2, relations: 2, music: 1 });
  db.close();
});

test("关联音乐详情失败时同样整体不落库", async () => {
  const db = makeDb();
  const fetcher = makeSingleSubjectFetcher(richPayloads(), new Set([`${BASE}/v0/subjects/800001`]));
  const result = await discoverNewSubjects({ db, base: BASE, fetcher, pauseMs: 0 });
  expect(result).toMatchObject({ added: 0, failed: 1 });
  expect(countRows(db)).toEqual({ subjects: 0, characters: 0, relations: 0, music: 0 });
  db.close();
});

test("写库阶段出错时事务回滚，不留下作品行", async () => {
  const db = makeDb();
  // 去掉音乐关联表：写库的最后一步必然失败，前面写入的作品与角色必须一并回滚。
  db.exec("DROP TABLE subject_music_relations");
  const fetcher = makeSingleSubjectFetcher(richPayloads(), new Set());
  const result = await discoverNewSubjects({ db, base: BASE, fetcher, pauseMs: 0 });
  expect(result).toMatchObject({ added: 0, failed: 1 });
  expect(db.query("SELECT count(*) AS n FROM subjects").get()).toEqual({ n: 0 });
  expect(db.query("SELECT count(*) AS n FROM characters").get()).toEqual({ n: 0 });
  db.close();
});

/** 只在被 abort 时才结束的挂起请求：模拟半开连接。 */
const hang = (init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener(
      "abort",
      () =>
        reject(init.signal!.reason instanceof Error ? init.signal!.reason : new Error("已中止")),
      { once: true }
    );
  });

test("搜索请求挂起时按请求超时中止并抛出，不会让每日任务永远不返回", async () => {
  const db = makeDb();
  const fetcher = ((_: unknown, init?: RequestInit) => hang(init)) as unknown as typeof fetch;
  const startedAt = Date.now();
  await expect(
    discoverNewSubjects({ db, base: BASE, fetcher, pauseMs: 0, requestTimeoutMs: 30 })
  ).rejects.toThrow();
  expect(Date.now() - startedAt).toBeLessThan(1_000);
  db.close();
});

test("详情请求挂起时该作品记为失败，其余流程继续", async () => {
  const db = makeDb();
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json({ data: [{ id: 900001 }], total: 1 });
    return hang(init);
  }) as unknown as typeof fetch;
  const result = await discoverNewSubjects({
    db,
    base: BASE,
    fetcher,
    pauseMs: 0,
    requestTimeoutMs: 30,
  });
  expect(result).toMatchObject({ added: 0, failed: 1 });
  db.close();
});

test("超过总预算后不再处理剩余候选，并如实记为失败", async () => {
  const db = makeDb();
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrlText(input);
    if (init?.method === "POST")
      return Response.json({ data: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }], total: 4 });
    await Bun.sleep(40);
    return url.endsWith("/characters") || url.endsWith("/subjects")
      ? Response.json([])
      : Response.json({ id: 1, type: 2, name: "x" });
  }) as unknown as typeof fetch;
  const result = await discoverNewSubjects({
    db,
    base: BASE,
    fetcher,
    pauseMs: 0,
    totalBudgetMs: 60,
  });
  expect(result.candidates).toBe(4);
  expect(result.added + result.skipped + result.failed).toBe(4);
  expect(result.failed).toBeGreaterThan(0);
  expect(result.failures.some((item) => item.message.includes("预算"))).toBe(true);
  db.close();
});

test("同一部作品的角色与关联详情并发抓取，但不超过并发上限", async () => {
  const db = makeDb();
  const characters = Array.from({ length: 8 }, (_, index) => ({
    id: 700100 + index,
    name: `角色${index}`,
    type: 1,
    relation: "配角",
  }));
  const payloads: Record<string, unknown> = {
    [`${BASE}/v0/subjects/900001`]: { id: 900001, type: 2, name: "新番" },
    [`${BASE}/v0/subjects/900001/characters`]: characters,
    [`${BASE}/v0/subjects/900001/subjects`]: [],
  };
  let inFlight = 0;
  let peak = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrlText(input);
    if (init?.method === "POST") return Response.json({ data: [{ id: 900001 }], total: 1 });
    const isCharacterDetail = /\/v0\/characters\/\d+$/.test(url);
    if (isCharacterDetail) {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(15);
      inFlight -= 1;
      return Response.json({ id: Number(url.split("/").pop()), name: "角色", stat: {} });
    }
    const body = payloads[url];
    return body === undefined ? new Response(null, { status: 404 }) : Response.json(body);
  }) as unknown as typeof fetch;
  const result = await discoverNewSubjects({ db, base: BASE, fetcher, pauseMs: 0 });
  expect(result.added).toBe(1);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(3);
  expect(countRows(db).characters).toBe(8);
  db.close();
});

test("新入库作品与角色写进索引的文档与整库重灌同一口径：只有年月的日期记 0，空中文名不写成 null", async () => {
  const db = makeDb();
  const subjects: Array<Record<string, unknown>> = [];
  const characters: Array<Record<string, unknown>> = [];
  const search = Object.assign(Object.create(BangumiSearchIndex.prototype) as BangumiSearchIndex, {
    updateSubject: async (document: Record<string, unknown>) => void subjects.push(document),
    updateCharacter: async (document: Record<string, unknown>) => void characters.push(document),
  });
  const fetcher = makeSingleSubjectFetcher(
    {
      [`${BASE}/v0/subjects/900001`]: { id: 900001, type: 2, name: "新番", date: "2024-04" },
      [`${BASE}/v0/subjects/900001/characters`]: [{ id: 700001, name: "角色", type: 1 }],
      [`${BASE}/v0/subjects/900001/subjects`]: [],
      [`${BASE}/v0/characters/700001`]: { id: 700001, name: "角色", stat: { collects: 3 } },
    },
    new Set()
  );
  await discoverNewSubjects({ db, base: BASE, fetcher, search, pauseMs: 0 });
  expect(subjects).toHaveLength(1);
  expect(subjects[0]).toMatchObject({ id: 900001, date: 0, aliases: [] });
  expect(characters).toEqual([{ id: 700001, name: "角色", aliases: [], comment: 0, collect: 3 }]);
  db.close();
});
