import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BangumiDataWorkerClient } from "../src/infrastructure/BangumiDataWorkerClient";

/** 可控的假 Worker：每次 `new Worker` 产生一个新实例，崩溃与回包全由测试驱动。 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  /** 为真时 init 之外的请求自动成功；init 是否自动回包由 `autoInit` 控制。 */
  static autoReply = true;
  static autoInit = true;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  received: Array<{ id: number; method: string }> = [];
  terminated = false;
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(message: unknown) {
    const request = message as { id: number; method: string };
    this.received.push(request);
    const auto = request.method === "init" ? FakeWorker.autoInit : FakeWorker.autoReply;
    if (auto) queueMicrotask(() => this.reply(request.id));
  }
  reply(id: number) {
    this.onmessage?.({ data: { type: "reply", id, ok: true, value: true } } as MessageEvent);
  }
  crash() {
    this.onerror?.({ message: "boom", filename: "worker.ts", lineno: 1, colno: 1 });
  }
  terminate() {
    this.terminated = true;
  }
}

const originalWorker = globalThis.Worker;
const clients: BangumiDataWorkerClient[] = [];

const fast = { baseDelayMs: 10, maxDelayMs: 40, maxRestarts: 3, stableMs: 5_000 };
const INIT = { method: "init", song: { dbPath: "x" }, cee: { dbPath: "x" } } as const;
const QUERY = { method: "song.getSubject", subjectId: "1" } as const;

const createClient = (recovery = fast) => {
  const client = new BangumiDataWorkerClient(undefined, recovery);
  clients.push(client);
  return client;
};
const latest = () => FakeWorker.instances[FakeWorker.instances.length - 1]!;
const until = async (predicate: () => boolean, timeoutMs = 1_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待条件超时");
    await Bun.sleep(2);
  }
};

beforeEach(() => {
  FakeWorker.instances = [];
  FakeWorker.autoReply = true;
  FakeWorker.autoInit = true;
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
});

afterEach(async () => {
  // 先还原全局再收尾，保证 close 不会把定时器留给后面的用例。
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  globalThis.Worker = originalWorker;
});

describe("数据 Worker 崩溃恢复", () => {
  test("崩溃时在途请求立刻被拒，退避结束后新线程重放 init 并恢复服务", async () => {
    const client = createClient();
    await client.init(INIT);
    FakeWorker.autoReply = false;
    const inflight = client.request(QUERY);
    const settled = inflight.then(
      () => "ok",
      (error: { code?: string }) => error.code
    );
    const startedAt = Date.now();
    latest().crash();
    // 在途请求要以明确错误落定，而不是挂到 20 秒的查询超时。
    expect(await settled).toBe("BANGUMI_DATA_UNAVAILABLE");
    expect(Date.now() - startedAt).toBeLessThan(500);

    // 退避期内的新请求快速失败。
    await expect(client.request(QUERY)).rejects.toMatchObject({ code: "BANGUMI_DATA_UNAVAILABLE" });

    // 退避结束：起了第二个线程，并向它重放了 init。
    await until(() => FakeWorker.instances.length === 2);
    FakeWorker.autoReply = true;
    await until(() => FakeWorker.instances[1]!.received.some((m) => m.method === "init"));
    expect(FakeWorker.instances[0]!.terminated).toBe(true);
    // 重放完成后下一次请求成功。
    await until(() => FakeWorker.instances[1]!.received.length >= 1);
    await Bun.sleep(5);
    await expect(client.request(QUERY)).resolves.toBe(true);
  });

  test("重放 init 落定之前，普通请求排队等待，不会撞上未初始化的线程", async () => {
    const client = createClient();
    await client.init(INIT);
    FakeWorker.autoInit = false;
    latest().crash();
    await until(() => FakeWorker.instances.length === 2);
    const second = FakeWorker.instances[1]!;
    // 线程已起但 init 还没回包：此时发起的请求必须压住。
    await until(() => second.received.some((m) => m.method === "init"));
    const query = client.request(QUERY);
    await Bun.sleep(20);
    expect(second.received.map((m) => m.method)).toEqual(["init"]);
    second.reply(second.received[0]!.id);
    await expect(query).resolves.toBe(true);
    expect(second.received.map((m) => m.method)).toEqual(["init", "song.getSubject"]);
  });

  test("首次 init 期间线程崩溃，交给门面的就绪承诺在重放成功后才落定", async () => {
    FakeWorker.autoInit = false;
    const client = createClient();
    const ready = client.init(INIT);
    const outcome = ready.then(
      () => "ready",
      () => "rejected"
    );
    latest().crash();
    await until(() => FakeWorker.instances.length === 2);
    FakeWorker.autoInit = true;
    await until(() => FakeWorker.instances[1]!.received.some((m) => m.method === "init"));
    FakeWorker.instances[1]!.reply(FakeWorker.instances[1]!.received[0]!.id);
    expect(await outcome).toBe("ready");
  });

  test("连续崩溃超过上限后不再重启，请求快速失败", async () => {
    const client = createClient();
    await client.init(INIT);
    // 上限 3 次：前三次崩溃各自重启，第四次崩溃进入停摆。
    for (let round = 1; round <= 3; round += 1) {
      latest().crash();
      await until(() => FakeWorker.instances.length === round + 1);
    }
    latest().crash();
    await Bun.sleep(80);
    expect(FakeWorker.instances.length).toBe(4);
    const startedAt = Date.now();
    await expect(client.request(QUERY)).rejects.toMatchObject({ code: "BANGUMI_DATA_UNAVAILABLE" });
    expect(Date.now() - startedAt).toBeLessThan(100);
  });

  test("崩溃后关停不发 close 请求、也不等超时", async () => {
    const client = createClient();
    await client.init(INIT);
    FakeWorker.autoReply = false;
    latest().crash();
    const startedAt = Date.now();
    await client.close();
    expect(Date.now() - startedAt).toBeLessThan(500);
    // 退避定时器已被取消：不会在关停后又冒出新线程。
    await Bun.sleep(60);
    expect(FakeWorker.instances.length).toBe(1);
  });

  test("线程存活时关停仍会发 close 并回收线程", async () => {
    const client = createClient();
    await client.init(INIT);
    await client.close();
    expect(FakeWorker.instances[0]!.received.map((m) => m.method)).toContain("close");
    expect(FakeWorker.instances[0]!.terminated).toBe(true);
  });
});
