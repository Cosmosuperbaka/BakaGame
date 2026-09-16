import { describe, expect, test } from "bun:test";
import { LocalBangumiProvider } from "../src/infrastructure/LocalBangumiProvider";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 造一对最小的只读数据集文件：provider 只要求文件可打开。 */
const createDatasetFiles = () => {
  const songPath = join(tmpdir(), `bangumi-test-${crypto.randomUUID()}.sqlite`);
  const characterPath = join(tmpdir(), `bangumi-character-test-${crypto.randomUUID()}.sqlite`);
  new Database(songPath).close();
  new Database(characterPath).close();
  return { songPath, characterPath };
};

const removeFiles = async (...paths: string[]) => {
  for (const path of paths) try { await Bun.file(path).delete(); } catch {}
};

describe("LocalBangumiProvider", () => {
  test("searches and loads local records", async () => {
    const songPath = join(tmpdir(), `bangumi-test-${crypto.randomUUID()}.sqlite`);
    const characterPath = join(tmpdir(), `bangumi-character-test-${crypto.randomUUID()}.sqlite`);
    const songDb = new Database(songPath);
    songDb.run("CREATE TABLE subjects (id INTEGER PRIMARY KEY, type INTEGER, name TEXT, name_cn TEXT, infobox TEXT, summary TEXT, date TEXT, nsfw INTEGER, tags TEXT, meta_tags TEXT, score REAL, rank INTEGER, heat INTEGER, image TEXT)");
    songDb.run("CREATE TABLE subject_music_relations (subject_id INTEGER, music_id INTEGER, relation_type INTEGER, relation_order INTEGER, title TEXT, artist TEXT, kind TEXT)");
    songDb.run("CREATE VIRTUAL TABLE subject_search USING fts5(name, name_cn, content='subjects', content_rowid='id', tokenize='trigram')");
    songDb.run("INSERT INTO subjects VALUES (1,2,'Test','测试中心','','简介','2020-01-01',0,'[\"动作\"]','[]',8.5,10,100,'')");
    songDb.run("INSERT INTO subject_search(rowid,name,name_cn) VALUES (1,'Test','测试中心')");
    songDb.run("INSERT INTO subject_music_relations VALUES (1,2,0,0,'主题曲','歌手','opening')");
    songDb.close();
    new Database(characterPath).close();
    const provider = new LocalBangumiProvider({ songPath, characterPath });
    const rows = await provider.searchSubjects("测试中", 5);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].id).toMatch(/^\d+$/);
    expect(rows[0].imageUrl).toBeUndefined();
    const detail = await provider.getSubject(rows[0].id);
    expect(detail.musicTracks).toBeArray();
    provider.close();
    for (const path of [songPath, characterPath]) try { await Bun.file(path).delete(); } catch {}
  });

  test("loads a valid image URL from the Bangumi API", async () => {
    const songPath = join(tmpdir(), `bangumi-image-${crypto.randomUUID()}.sqlite`);
    const characterPath = join(tmpdir(), `bangumi-image-character-${crypto.randomUUID()}.sqlite`);
    const songDb = new Database(songPath);
    songDb.run("CREATE TABLE subjects (id INTEGER PRIMARY KEY, type INTEGER, name TEXT, name_cn TEXT, infobox TEXT, summary TEXT, date TEXT, nsfw INTEGER, tags TEXT, meta_tags TEXT, score REAL, rank INTEGER, heat INTEGER, image TEXT)");
    songDb.run("CREATE TABLE subject_music_relations (subject_id INTEGER, music_id INTEGER, relation_type INTEGER, relation_order INTEGER, title TEXT, artist TEXT, kind TEXT)");
    songDb.run("INSERT INTO subjects VALUES (8,2,'Test','测试','','','2020-01-01',0,'[]','[]',0,0,0,'')");
    songDb.close(); new Database(characterPath).close();
    const fetcher = async () => new Response(JSON.stringify({ images: { large: "https://lain.bgm.tv/pic/cover/l/aa/bb/8_test.jpg" } }), { status: 200 });
    const provider = new LocalBangumiProvider({ songPath, characterPath, imageBase: "https://img.example", apiBase: "https://api.example", fetcher });
    const detail = await provider.getSubject("8");
    expect(detail.imageUrl).toBe("https://img.example/pic/cover/l/aa/bb/8_test.jpg");
    provider.close();
    for (const path of [songPath, characterPath]) try { await Bun.file(path).delete(); } catch {}
  });

  test("剔除版权署名与负 music_id 占位行，只保留真实曲目", async () => {
    // 复刻生产数据集：负 music_id 是版权署名合成占位行（实测 7762 条），
    // 被标成 opening 而排在真实曲目之前，会被拿去网易云搜歌并误配无关歌曲。
    const songPath = join(tmpdir(), `bangumi-credits-${crypto.randomUUID()}.sqlite`);
    const characterPath = join(tmpdir(), `bangumi-credits-char-${crypto.randomUUID()}.sqlite`);
    const songDb = new Database(songPath);
    songDb.run("CREATE TABLE subjects (id INTEGER PRIMARY KEY, type INTEGER, name TEXT, name_cn TEXT, infobox TEXT, summary TEXT, date TEXT, nsfw INTEGER, tags TEXT, meta_tags TEXT, score REAL, rank INTEGER, heat INTEGER, image TEXT)");
    songDb.run("CREATE TABLE subject_music_relations (subject_id INTEGER, music_id INTEGER, relation_type INTEGER, relation_order INTEGER, title TEXT, artist TEXT, kind TEXT)");
    songDb.run("INSERT INTO subjects VALUES (428735,2,'BanG Dream! It''s MyGO!!!!!','','','','2023-06-29',0,'[]','[]',0,0,0,'')");
    // 负 id 版权伪条目（必须剔除）
    songDb.run("INSERT INTO subject_music_relations VALUES (428735,-4287350001,0,0,'©BanG Dream! Project',NULL,'opening')");
    // 正 id 但标题为版权署名的（文本规则兜底，必须剔除）
    songDb.run("INSERT INTO subject_music_relations VALUES (428735,999999,0,1,'©SUNRISE',NULL,'opening')");
    // 真实曲目（必须保留，且不能被误杀）
    songDb.run("INSERT INTO subject_music_relations VALUES (428735,437672,3003,0,'壱雫空',NULL,'ending')");
    songDb.run("INSERT INTO subject_music_relations VALUES (428735,449998,3005,0,'迷跡波',NULL,'character')");
    songDb.run("INSERT INTO subject_music_relations VALUES (428735,500001,3005,0,'unconditional L♡VE',NULL,'character')");
    songDb.close();
    new Database(characterPath).close();

    const provider = new LocalBangumiProvider({ songPath, characterPath });
    const detail = await provider.getSubject("428735");
    const titles = detail.musicTracks.map((track) => track.title);

    expect(titles).toContain("壱雫空");
    expect(titles).toContain("迷跡波");
    // 带美术字符的正常曲名不得被误杀
    expect(titles).toContain("unconditional L♡VE");
    // 版权伪条目一概不得进入曲目池
    expect(titles.some((title) => title.includes("©"))).toBe(false);

    provider.close();
    for (const path of [songPath, characterPath]) try { await Bun.file(path).delete(); } catch {}
  });

  test("关联类型码映射不得错位：片头曲 / 片尾曲 / 插入歌 / 角色歌", async () => {
    // 复刻真实数据集；旧映射把 3002~3005 整体错位一格，实测会把片头曲标成 ED、
    // 角色歌标成 OP，按曲目类型筛选时选中完全错误的曲目。
    const songPath = join(tmpdir(), `bangumi-kind-${crypto.randomUUID()}.sqlite`);
    const characterPath = join(tmpdir(), `bangumi-kind-char-${crypto.randomUUID()}.sqlite`);
    const songDb = new Database(songPath);
    songDb.run("CREATE TABLE subjects (id INTEGER PRIMARY KEY, type INTEGER, name TEXT, name_cn TEXT, infobox TEXT, summary TEXT, date TEXT, nsfw INTEGER, tags TEXT, meta_tags TEXT, score REAL, rank INTEGER, heat INTEGER, image TEXT)");
    songDb.run("CREATE TABLE subject_music_relations (subject_id INTEGER, music_id INTEGER, relation_type INTEGER, relation_order INTEGER, title TEXT, artist TEXT, kind TEXT)");
    songDb.run("INSERT INTO subjects VALUES (245665,2,'鬼滅の刃','鬼灭之刃','','','2019-04-06',0,'[]','[]',0,0,0,'')");
    // kind 列沿用当年的错误映射值，用于证明关系码才是真相源。
    songDb.run("INSERT INTO subject_music_relations VALUES (245665,437001,3003,0,'紅蓮華',NULL,'ending')");
    songDb.run("INSERT INTO subject_music_relations VALUES (245665,437002,3004,0,'from the edge',NULL,'insert')");
    songDb.run("INSERT INTO subject_music_relations VALUES (245665,437003,3005,0,'竈門炭治郎のうた',NULL,'character')");
    songDb.run("INSERT INTO subject_music_relations VALUES (245665,437004,3002,0,'キャラクターソング Vol.1',NULL,'opening')");
    songDb.run("INSERT INTO subject_music_relations VALUES (245665,437005,3001,0,'鬼滅の刃 オリジナルサウンドトラック',NULL,'theme')");
    // 未映射的关系码（3099 其他）沿用文本兜底分类
    songDb.run("INSERT INTO subject_music_relations VALUES (245665,437006,3099,0,'鬼滅の刃 Remix Collection',NULL,'remix')");
    songDb.close();
    new Database(characterPath).close();

    const provider = new LocalBangumiProvider({ songPath, characterPath });
    const detail = await provider.getSubject("245665");
    const kinds = Object.fromEntries(detail.musicTracks.map((track) => [track.title, track.kind]));

    expect(kinds["紅蓮華"]).toBe("opening");
    expect(kinds["from the edge"]).toBe("ending");
    expect(kinds["竈門炭治郎のうた"]).toBe("insert");
    expect(kinds["キャラクターソング Vol.1"]).toBe("character");
    // 主题歌 / 原声带条目归 theme，再由歌曲自身标注细化为 OST。
    expect(kinds["鬼滅の刃 オリジナルサウンドトラック"]).toBe("theme");
    // 未映射的关系码仍走文本兜底分类
    expect(kinds["鬼滅の刃 Remix Collection"]).toBe("remix");
    provider.close();
    for (const path of [songPath, characterPath]) try { await Bun.file(path).delete(); } catch {}
  });
});

