import { describe, expect, test } from "bun:test";
import { LocalBangumiProvider } from "../src/infrastructure/LocalBangumiProvider";
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    const provider = new LocalBangumiProvider(songPath, characterPath);
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
    const provider = new LocalBangumiProvider(songPath, characterPath, "https://img.example", "https://api.example", fetcher);
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

    const provider = new LocalBangumiProvider(songPath, characterPath);
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
});
