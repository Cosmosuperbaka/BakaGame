import { describe, expect, spyOn, test } from "bun:test";
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
    const provider = new BangumiWorkerProvider({ songPath, characterPath });
    const rows = await provider.searchSubjects("测试中", 3);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].imageUrl).toBeUndefined();
    await provider.close();
    for (const path of [songPath, characterPath]) try { await Bun.file(path).delete(); } catch {}
  });

  test("init 使用独立的长超时窗口，不与查询共用短窗口", async () => {
    class SilentWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      postMessage(_message: unknown) {}
      terminate() {}
    }
    const originalWorker = globalThis.Worker;
    const spy = spyOn(globalThis, "setTimeout");
    try {
      globalThis.Worker = SilentWorker as unknown as typeof Worker;
      const provider = new BangumiWorkerProvider({ songPath: "unused-song.sqlite", characterPath: "unused-character.sqlite" });
      const delays = spy.mock.calls.map((call) => Number(call[1]));
      // 索引重建分钟级：init 必须是长窗口（600s），否则 ready 被拒后所有查询永久失败。
      expect(delays).toContain(600_000);
      await provider.close();
    } finally {
      globalThis.Worker = originalWorker;
      spy.mockRestore();
    }
  });

  test("慢初始化期间查询等待而非失败，初始化完成后正常返回", async () => {
    class DeferredWorker {
      static latest: DeferredWorker | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      initReply: (() => void) | null = null;
      searches = 0;
      constructor() { DeferredWorker.latest = this; }
      postMessage(message: unknown) {
        const request = message as { id: number; method: string; keyword?: string };
        if (request.method === "init") {
          const id = request.id;
          this.initReply = () => this.onmessage?.({ data: { id, ok: true, value: true } } as MessageEvent);
        } else if (request.method === "searchSubjects") {
          this.searches += 1;
          const id = request.id;
          queueMicrotask(() => this.onmessage?.({ data: { id, ok: true, value: [{ id: "7", name: "Slow", nameCn: "慢查询" }] } } as MessageEvent));
        }
      }
      terminate() {}
    }
    const originalWorker = globalThis.Worker;
    try {
      globalThis.Worker = DeferredWorker as unknown as typeof Worker;
      const provider = new BangumiWorkerProvider({ songPath: "unused-song.sqlite", characterPath: "unused-character.sqlite" });
      const worker = DeferredWorker.latest!;
      const pending = provider.searchSubjects("关键词", 3);
      await Bun.sleep(5);
      // 初始化还没完成：查询必须被压住等待，而不是提前发出或直接失败。
      expect(worker.searches).toBe(0);
      worker.initReply?.();
      const rows = await pending;
      expect(worker.searches).toBe(1);
      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe("7");
      await provider.close();
    } finally {
      globalThis.Worker = originalWorker;
    }
  });
});

