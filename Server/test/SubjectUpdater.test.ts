import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BangumiImageStore } from "../src/infrastructure/BangumiImageStore";
import { DEFAULT_REFRESH_TIERS, SubjectUpdater } from "../src/infrastructure/SubjectUpdater";
import type { BangumiSearchIndex, SubjectSearchDocument } from "../src/infrastructure/BangumiSearchIndex";

const DAY = 24 * 60 * 60 * 1_000;
const HOUR = 60 * 60 * 1_000;

interface FetchCall { url: string; accept?: string }
interface FetchSpec { status?: number; body?: unknown; bytes?: Uint8Array }

/**
 * 假上游：`spec` 按 URL 决定响应，同时把每次调用记下来 ——
 * 更新器最核心的承诺是「该发多少请求」，这份记录就是主要断言对象。
 */
function upstream(spec: (url: string) => FetchSpec) {
  const calls: FetchCall[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, accept: String((init?.headers as Record<string, string> | undefined)?.Accept ?? "") });
    const matched = spec(url);
    // 复制一份再交给 Response：bun 的 Uint8Array 泛型与 DOM BodyInit 的 ArrayBuffer 约束对不上。
    const payload: BodyInit = matched.bytes ? new Uint8Array(matched.bytes) : JSON.stringify(matched.body ?? {});
    return new Response(payload, { status: matched.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

function dataset(directory: string, rows: Array<{ id: number; heat: number; name?: string }>) {
  const dbPath = join(directory, "bangumi.sqlite");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE subjects (
    id INTEGER PRIMARY KEY, type INTEGER NOT NULL, name TEXT NOT NULL, name_cn TEXT NOT NULL,
    aliases TEXT NOT NULL, infobox TEXT NOT NULL, summary TEXT NOT NULL, date TEXT NOT NULL,
    nsfw INTEGER NOT NULL, tags TEXT NOT NULL, raw_tags TEXT NOT NULL, meta_tags TEXT NOT NULL,
    score REAL NOT NULL, rating_count INTEGER NOT NULL, heat INTEGER NOT NULL, rank INTEGER NOT NULL,
    image TEXT NOT NULL
  )`);
  const insert = db.query("INSERT INTO subjects VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  for (const row of rows) {
    insert.run(row.id, 2, row.name ?? `作品${row.id}`, "", "[]", "", "", "2020-01-01", 0, "[]", "{}", "[]", 0, 0, row.heat, 0, "");
  }
  return db;
}

/** 索引桩：记录收到的文档，可选地抛错（测重试）。 */
function searchStub(options: { fail?: boolean } = {}) {
  const received: SubjectSearchDocument[][] = [];
  const index = {
    updateSubjects: async (documents: SubjectSearchDocument[]) => {
      if (options.fail) throw new Error("索引不可用");
      received.push(documents);
    },
    toSubjectDocument: (row: Record<string, unknown>): SubjectSearchDocument => ({
      id: Number(row.id), name: String(row.name), aliases: [], tag: [], meta_tag: [],
      date: 20_210_506, score: Number(row.score ?? 0), rating_count: Number(row.rating_count ?? 0),
      heat: Number(row.heat ?? 0), rank: Number(row.rank ?? 0), type: Number(row.type ?? 0),
    }),
  } as unknown as BangumiSearchIndex;
  return { index, received };
}

function imageStore(directory: string, shards = 2) {
  const dir = join(directory, "images");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < shards; i += 1) {
    const db = new Database(join(dir, `images-${String(i).padStart(2, "0")}.sqlite`));
    db.exec("CREATE TABLE images (path TEXT PRIMARY KEY, bytes BLOB NOT NULL, content_type TEXT NOT NULL, fetched_at INTEGER NOT NULL);");
    db.close();
  }
  return dir;
}

/** avif 只需前 16 字节内出现 `ftypav` 魔数。 */
const AVIF = new Uint8Array([0, 0, 0, 32, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0, 0, 0, 0]);

/**
 * Windows 上 SQLite 刚关闭时句柄释放有延迟，直接删临时目录会撞 EBUSY（且删掉一半
 * 会留下垃圾）。删不掉就等一下重试 —— 测试用例的正确性不依赖清理。
 */
async function withTemp<T>(run: (directory: string) => T | Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-updater-"));
  try { return await run(directory); }
  finally {
    for (let attempt = 0; attempt < 5 && existsSync(directory); attempt += 1) {
      try { rmSync(directory, { recursive: true, force: true }); }
      catch { await Bun.sleep(50); }
    }
  }
}

test("三层分位：热度前 20% 两天一刷、中间 30% 一周、其余一个月", async () => {
  await withTemp(async (directory) => {
    const db = dataset(directory, Array.from({ length: 10 }, (_, i) => ({ id: i + 1, heat: 10 - i })));
    const base = Date.parse("2026-10-10T12:00:00Z");
    const { calls, fetcher } = upstream(() => ({ body: { name: "x" } }));
    const updater = new SubjectUpdater({
      db, base: "https://api.bgm.tv", tiers: DEFAULT_REFRESH_TIERS, fetcher,
      now: () => base, sleep: () => Promise.resolve(),
    });
    // 全部刷新于 3 天前：只有第一层（间隔 2 天）到期。
    const seed = db.query("INSERT INTO bangumi_refresh VALUES (?,?,?,?,?)");
    for (let i = 1; i <= 10; i += 1) seed.run(i, 0, base - 3 * DAY, 0, 0);
    expect(await updater.runRound()).toBe(2);
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.bgm.tv/v0/subjects/1", "https://api.bgm.tv/v0/subjects/2",
    ]);

    // 8 天前：第一层 + 第二层（共 5 条）到期。
    db.exec("DELETE FROM bangumi_refresh");
    for (let i = 1; i <= 10; i += 1) seed.run(i, 0, base - 8 * DAY, 0, 0);
    calls.length = 0;
    expect(await updater.runRound()).toBe(5);
    expect(calls).toHaveLength(5);

    // 31 天前：全部到期（分层只影响节奏，不影响最终都会刷新）。
    db.exec("DELETE FROM bangumi_refresh");
    for (let i = 1; i <= 10; i += 1) seed.run(i, 0, base - 31 * DAY, 0, 0);
    calls.length = 0;
    expect(await updater.runRound()).toBe(10);
    db.close();
  });
}, 30_000);

test("分层每轮按当前热度重算：作品变热后会被刷得更勤", async () => {
  await withTemp(async (directory) => {
    const db = dataset(directory, [{ id: 1, heat: 5 }, { id: 2, heat: 100 }]);
    const { calls, fetcher } = upstream(() => ({ body: { name: "x" } }));
    const updater = new SubjectUpdater({ db, base: "https://api.bgm.tv", fetcher, now: () => 0, sleep: () => Promise.resolve() });
    expect(await updater.runRound()).toBe(2);
    // 3 天后：只有当时最热的那条（id=2，ratio 0）到期。
    db.query("UPDATE subjects SET heat = ? WHERE id = ?").run(999, 1);
    const later = new SubjectUpdater({ db, base: "https://api.bgm.tv", fetcher, now: () => 3 * DAY, sleep: () => Promise.resolve() });
    calls.length = 0;
    expect(await later.runRound()).toBe(1);
    expect(calls[0]!.url).toBe("https://api.bgm.tv/v0/subjects/1");
    db.close();
  });
});

test("限速随玩家数在 min~max 之间线性放大", async () => {
  await withTemp((directory) => {
    const db = dataset(directory, [{ id: 1, heat: 1 }]);
    const updater = new SubjectUpdater({
      db, base: "https://api.bgm.tv", minRate: 10, maxRate: 100, playerScale: 20, now: () => 0, sleep: () => Promise.resolve(),
    });
    expect(updater.rate).toBe(10);
    updater.reportLoad(10);
    expect(updater.rate).toBe(55);
    updater.reportLoad(20);
    expect(updater.rate).toBe(100);
    updater.reportLoad(999);
    expect(updater.rate).toBe(100);
    updater.reportLoad(Number.NaN);
    expect(updater.rate).toBe(10);
    db.close();
  });
});

test("刷新成功：覆盖字段、入索引队列、flush 后索引收到文档且队列清空", async () => {
  await withTemp(async (directory) => {
    const db = dataset(directory, [{ id: 8, heat: 100 }]);
    const body = {
      name: "新版标题", name_cn: "新中文名", date: "2021-05-06", summary: "简介", infobox: "{}",
      tags: [{ name: "科幻", count: 12 }], meta_tags: ["SF"], rating: { score: 8.1, total: 4321, rank: 77 },
      collection: { doing: 100, collect: 900 }, images: { large: "https://lain.bgm.tv/pic/cover/l/ab/cd/8.jpg" },
    };
    const { fetcher } = upstream(() => ({ body }));
    const { index, received } = searchStub();
    const updater = new SubjectUpdater({
      db, base: "https://api.bgm.tv", search: index, fetcher, now: () => 1_000, sleep: () => Promise.resolve(),
    });
    expect(await updater.refresh(8)).toBe(true);

    const row = db.query("SELECT * FROM subjects WHERE id = 8").get() as Record<string, unknown>;
    expect(row.name).toBe("新版标题");
    expect(row.name_cn).toBe("新中文名");
    expect(row.date).toBe("2021-05-06");
    expect(row.score).toBe(8.1);
    expect(row.rating_count).toBe(4321);
    expect(row.rank).toBe(77);
    expect(row.heat).toBe(1000);            // 收藏各桶求和
    expect(JSON.parse(String(row.tags))).toEqual(["科幻"]);
    expect(JSON.parse(String(row.raw_tags))).toEqual({ 科幻: 12 });
    expect(String(row.image)).toBe("https://lain.bgm.tv/pic/cover/l/ab/cd/8.jpg");
    // 类型与 nsfw 是数据集的裁剪依据，更新器绝不覆盖。
    expect(row.type).toBe(2);
    expect(row.nsfw).toBe(0);

    expect(await updater.flushIndex()).toBe(1);
    expect(received[0]).toEqual([{
      id: 8, name: "新版标题", aliases: [], tag: [], meta_tag: [], date: 20_210_506,
      score: 8.1, rating_count: 4321, heat: 1000, rank: 77, type: 2,
    }]);
    expect(db.query("SELECT count(*) AS n FROM bangumi_index_pending").get()).toEqual({ n: 0 });
    db.close();
  });
});

test("上游缺字段时不抹掉既有热度与封面", async () => {
  await withTemp(async (directory) => {
    const db = dataset(directory, [{ id: 3, heat: 500 }]);
    db.query("UPDATE subjects SET image = 'https://lain.bgm.tv/pic/cover/l/ab/cd/3.jpg' WHERE id = 3").run();
    const { fetcher } = upstream(() => ({ body: { name: "只有名字" } }));
    const updater = new SubjectUpdater({ db, base: "https://api.bgm.tv", fetcher, now: () => 0, sleep: () => Promise.resolve() });
    expect(await updater.refresh(3)).toBe(true);
    const row = db.query("SELECT heat, image FROM subjects WHERE id = 3").get() as { heat: number; image: string };
    expect(row.heat).toBe(500);
    expect(row.image).toBe("https://lain.bgm.tv/pic/cover/l/ab/cd/3.jpg");
    db.close();
  });
});

test("失败退避：指数后推，成功清零", async () => {
  await withTemp(async (directory) => {
    const db = dataset(directory, [{ id: 5, heat: 10 }]);
    const { fetcher } = upstream(() => ({ status: 500, body: {} }));
    const warnings: string[] = [];
    const updater = new SubjectUpdater({
      db, base: "https://api.bgm.tv", fetcher, logger: { warn: (message) => warnings.push(message) },
      now: () => 1_000, sleep: () => Promise.resolve(),
    });
    const state = () => db.query("SELECT failures, next_at, refreshed_at FROM bangumi_refresh WHERE subject_id = 5").get() as { failures: number; next_at: number; refreshed_at: number };
    expect(await updater.refresh(5)).toBe(false);
    expect(state().failures).toBe(1);
    expect(state().next_at - state().refreshed_at).toBe(HOUR);
    expect(warnings.some((message) => message.includes("刷新失败"))).toBe(true);

    // 新鲜度没过（2 天）时即便 now 很大也不该重复打扰。
    const sameDay = new SubjectUpdater({ db, base: "https://api.bgm.tv", fetcher, now: () => 2 * HOUR, sleep: () => Promise.resolve() });
    expect(await sameDay.runRound()).toBe(0);

    // 过了新鲜度窗口再试一次：失败计数累加、退避翻倍（本轮全是 500，成功数为 0，
    // 所以看的是「确实发起了请求」而不是返回值）。
    const { calls: retryCalls, fetcher: retryFetcher } = upstream(() => ({ status: 500, body: {} }));
    const retry = new SubjectUpdater({ db, base: "https://api.bgm.tv", fetcher: retryFetcher, now: () => 3 * DAY, sleep: () => Promise.resolve() });
    expect(await retry.runRound()).toBe(0);
    expect(retryCalls).toHaveLength(1);
    expect(state().failures).toBe(2);
    expect(state().next_at - state().refreshed_at).toBe(2 * HOUR);

    // 上游恢复 → 失败计数清零。
    const healed = new SubjectUpdater({
      db, base: "https://api.bgm.tv", fetcher: upstream(() => ({ body: { name: "好了" } })).fetcher,
      now: () => 10 * DAY, sleep: () => Promise.resolve(),
    });
    expect(await healed.refresh(5)).toBe(true);
    expect(state().failures).toBe(0);
    db.close();
  });
});

test("nsfw 守卫：上游标记 nsfw 的条目不落库且长期不再尝试", async () => {
  await withTemp(async (directory) => {
    const db = dataset(directory, [{ id: 9, heat: 10 }]);
    const { fetcher } = upstream(() => ({ body: { name: "不该进来的", nsfw: true } }));
    const updater = new SubjectUpdater({ db, base: "https://api.bgm.tv", fetcher, now: () => 2_000, sleep: () => Promise.resolve() });
    expect(await updater.refresh(9)).toBe(false);
    expect((db.query("SELECT name FROM subjects WHERE id = 9").get() as { name: string }).name).toBe("作品9");
    const row = db.query("SELECT next_at, refreshed_at FROM bangumi_refresh WHERE subject_id = 9").get() as { next_at: number; refreshed_at: number };
    expect(row.next_at - row.refreshed_at).toBe(30 * DAY);
    db.close();
  });
});

test("缺图才下载：只回源一次并落库，已有则不再请求", async () => {
  await withTemp(async (directory) => {
    const db = dataset(directory, [{ id: 11, heat: 10 }]);
    const { calls, fetcher } = upstream((url) => url.includes("/pic/cover/")
      ? { bytes: AVIF }
      : { body: { name: "有封面", images: { large: "https://lain.bgm.tv/pic/cover/l/ab/cd/11.jpg" } } });
    const images = BangumiImageStore.open(imageStore(directory))!;
    const updater = new SubjectUpdater({
      db, base: "https://api.bgm.tv", images, imageSource: "https://bangumi.baka.website",
      fetcher, now: () => 0, sleep: () => Promise.resolve(),
    });
    expect(await updater.refresh(11)).toBe(true);
    // 作品封面按构建脚本降档到 /r/200/。
    expect(images.has("/r/200/pic/cover/l/ab/cd/11.jpg")).toBe(true);
    expect(calls.filter((call) => call.accept === "image/avif")).toHaveLength(1);

    expect(await updater.refresh(11)).toBe(true);
    expect(calls.filter((call) => call.accept === "image/avif")).toHaveLength(1);
    images.close();
    db.close();
  });
});

test("非 avif 响应不入库（坏字节一旦入库就再也不会重下）", async () => {
  await withTemp(async (directory) => {
    const db = dataset(directory, [{ id: 12, heat: 10 }]);
    const { fetcher } = upstream((url) => url.includes("/pic/cover/")
      ? { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]) }
      : { body: { name: "封面是 jpeg", images: { large: "https://lain.bgm.tv/pic/cover/l/ab/cd/12.jpg" } } });
    const images = BangumiImageStore.open(imageStore(directory))!;
    const updater = new SubjectUpdater({
      db, base: "https://api.bgm.tv", images, imageSource: "https://bangumi.baka.website",
      fetcher, now: () => 0, sleep: () => Promise.resolve(),
    });
    await updater.refresh(12);
    expect(images.has("/r/200/pic/cover/l/ab/cd/12.jpg")).toBe(false);
    images.close();
    db.close();
  });
});

test("索引同步失败重试，超过上限就丢弃", async () => {
  await withTemp(async (directory) => {
    const db = dataset(directory, [{ id: 21, heat: 10 }]);
    const { fetcher } = upstream(() => ({ body: { name: "x" } }));
    const { index } = searchStub({ fail: true });
    const updater = new SubjectUpdater({ db, base: "https://api.bgm.tv", search: index, fetcher, now: () => 0, sleep: () => Promise.resolve() });
    await updater.refresh(21);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(await updater.flushIndex()).toBe(0);
      const row = db.query("SELECT attempts FROM bangumi_index_pending WHERE subject_id = 21").get() as { attempts: number } | null;
      expect(row?.attempts).toBe(attempt);
    }
    // 第 5 次仍失败：丢弃，避免一条坏数据永远占着队列。
    expect(await updater.flushIndex()).toBe(0);
    expect(db.query("SELECT count(*) AS n FROM bangumi_index_pending").get()).toEqual({ n: 0 });
    db.close();
  });
});

test("备份期间暂停：pause 后本轮不再发请求，resume 后恢复", async () => {
  await withTemp(async (directory) => {
    const db = dataset(directory, [{ id: 31, heat: 10 }]);
    const { calls, fetcher } = upstream(() => ({ body: { name: "x" } }));
    const updater = new SubjectUpdater({ db, base: "https://api.bgm.tv", fetcher, now: () => 0, sleep: () => Promise.resolve() });
    updater.pause();
    expect(await updater.runRound()).toBe(0);
    expect(calls).toHaveLength(0);
    updater.resume();
    expect(await updater.runRound()).toBe(1);
    expect(calls).toHaveLength(1);
    db.close();
  });
});

test("start/stop 控制循环，stats 给出排障快照", async () => {
  await withTemp((directory) => {
    const db = dataset(directory, [{ id: 41, heat: 10 }]);
    // fetcher 必须给桩：start() 会立刻排一轮，真 fetch 会把测试变成联网测试。
    const { fetcher } = upstream(() => ({ body: { name: "x" } }));
    const updater = new SubjectUpdater({ db, base: "https://api.bgm.tv", fetcher, now: () => 0, sleep: () => Promise.resolve() });
    updater.start();
    expect(updater.stats().running).toBe(true);
    updater.stop();
    expect(updater.stats().running).toBe(false);
    expect(updater.stats().rate).toBe(10);
    expect(updater.stats().pendingIndex).toBe(0);
    db.close();
  });
});

test("按需队列：玩家看过的条目不受单轮上限挤掉，重复登记只刷一次", async () => {
  await withTemp(async (directory) => {
    const db = dataset(directory, [{ id: 51, heat: 30 }, { id: 52, heat: 20 }, { id: 53, heat: 10 }]);
    const { calls, fetcher } = upstream(() => ({ body: { name: "x" } }));
    // 单轮上限 1 条：常规队列每轮只带最热的一条，其余靠按需补上。
    const updater = new SubjectUpdater({
      db, base: "https://api.bgm.tv", fetcher, roundLimit: 1, now: () => 0, sleep: () => Promise.resolve(),
    });
    updater.requestRefresh(52);
    updater.requestRefresh(52);
    updater.requestRefresh(53);
    expect(await updater.runRound()).toBe(3);
    expect(calls).toHaveLength(3);

    // 都已刷新 → 下一轮不再重复打扰上游。
    calls.length = 0;
    expect(await updater.runRound()).toBe(0);
    expect(calls).toHaveLength(0);
    db.close();
  });
});

test("首轮基线：登记为「此刻已刷新」后不会一上线就刷全库，且不覆盖已有记录", async () => {
  await withTemp(async (directory) => {
    const db = dataset(directory, [{ id: 71, heat: 10 }, { id: 72, heat: 5 }]);
    const { calls, fetcher } = upstream(() => ({ body: { name: "x" } }));
    const updater = new SubjectUpdater({ db, base: "https://api.bgm.tv", fetcher, now: () => 0, sleep: () => Promise.resolve() });
    // 不登记：两条都算「从未刷新」→ 全刷。
    expect(await updater.runRound()).toBe(2);

    db.exec("DELETE FROM bangumi_refresh");
    // 72 已有记录（刷新于 1 天前），登记不应覆盖它。
    db.query("INSERT INTO bangumi_refresh VALUES (?,?,?,?,?)").run(72, 0, -DAY, 0, 0);
    const seeded = new SubjectUpdater({ db, base: "https://api.bgm.tv", fetcher, now: () => 0, sleep: () => Promise.resolve() });
    expect(seeded.markDatasetFresh()).toBe(1);
    const row = db.query("SELECT refreshed_at, tier FROM bangumi_refresh WHERE subject_id = 72").get() as { refreshed_at: number; tier: number };
    expect(row.refreshed_at).toBe(-DAY);
    expect(row.tier).toBe(0);

    calls.length = 0;
    expect(await seeded.runRound()).toBe(0);
    expect(calls).toHaveLength(0);
    db.close();
  });
});

test("状态表建在数据集里：重建实例不丢已有进度", async () => {
  await withTemp((directory) => {
    const db = dataset(directory, [{ id: 61, heat: 10 }]);
    const first = new SubjectUpdater({ db, base: "https://api.bgm.tv", now: () => 0, sleep: () => Promise.resolve() });
    first.pause();
    const second = new SubjectUpdater({ db, base: "https://api.bgm.tv", now: () => 0, sleep: () => Promise.resolve() });
    // 暂停是实例状态（进程级），持久化的是刷新进度。
    expect(second.stats().paused).toBe(false);
    expect(second.stats().refreshed).toBe(0);
    db.close();
  });
});
