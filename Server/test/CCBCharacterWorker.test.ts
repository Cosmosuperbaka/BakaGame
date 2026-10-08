import { expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { CCBCharacterWorkerProvider } from "../src/infrastructure/CCBCharacterWorkerProvider";
import { createDefaultCCBSettings } from "../src/shared/CCB";
import { createCCBCharacterFixture } from "./CCBCharacterFixtures";

// Windows Bun 1.3.14 的 rejects 匹配器会阻塞 Worker 的异步错误回包；先原生 await 再断言。
const rejectionOf = (request: Promise<unknown>) => request.then(() => null, (error: unknown) => error);

test("角色工作线程并发查询隔离对象且关闭后拒绝请求", async () => {
  const fixture = createCCBCharacterFixture();
  const provider = new CCBCharacterWorkerProvider(fixture);
  try {
    const settings = { ...createDefaultCCBSettings(), startYear: 2020, endYear: 2020, topNSubjects: 1 };
    const [characters, subjects, selected] = await Promise.all([
      provider.searchCharacters("牧濑"), provider.searchSubjects("游戏"), provider.chooseRandomCharacter(settings, () => 0),
    ]);
    expect(characters.map((row) => row.id)).toEqual([1]);
    expect(subjects.map((row) => row.id)).toEqual([11]);
    expect(selected.id).toBe(1);
    selected.characterTags.push("客户端修改");
    expect((await provider.getCharacter(1, settings)).characterTags).toEqual(["蓝发", "眼镜"]);
    expect((await provider.getRawCharacter(1)).aliases).toEqual(["助手", "Christina"]);
    expect((await provider.getSubjectCharacters(10)).map((row) => row.id)).toEqual([1,2]);
    expect(await provider.resolveCharacterImage(1)).toBeUndefined();
    expect(await rejectionOf(provider.importDirectory(1))).toMatchObject({ code: "CCB_IMPORT_UNAVAILABLE" });
    expect(await rejectionOf(provider.getCharacter(999, settings))).toMatchObject({ code: "CCB_CHARACTER_NOT_FOUND" });
  } finally {
    await provider.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
  expect(await rejectionOf(provider.searchCharacters("牧濑"))).toMatchObject({ code: "CCB_DATA_UNAVAILABLE" });
});

test("缺失数据文件的初始化失败以业务错误返回，不产生未处理拒绝", async () => {
  const provider = new CCBCharacterWorkerProvider({ characterPath: `missing-${crypto.randomUUID()}.sqlite` });
  expect(await rejectionOf(provider.searchCharacters("角色"))).toMatchObject({ code: "CCB_DATA_UNAVAILABLE" });
  expect(await rejectionOf(provider.close())).toMatchObject({ code: "CCB_DATA_UNAVAILABLE" });
});

test("init 使用独立的长超时窗口，不与查询共用短窗口", async () => {
  class EchoWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    postMessage(message: unknown) {
      const request = message as { id: number };
      queueMicrotask(() => this.onmessage?.({ data: { id: request.id, ok: true, value: true } } as MessageEvent));
    }
    terminate() {}
  }
  const originalWorker = globalThis.Worker;
  const spy = spyOn(globalThis, "setTimeout");
  try {
    globalThis.Worker = EchoWorker as unknown as typeof Worker;
    const provider = new CCBCharacterWorkerProvider({ characterPath: "unused-character.sqlite" });
    const delays = spy.mock.calls.map((call) => Number(call[1]));
    // 索引重建分钟级（线上实测约 19 分钟）：init 必须是长窗口，否则 ready 被拒后所有查询永久失败。
    expect(delays).toContain(3_600_000);
    await provider.close();
  } finally {
    globalThis.Worker = originalWorker;
    spy.mockRestore();
  }
});

test("查询超时只拒绝该请求，不终止线程，后续请求正常", async () => {
  class SelectiveWorker {
    static latest: SelectiveWorker | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    terminated = false;
    constructor() { SelectiveWorker.latest = this; }
    postMessage(message: unknown) {
      const request = message as { id: number; method: string; keyword?: string };
      if (request.method === "searchCharacters" && request.keyword === "slow") return; // 永不回包：模拟卡住的查询
      queueMicrotask(() => this.onmessage?.({ data: { id: request.id, ok: true, value: request.method === "searchCharacters" ? [] : true } } as MessageEvent));
    }
    terminate() { this.terminated = true; }
  }
  const originalWorker = globalThis.Worker;
  const spy = spyOn(globalThis, "setTimeout");
  try {
    globalThis.Worker = SelectiveWorker as unknown as typeof Worker;
    const provider = new CCBCharacterWorkerProvider({ characterPath: "unused-character.sqlite" });
    const worker = SelectiveWorker.latest!;
    expect(await provider.searchCharacters("warm")).toEqual([]);
    spy.mockClear();
    const slow = provider.searchCharacters("slow");
    await Bun.sleep(0); // 等查询真正发出、20s 计时器完成注册
    const timers = spy.mock.calls.filter((call) => Number(call[1]) === 20_000);
    expect(timers.length).toBe(1);
    (timers[0]![0] as () => void)(); // 手动触发超时到点
    expect(await rejectionOf(slow)).toMatchObject({ code: "CCB_QUERY_TIMEOUT" });
    expect(worker.terminated).toBe(false);
    // 线程未死：后续请求照常返回，而不是「本地角色查询已关闭」。
    expect(await provider.searchCharacters("ok")).toEqual([]);
    expect(worker.terminated).toBe(false);
    await provider.close();
  } finally {
    globalThis.Worker = originalWorker;
    spy.mockRestore();
  }
});