describe("LocalBangumiProvider · Bangumi API 回填缓存", () => {
  test("角色立绘走 /v0/characters/{id} 并经镜像重写", async () => {
    const { songPath, characterPath } = createDatasetFiles();
    const enrichmentPath = join(tmpdir(), `bangumi-enrich-${crypto.randomUUID()}.sqlite`);
    const requested: string[] = [];
    const fetcher = async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response(JSON.stringify({ images: { medium: "https://lain.bgm.tv/pic/crt/l/aa/bb/12393_crt_x.jpg" } }), { status: 200 });
    };
    const provider = new LocalBangumiProvider({ songPath, characterPath, enrichmentPath, imageBase: "https://mirror.example", apiBase: "https://api.example", fetcher });
    expect(await provider.resolveCharacterImage(12393)).toBe("https://mirror.example/pic/crt/l/aa/bb/12393_crt_x.jpg");
    expect(requested).toEqual(["https://api.example/v0/characters/12393"]);
    // 非法 id 不得回源
    expect(await provider.resolveCharacterImage(0)).toBeUndefined();
    expect(await provider.resolveCharacterImage(-1)).toBeUndefined();
    expect(await provider.resolveCharacterImage(1.5)).toBeUndefined();
    expect(requested.length).toBe(1);
    provider.close();
    await removeFiles(songPath, characterPath, enrichmentPath);
  });

  test("回填缓存落盘：重启后不再回源", async () => {
    const { songPath, characterPath } = createDatasetFiles();
    const enrichmentPath = join(tmpdir(), `bangumi-enrich-${crypto.randomUUID()}.sqlite`);
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return new Response(JSON.stringify({ images: { medium: "https://lain.bgm.tv/pic/crt/l/aa/bb/12393_crt_x.jpg" } }), { status: 200 });
    };
    const first = new LocalBangumiProvider({ songPath, characterPath, enrichmentPath, apiBase: "https://api.example", fetcher });
    expect(await first.resolveCharacterImage(12393)).toBe("https://lain.bgm.tv/pic/crt/l/aa/bb/12393_crt_x.jpg");
    expect(calls).toBe(1);
    // 进程内第二次走内存缓存，同样不回源
    await first.resolveCharacterImage(12393);
    expect(calls).toBe(1);
    first.close();

    const second = new LocalBangumiProvider({ songPath, characterPath, enrichmentPath, apiBase: "https://api.example", fetcher });
    expect(await second.resolveCharacterImage(12393)).toBe("https://lain.bgm.tv/pic/crt/l/aa/bb/12393_crt_x.jpg");
    expect(calls).toBe(1);
    second.close();
    await removeFiles(songPath, characterPath, enrichmentPath);
  });

  test("缓存的是上游原始 URL：换镜像地址后无需重新回源", async () => {
    const { songPath, characterPath } = createDatasetFiles();
    const enrichmentPath = join(tmpdir(), `bangumi-enrich-${crypto.randomUUID()}.sqlite`);
    const first = new LocalBangumiProvider({
      songPath, characterPath, enrichmentPath, apiBase: "https://api.example",
      fetcher: async () => new Response(JSON.stringify({ images: { medium: "https://lain.bgm.tv/pic/crt/l/aa/bb/12393_crt_x.jpg" } }), { status: 200 }),
    });
    expect(await first.resolveCharacterImage(12393)).toBe("https://lain.bgm.tv/pic/crt/l/aa/bb/12393_crt_x.jpg");
    first.close();

    let calls = 0;
    const second = new LocalBangumiProvider({
      songPath, characterPath, enrichmentPath, imageBase: "https://mirror.example", apiBase: "https://api.example",
      fetcher: async () => { calls++; throw new Error("换了镜像不该再回源"); },
    });
    expect(await second.resolveCharacterImage(12393)).toBe("https://mirror.example/pic/crt/l/aa/bb/12393_crt_x.jpg");
    expect(calls).toBe(0);
    second.close();
    await removeFiles(songPath, characterPath, enrichmentPath);
  });

  test("回源失败只做短期负缓存，绝不写进回填缓存", async () => {
    const { songPath, characterPath } = createDatasetFiles();
    const enrichmentPath = join(tmpdir(), `bangumi-enrich-${crypto.randomUUID()}.sqlite`);
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls === 1) throw new Error("上游瞬时故障");
      return new Response(JSON.stringify({ images: { medium: "https://lain.bgm.tv/pic/crt/l/aa/bb/12393_crt_x.jpg" } }), { status: 200 });
    };
    const first = new LocalBangumiProvider({ songPath, characterPath, enrichmentPath, apiBase: "https://api.example", fetcher: flaky });
    expect(await first.resolveCharacterImage(12393)).toBeUndefined();
    // 进程内紧接着重试命中负缓存，不再打上游
    expect(await first.resolveCharacterImage(12393)).toBeUndefined();
    expect(calls).toBe(1);
    first.close();

    // 关键断言：失败没有落盘。新进程必须重新回源并能拿到图片——
    // 历史实现把失败永久缓存，一次瞬时超时会让该条目再也拿不到图片。
    const second = new LocalBangumiProvider({ songPath, characterPath, enrichmentPath, apiBase: "https://api.example", fetcher: flaky });
    expect(await second.resolveCharacterImage(12393)).toBe("https://lain.bgm.tv/pic/crt/l/aa/bb/12393_crt_x.jpg");
    expect(calls).toBe(2);
    second.close();
    await removeFiles(songPath, characterPath, enrichmentPath);
  });

  test("上游返回非 2xx 或缺图时不写缓存，恢复后可正常取到", async () => {
    const { songPath, characterPath } = createDatasetFiles();
    const enrichmentPath = join(tmpdir(), `bangumi-enrich-${crypto.randomUUID()}.sqlite`);
    const provider = new LocalBangumiProvider({
      songPath, characterPath, enrichmentPath, apiBase: "https://api.example",
      fetcher: async () => new Response("boom", { status: 500 }),
    });
    expect(await provider.resolveCharacterImage(12393)).toBeUndefined();
    provider.close();

    const cache = new Database(enrichmentPath, { readonly: true });
    const rows = cache.query("SELECT count(*) AS n FROM enrichment").get() as { n: number };
    expect(rows.n).toBe(0);
    cache.close();
    await removeFiles(songPath, characterPath, enrichmentPath);
  });
});
