import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
    [`${BASE}/v0/subjects/900001/characters`]: [{ id: 700001, name: "新角色", type: 1, relation: "主角" }],
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
