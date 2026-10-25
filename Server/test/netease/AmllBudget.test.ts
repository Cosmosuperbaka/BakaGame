import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { amllTtmlFixture, amllResponse } from "./Fixtures";
import { NeteaseMusicProvider } from "../../src/infrastructure/NeteaseMusicProvider";

const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async () => {
    throw new Error("测试禁止网络请求");
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("AMLL 确定缺失与瞬态失败缓存边界", () => {
  for (const failure of [503, 429, "abort", "json", "invalid", "empty"] as const)
    test(`${failure} 当次降级但恢复后同键回源`, async () => {
      let calls = 0;
      const provider = new NeteaseMusicProvider({
        amllRequestTimeoutMs: 20,
        amllFetcher: async () => {
          if (++calls > 1) return amllResponse();
          if (typeof failure === "number") return new Response(null, { status: failure });
          if (failure === "abort") return new Promise<Response>(() => {});
          if (failure === "json") return new Response("not-json");
          return Response.json({
            status: 200,
            data: { lyrics: failure === "empty" ? "" : "<invalid>" },
          });
        },
      });
      expect(await provider.getAmllTtmlLyrics("1")).toBeUndefined();
      expect(await provider.getAmllTtmlLyrics("1")).toBe(amllTtmlFixture());
      expect(calls).toBe(2);
    });

  test("明确404缺失仍缓存，同键并发合并，硬过期重新回源", async () => {
    let now = 0,
      calls = 0;
    const provider = new NeteaseMusicProvider({
      now: () => now,
      amllFetcher: async () => {
        calls++;
        return new Response(null, { status: 404 });
      },
    });
    expect(
      await Promise.all(Array.from({ length: 20 }, () => provider.getAmllTtmlLyrics("404")))
    ).toEqual(Array(20).fill(undefined));
    expect(calls).toBe(1);
    expect(await provider.getAmllTtmlLyrics("404")).toBeUndefined();
    expect(calls).toBe(1);
    now = 4 * 24 * 60 * 60 * 1000;
    expect(await provider.getAmllTtmlLyrics("404")).toBeUndefined();
    expect(calls).toBe(2);
  });

  test("搜索无结果可缓存，搜索到条目后的503不可缓存", async () => {
    let calls = 0;
    const provider = new NeteaseMusicProvider({
      amllFetcher: async (url) => {
        calls++;
        if (url.includes("q=missing")) return Response.json({ status: 200, data: { items: [] } });
        if (url.includes("search?"))
          return Response.json({ status: 200, data: { items: [{ id: "ttml" }] } });
        return calls === 3 ? new Response(null, { status: 503 }) : amllResponse();
      },
    });
    await provider.searchAmllTtmlLyrics("missing");
    await provider.searchAmllTtmlLyrics("missing");
    expect(calls).toBe(1);
    expect(await provider.searchAmllTtmlLyrics("found")).toBeUndefined();
    expect(await provider.searchAmllTtmlLyrics("found")).toBe(amllTtmlFixture());
    expect(calls).toBe(5);
  });

  test("ID和搜索瞬态失败后LRC降级，不冻结完整歌曲歌词，恢复可获取TTML", async () => {
    let recovered = false;
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      amllFetcher: async () => (recovered ? amllResponse() : new Response(null, { status: 503 })),
      loadApi: async () => ({
        song_detail: async () => ({
          body: {
            songs: [
              { id: 1, name: "答案", ar: [{ name: "歌手" }], al: { name: "专辑" }, dt: 200000 },
            ],
          },
        }),
        song_url: async () => ({ body: { data: [{ url: "https://audio.invalid/fixture.mp3" }] } }),
        lyric: async () => ({ body: { lrc: { lyric: "[00:01.00]降级歌词仍然可用" } } }),
      }),
    });
    expect((await provider.getSong("1")).lyrics[0].text).toBe("降级歌词仍然可用");
    recovered = true;
    expect((await provider.getSong("1")).lyrics[0].text).toBe("恢复后的歌词正文");
  });

  test("结构化失败日志保留安全上下文、错误堆栈与cause", async () => {
    const warnings: Array<{ message: string; meta: unknown }> = [];
    const logger = {
      warn: (message: string, meta: unknown) => warnings.push({ message, meta }),
    } as any;
    const cause = new Error("dummy cause");
    const provider = new NeteaseMusicProvider({
      logger,
      fetchAmllLyrics: async () => {
        throw new Error("dummy id failure", { cause });
      },
      fetchAmllSearchLyrics: async () => {
        throw new Error("dummy search failure", { cause });
      },
    });
    expect(await provider.getAmllTtmlLyrics("fixture-id")).toBeUndefined();
    expect(await provider.searchAmllTtmlLyrics("fixture-title")).toBeUndefined();
    expect(warnings).toHaveLength(2);
    for (const warning of warnings) {
      expect(warning.message).not.toContain("[object Object]");
      expect(warning.meta).toMatchObject({
        errorName: "Error",
        stack: expect.any(String),
        cause: { errorMessage: "dummy cause" },
      });
    }
    expect(warnings[0].meta).toMatchObject({
      songId: "fixture-id",
      errorMessage: "dummy id failure",
    });
    expect(warnings[1].meta).toMatchObject({
      title: "fixture-title",
      errorMessage: "dummy search failure",
    });
  });
});

describe("AMLL 独立后端预算", () => {
  test("跨键并发有界，按键合并且不阻塞网易云API队列", async () => {
    let calls = 0,
      active = 0,
      peak = 0,
      release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = new NeteaseMusicProvider({
      amllMaxConcurrentRequests: 2,
      amllFetcher: async () => {
        calls++;
        active++;
        peak = Math.max(peak, active);
        await gate;
        active--;
        return amllResponse();
      },
      loadApi: async () => ({ cloudsearch: async () => ({ body: { result: { songs: [] } } }) }),
    });
    const requests = Array.from({ length: 20 }, (_, index) =>
      provider.getAmllTtmlLyrics(String(index))
    );
    const duplicate = provider.getAmllTtmlLyrics("0");
    expect(calls).toBe(2);
    expect(peak).toBe(2);
    expect(await provider.search("independent")).toEqual([]);
    release();
    await Promise.all([...requests, duplicate]);
    expect(calls).toBe(20);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  test("饱和、截止释放队列与同键在途，后续恢复", async () => {
    let calls = 0,
      recovered = false;
    const signals: AbortSignal[] = [];
    const provider = new NeteaseMusicProvider({
      amllMaxConcurrentRequests: 1,
      amllMaxQueuedRequests: 1,
      amllRequestTimeoutMs: 25,
      amllFetcher: async (_url, init) => {
        calls++;
        signals.push(init!.signal!);
        return recovered ? amllResponse() : new Promise<Response>(() => {});
      },
    });
    const first = provider.getAmllTtmlLyrics("first"),
      queued = provider.getAmllTtmlLyrics("queued");
    expect(await provider.getAmllTtmlLyrics("overflow")).toBeUndefined();
    expect(calls).toBe(1);
    await Promise.all([first, queued]);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    recovered = true;
    expect(await provider.getAmllTtmlLyrics("first")).toBe(amllTtmlFixture());
    expect(await provider.getAmllTtmlLyrics("queued")).toBe(amllTtmlFixture());
  });
});
