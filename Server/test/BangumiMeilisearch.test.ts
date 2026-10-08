import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Meilisearch } from "meilisearch";
import { BangumiMeilisearch } from "../src/infrastructure/BangumiMeilisearch";

/** 歌库最小 schema：复刻生产库——没有 rating_count（本次修复的回归点）。 */
const createSongSchema = () => {
  const path = join(tmpdir(), `bangumi-meili-song-${crypto.randomUUID()}.sqlite`);
  const db = new Database(path);
  db.run("CREATE TABLE subjects (id INTEGER PRIMARY KEY, type INTEGER NOT NULL, name TEXT NOT NULL, name_cn TEXT NOT NULL, infobox TEXT NOT NULL, summary TEXT NOT NULL, date TEXT NOT NULL, nsfw INTEGER NOT NULL, tags TEXT NOT NULL, meta_tags TEXT NOT NULL, score REAL NOT NULL, rank INTEGER NOT NULL, heat INTEGER NOT NULL, image TEXT NOT NULL)");
  db.run("INSERT INTO subjects VALUES (11,2,'某番','某番中文','','摘要','2011-04-01',0,'[]','[]',8.4,321,1234,'')");
  db.close();
  return path;
};

/** 角色库最小 schema：有 rating_count、无 rank/aliases。 */
const createCharacterSchema = () => {
  const path = join(tmpdir(), `bangumi-meili-char-${crypto.randomUUID()}.sqlite`);
  const db = new Database(path);
  db.run("CREATE TABLE subjects (id INTEGER PRIMARY KEY, type INTEGER NOT NULL, name TEXT NOT NULL, name_cn TEXT NOT NULL, date TEXT NOT NULL, nsfw INTEGER NOT NULL, raw_tags TEXT NOT NULL, meta_tags TEXT NOT NULL, score REAL NOT NULL, rating_count INTEGER NOT NULL, heat INTEGER NOT NULL)");
  db.run("INSERT INTO subjects VALUES (7,2,'另一番','另一番中文','2015-10-01',0,'{}','{}',9.1,999,88)");
  db.close();
  return path;
};

/** 假 Meilisearch 客户端：记录写入的文档批次，索引任务全部即时成功。 */
const createFakeClient = () => {
  const batches: Array<{ index: string; docs: Array<Record<string, unknown>> }> = [];
  const task = { waitTask: async () => ({ status: "succeeded" }) };
  const client = {
    health: async () => ({ status: "available" }),
    index: (uid: string) => ({
      uid,
      fetchInfo: async () => ({ uid }),
      updateSettings: () => task,
      getStats: async () => ({ numberOfDocuments: 0 }),
      getDocument: async () => ({ revision: "stale-revision" }),
      deleteAllDocuments: () => task,
      addDocuments: (docs: Array<Record<string, unknown>>) => {
        batches.push({ index: uid, docs });
        return task;
      },
    }),
    createIndex: () => task,
  };
  return { client: client as unknown as Meilisearch, batches };
};

describe("Bangumi 搜索索引初始化", () => {
  test("歌库缺少 rating_count 列时回退归零且初始化不崩溃", async () => {
    const path = createSongSchema();
    const { client, batches } = createFakeClient();
    const db = new Database(path, { readonly: true });
    try {
      await new BangumiMeilisearch({ client }).initialize(db, path);
    } finally {
      db.close();
    }
    const subjects = batches.find((batch) => batch.index === "bangumi_subjects");
    expect(subjects?.docs).toHaveLength(1);
    expect(subjects?.docs[0]).toMatchObject({
      id: 11, name: "某番", aliases: ["某番中文"], date: 20110401, score: 8.4,
      rating_count: 0, heat: 1234, rank: 321, type: 2, nsfw: false,
    });
    expect(batches.some((batch) => batch.index === "bangumi_search_metadata")).toBe(true);
    try { await Bun.file(path).delete(); } catch {}
  });

  test("含 rating_count 的库按真实值写入文档", async () => {
    const path = createCharacterSchema();
    const { client, batches } = createFakeClient();
    const db = new Database(path, { readonly: true });
    try {
      await new BangumiMeilisearch({ client }).initialize(db, path);
    } finally {
      db.close();
    }
    const subjects = batches.find((batch) => batch.index === "bangumi_subjects");
    expect(subjects?.docs).toHaveLength(1);
    expect(subjects?.docs[0]).toMatchObject({ id: 7, rating_count: 999, rank: 0, aliases: ["另一番中文"] });
    try { await Bun.file(path).delete(); } catch {}
  });
});
