import { describe, expect, test } from "bun:test";
import { BangumiWorkerProvider } from "../src/infrastructure/BangumiWorkerProvider";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("BangumiWorkerProvider", () => {
  test("runs sqlite query outside the main provider", async () => {
    const songPath = join(tmpdir(), `bangumi-worker-test-${crypto.randomUUID()}.sqlite`);
    const characterPath = join(tmpdir(), `bangumi-worker-character-test-${crypto.randomUUID()}.sqlite`);
    const db = new Database(songPath);
    db.run("CREATE TABLE subjects (id INTEGER PRIMARY KEY, type INTEGER, name TEXT, name_cn TEXT, infobox TEXT, summary TEXT, date TEXT, nsfw INTEGER, tags TEXT, meta_tags TEXT, score REAL, rank INTEGER, heat INTEGER, image TEXT)");
    db.run("CREATE TABLE subject_music_relations (subject_id INTEGER, music_id INTEGER, relation_type INTEGER, relation_order INTEGER, title TEXT, artist TEXT, kind TEXT)");
    db.run("CREATE VIRTUAL TABLE subject_search USING fts5(name, name_cn, content='subjects', content_rowid='id', tokenize='trigram')");
    db.run("INSERT INTO subjects VALUES (1,2,'Test','测试中心','','','2020-01-01',0,'[]','[]',0,0,0,'')");
    db.run("INSERT INTO subject_search(rowid,name,name_cn) VALUES (1,'Test','测试中心')");
    db.close(); new Database(characterPath).close();
    const provider = new BangumiWorkerProvider(songPath, characterPath);
    const rows = await provider.searchSubjects("测试中", 3);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].imageUrl).toContain("/pic/cover/l/");
    await provider.close();
    for (const path of [songPath, characterPath]) try { await Bun.file(path).delete(); } catch {}
  });
});
