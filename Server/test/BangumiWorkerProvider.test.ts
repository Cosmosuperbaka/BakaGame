import { describe, expect, spyOn, test } from "bun:test";
import { BangumiWorkerProvider } from "../src/infrastructure/BangumiWorkerProvider";
import { BangumiDataWorkerClient } from "../src/infrastructure/BangumiDataWorkerClient";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 假 Worker：不真正起线程，对任何请求立即回成功（否则 close 会一直挂到超时）。 */
class SilentWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  postMessage(message: unknown) {
    const { id } = message as { id: number };
    queueMicrotask(() => this.onmessage?.({ data: { id, ok: true, value: true } } as MessageEvent));
  }
  terminate() {}
}

/** 假 Worker：init 的回执由测试手动放行，用来验证「初始化期间查询压住等待」。 */
class DeferredWorker {
  static latest: DeferredWorker | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  initReply: (() => void) | null = null;
  searches = 0;
  constructor() { DeferredWorker.latest = this; }
  postMessage(message: unknown) {
    const request = message as { id: number; method: string };
    if (request.method === "init") {
      const id = request.id;
      this.initReply = () => this.onmessage?.({ data: { id, ok: true, value: true } } as MessageEvent);
    } else if (request.method === "song.searchSubjects") {
      this.searches += 1;
      const id = request.id;
      queueMicrotask(() => this.onmessage?.({ data: { id, ok: true, value: [{ id: "7", name: "Slow", nameCn: "慢查询" }] } } as MessageEvent));
    } else {
      // init 之外的请求（含 close）立即成功，避免 close 挂到超时。
      const id = request.id;
      queueMicrotask(() => this.onmessage?.({ data: { id, ok: true, value: true } } as MessageEvent));
    }
  }
  terminate() {}
}

const withWorker = async <T>(Stub: new () => unknown, run: () => Promise<T>): Promise<T> => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = Stub as unknown as typeof Worker;
  try { return await run(); }
  finally { globalThis.Worker = originalWorker; }
};

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
    // 猜歌与 CCB 共用同一个 Worker：这里走真实装配路径，顺便验证两边能共存。
    const client = new BangumiDataWorkerClient();
    const ready = client.init({ method: "init", song: { dbPath: songPath }, ccb: { dbPath: songPath } });
    const provider = new BangumiWorkerProvider(client, ready);
    const rows = await provider.searchSubjects("测试中", 3);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].imageUrl).toBeUndefined();
    await client.close();
    for (const path of [songPath, characterPath]) try { await Bun.file(path).delete(); } catch {}
    // 真实 Worker：一次 init 要同时建两条数据链路，另有 TS Worker 转译开销。
  }, 30_000);

  test("init 使用独立的长超时窗口，不与查询共用短窗口", async () => {
    const spy = spyOn(globalThis, "setTimeout");
    await withWorker(SilentWorker, async () => {
      const client = new BangumiDataWorkerClient();
      client.init({ method: "init", song: { dbPath: "unused.sqlite" }, ccb: { dbPath: "unused.sqlite" } });
      const delays = spy.mock.calls.map((call) => Number(call[1]));
      // 索引重建分钟级：init 必须是长窗口，否则 ready 被拒后所有查询永久失败。
      // 窗口取 CCB 那侧更长的口径（1 小时），猜歌与 CCB 现在共用一次 init。
      expect(delays).toContain(3_600_000);
      await client.close();
    });
    spy.mockRestore();
  });

  test("慢初始化期间查询等待而非失败，初始化完成后正常返回", async () => {
    await withWorker(DeferredWorker, async () => {
      const client = new BangumiDataWorkerClient();
      const ready = client.init({ method: "init", song: { dbPath: "unused.sqlite" }, ccb: { dbPath: "unused.sqlite" } });
      const provider = new BangumiWorkerProvider(client, ready);
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
      await client.close();
    });
  });
});
