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

/** 假 Worker：所有查询按给定 code 失败，用来验证错误 code 原样透传给 Fallback。 */
class FailingWorker {
  static code = "BANGUMI_DATA_UNAVAILABLE";
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  postMessage(message: unknown) {
    const { id, method } = message as { id: number; method: string };
    const reply = method === "song.searchSubjects"
      ? { id, ok: false, code: FailingWorker.code, message: "本地 Bangumi 数据读取失败" }
      : { id, ok: true, value: true };
    queueMicrotask(() => this.onmessage?.({ data: reply } as MessageEvent));
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
    // 猜歌与 CEE 共用同一个 Worker：这里走真实装配路径，顺便验证两边能共存。
    const client = new BangumiDataWorkerClient();
    const ready = client.init({ method: "init", song: { dbPath: songPath }, cee: { dbPath: songPath } });
    const provider = new BangumiWorkerProvider(client, ready);
    const rows = await provider.searchSubjects("测试中", 3);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].imageUrl).toBeUndefined();
    await client.close();
    for (const path of [songPath, characterPath]) try { await Bun.file(path).delete(); } catch { /* 临时库文件本就可能不存在或已被回收：清理尽力而为，不影响断言 */ }
    // 真实 Worker：一次 init 要同时建两条数据链路，另有 TS Worker 转译开销。
  }, 30_000);

  test("init 使用独立的长超时窗口，不与查询共用短窗口", async () => {
    const spy = spyOn(globalThis, "setTimeout");
    await withWorker(SilentWorker, async () => {
      const client = new BangumiDataWorkerClient();
      void client.init({ method: "init", song: { dbPath: "unused.sqlite" }, cee: { dbPath: "unused.sqlite" } });
      const delays = spy.mock.calls.map((call) => Number(call[1]));
      // 索引重建分钟级：init 必须是长窗口，否则 ready 被拒后所有查询永久失败。
      // 窗口取 CEE 那侧更长的口径（1 小时），猜歌与 CEE 现在共用一次 init。
      expect(delays).toContain(3_600_000);
      await client.close();
    });
    spy.mockRestore();
  });

  test("慢初始化期间查询等待而非失败，初始化完成后正常返回", async () => {
    await withWorker(DeferredWorker, async () => {
      const client = new BangumiDataWorkerClient();
      const ready = client.init({ method: "init", song: { dbPath: "unused.sqlite" }, cee: { dbPath: "unused.sqlite" } });
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

  test("猜歌查询的 worker 错误 code 原样透传，供 FallbackBangumiProvider 识别降级", async () => {
    // 生产事故回归：搜索服务（Meilisearch）故障时，worker 必须把猜歌请求的错误归一成
    // BANGUMI_DATA_UNAVAILABLE —— FallbackBangumiProvider 只认这个 code 才会回源官方 API。
    // 若被错记成 CEE_DATA_UNAVAILABLE（曾经的兜底分支写法），猜歌就永远无法降级。
    await withWorker(FailingWorker, async () => {
      const client = new BangumiDataWorkerClient();
      const ready = client.init({ method: "init", song: { dbPath: "unused.sqlite" }, cee: { dbPath: "unused.sqlite" } });
      const provider = new BangumiWorkerProvider(client, ready);
      await expect(provider.searchSubjects("关键词", 3)).rejects.toMatchObject({ code: "BANGUMI_DATA_UNAVAILABLE" });
      await client.close();
    });
  });
});

describe("BangumiWorkerProvider 其余门面方法", () => {
  /** 假客户端：记录每个请求体并按方法返回预设值，门面本身不应有任何自有逻辑。 */
  const createFacade = (respond: (payload: Record<string, unknown>) => unknown) => {
    const calls: Array<Record<string, unknown>> = [];
    const client = {
      request: async (payload: Record<string, unknown>) => {
        calls.push(payload);
        return respond(payload);
      },
    };
    return { calls, facade: new BangumiWorkerProvider(client as unknown as BangumiDataWorkerClient, Promise.resolve(true)) };
  };

  test("getSubject 与两个图片接口原样转发方法与参数，并透传返回值", async () => {
    const { calls, facade } = createFacade((payload) => {
      switch (payload.method) {
        case "song.getSubject":
          return { id: "1", name: "Hit", musicTracks: [] };
        case "song.resolveCharacterImage":
          return "https://img.example/r/400/x.jpg";
        default:
          return undefined;
      }
    });

    expect((await facade.getSubject("1")).name).toBe("Hit");
    expect(calls[0]).toEqual({ method: "song.getSubject", subjectId: "1" });

    expect(await facade.resolveCharacterImage(123)).toBe("https://img.example/r/400/x.jpg");
    expect(calls[1]).toEqual({ method: "song.resolveCharacterImage", characterId: 123 });

    expect(await facade.resolveSubjectImage("5")).toBeUndefined();
    expect(calls[2]).toEqual({ method: "song.resolveSubjectImage", subjectId: "5" });
  });

  test("chooseRandomSubject：搜索 + 详情两跳取一条，空候选报错", async () => {
    const { facade } = createFacade((payload) => {
      if (payload.method === "song.searchSubjects") return [{ id: "1" }, { id: "2" }];
      return { id: payload.subjectId, name: `S-${payload.subjectId}`, musicTracks: [] };
    });

    expect((await facade.chooseRandomSubject({}, () => 0)).id).toBe("1");
    expect((await facade.chooseRandomSubject({ subjectLimit: 99 }, () => 0.99)).id).toBe("2");

    const empty = createFacade(() => []).facade;
    await expect(empty.chooseRandomSubject()).rejects.toMatchObject({ code: "BANGUMI_NO_SUBJECT" });
  });
});
