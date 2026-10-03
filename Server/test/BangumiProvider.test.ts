import { describe, expect, test } from "bun:test";
import { BangumiProvider } from "../src/infrastructure/BangumiProvider";

const results = () => Response.json({ data: [] });
const tick = () => Bun.sleep(1);

describe("Bangumi 远端截止与排队", () => {
  for (const stage of ["fetch", "body"] as const) test(`${stage} 挂起会中止、释放槽位及同键在途，不缓存失败`, async () => {
    let calls = 0;
    const signals: AbortSignal[] = [];
    const provider = new BangumiProvider({ apiUrl: "https://bangumi.invalid", maxConcurrentRequests: 1, requestTimeoutMs: 25,
      fetcher: async (_url, init) => {
        signals.push(init!.signal!); calls++;
        if (calls > 1) return results();
        if (stage === "fetch") return new Promise<Response>(() => {});
        return new Response(new ReadableStream({ start() {}, cancel() {} }));
      },
    });
    const failure = provider.searchSubjects("first").catch(error => error);
    await tick();
    expect(signals).toHaveLength(1);
    expect(await failure).toMatchObject({ code: "BANGUMI_UPSTREAM_ERROR", message: "Bangumi 请求超时" });
    expect(signals[0].aborted).toBe(true);
    expect(await provider.searchSubjects("second")).toEqual([]);
    expect(await provider.searchSubjects("first")).toEqual([]);
    expect(calls).toBe(3);
    // mock 即使忽略 signal，PQueue 仍释放槽位；原生 fetch 负责取消响应体。
  });

  test("队列中的截止不补发，429 后排队请求取消且冷却后恢复", async () => {
    let release!: (response: Response) => void;
    let calls = 0;
    let now = 0;
    const provider = new BangumiProvider({ apiUrl: "https://bangumi.invalid", maxConcurrentRequests: 1, maxQueuedRequests: 1,
      requestTimeoutMs: 100, now: () => now, rateLimitCooldownMs: 500,
      fetcher: async () => { calls++; return calls === 1 ? new Promise<Response>(resolve => { release = resolve; }) : results(); },
    });
    const first = provider.searchSubjects("first").catch(error => error);
    const queued = provider.searchSubjects("queued").catch(error => error);
    await expect(provider.searchSubjects("overflow")).rejects.toMatchObject({ code: "BANGUMI_RATE_LIMITED" });
    release(new Response(null, { status: 429 }));
    expect(await first).toMatchObject({ code: "BANGUMI_RATE_LIMITED" });
    expect(await queued).toMatchObject({ code: "BANGUMI_RATE_LIMITED" });
    expect(calls).toBe(1);
    now = 501;
    expect(await provider.searchSubjects("queued")).toEqual([]);
    expect(calls).toBe(2);
  });

  test("等待与执行共用截止且最终清空队列", async () => {
    let calls = 0;
    const provider = new BangumiProvider({ apiUrl: "https://bangumi.invalid", maxConcurrentRequests: 1, requestTimeoutMs: 20,
      fetcher: async () => { calls++; return new Promise<Response>(() => {}); },
    });
    const first = provider.searchSubjects("first").catch(error => error);
    const second = provider.searchSubjects("second").catch(error => error);
    expect(await first).toMatchObject({ code: "BANGUMI_UPSTREAM_ERROR" });
    expect(await second).toMatchObject({ code: "BANGUMI_UPSTREAM_ERROR" });
    expect(calls).toBeLessThanOrEqual(2);
    expect((provider as unknown as { queue: { size: number; pending: number } }).queue.size).toBe(0);
  });
});


test("原生队列移除已取消的等待任务，不补发上游", async () => {
  let release!: (response: Response) => void, calls = 0;
  const provider = new BangumiProvider({ apiUrl: "https://bangumi.invalid", maxConcurrentRequests: 1,
    fetcher: async () => { calls++; return new Promise<Response>(resolve => { release = resolve; }); },
  });
  const first = provider.searchSubjects("active");
  const controller = new AbortController();
  const queued = (provider as unknown as { requestJson: (path: string, init: RequestInit) => Promise<unknown> }).requestJson("/queued", { signal: controller.signal });
  const error = new Error("cancel queued"); controller.abort(error);
  await expect(queued).rejects.toBe(error);
  release(results()); await first;
  expect(calls).toBe(1);
});
