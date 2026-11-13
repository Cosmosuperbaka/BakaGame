import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BANGUMI_USER_AGENT } from "../src/infrastructure/BangumiUserAgent";
import { BangumiUpstream } from "../src/infrastructure/BangumiUpstream";
import { CEEEnrichment } from "../src/infrastructure/CEEEnrichment";
import { LocalBangumiProvider } from "../src/infrastructure/LocalBangumiProvider";
import { SubjectUpdater } from "../src/infrastructure/SubjectUpdater";
import { discoverNewSubjects } from "../src/infrastructure/SubjectDiscovery";
import { requestUrlText } from "./RequestFixtures";

/** 假上游：按 URL 决定状态码，记录实际发出的请求与带上的头。 */
const fakeUpstream = (status: (url: string) => number = () => 200) => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrlText(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const code = status(url);
    if (code !== 200) return new Response(null, { status: code });
    return Response.json({ images: { large: "https://lain.bgm.tv/pic/cover/l/aa/bb/1_x.jpg" } });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
};

/** 可手动拨动的时钟：睡眠只记录时长并把时钟推进相同毫秒，等价于「时间真的过去了」。 */
const fakeClock = () => {
  const clock = {
    time: 0,
    sleeps: [] as number[],
    now: () => clock.time,
    sleep: async (ms: number) => {
      clock.sleeps.push(ms);
      clock.time += ms;
    },
  };
  return clock;
};

describe("共享上游部件", () => {
  test("统一带上标识头，调用方给的头原样保留", async () => {
    const { calls, fetcher } = fakeUpstream();
    const upstream = new BangumiUpstream({ fetcher });
    await upstream.fetch("https://api.invalid/a", {
      headers: { Accept: "application/json" },
      timeoutMs: 1000,
      priority: "interactive",
    });
    expect(calls[0]!.headers).toEqual({
      Accept: "application/json",
      "User-Agent": BANGUMI_USER_AGENT,
    });
  });

  test("请求超时按调用方给的时限中止", async () => {
    const fetcher = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error));
      })) as unknown as typeof fetch;
    const upstream = new BangumiUpstream({ fetcher });
    await expect(
      upstream.fetch("https://api.invalid/slow", { timeoutMs: 20, priority: "interactive" })
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  test("收到限流进入冷却：玩家请求在冷却期内不发出，到期恢复", async () => {
    const clock = fakeClock();
    const { calls, fetcher } = fakeUpstream((url) => (url.endsWith("/limited") ? 429 : 200));
    const upstream = new BangumiUpstream({ fetcher, now: clock.now, sleep: clock.sleep });
    await expect(
      upstream.fetch("https://api.invalid/limited", { timeoutMs: 1000, priority: "interactive" })
    ).rejects.toMatchObject({ code: "BANGUMI_RATE_LIMITED" });
    expect(calls).toHaveLength(1);

    clock.time = 4999;
    await expect(
      upstream.fetch("https://api.invalid/ok", { timeoutMs: 1000, priority: "interactive" })
    ).rejects.toMatchObject({ code: "BANGUMI_RATE_LIMITED" });
    expect(calls).toHaveLength(1);

    clock.time = 5000;
    const response = await upstream.fetch("https://api.invalid/ok", {
      timeoutMs: 1000,
      priority: "interactive",
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  test("上游给了等待时长就按它冷却，且有上限", async () => {
    const clock = fakeClock();
    let retryAfter = "30";
    const fetcher = (async () =>
      new Response(null, {
        status: 429,
        headers: { "Retry-After": retryAfter },
      })) as unknown as typeof fetch;
    const upstream = new BangumiUpstream({ fetcher, now: clock.now, sleep: clock.sleep });
    await expect(
      upstream.fetch("https://api.invalid/a", { timeoutMs: 1000, priority: "interactive" })
    ).rejects.toMatchObject({ code: "BANGUMI_RATE_LIMITED", details: { retryAfterMs: 30_000 } });
    expect(upstream.cooldownRemainingMs()).toBe(30_000);

    clock.time = 40_000;
    retryAfter = "3600";
    await expect(
      upstream.fetch("https://api.invalid/a", { timeoutMs: 1000, priority: "interactive" })
    ).rejects.toMatchObject({ code: "BANGUMI_RATE_LIMITED" });
    expect(upstream.cooldownRemainingMs()).toBe(60_000);
  });

  test("后台请求遇到冷却先等够再发，不把限流记成条目失败", async () => {
    const clock = fakeClock();
    const { calls, fetcher } = fakeUpstream((url) => (url.endsWith("/limited") ? 429 : 200));
    const upstream = new BangumiUpstream({ fetcher, now: clock.now, sleep: clock.sleep });
    await expect(
      upstream.fetch("https://api.invalid/limited", { timeoutMs: 1000, priority: "interactive" })
    ).rejects.toMatchObject({ code: "BANGUMI_RATE_LIMITED" });
    clock.time = 1000;

    const response = await upstream.fetch("https://api.invalid/ok", {
      timeoutMs: 1000,
      priority: "background",
    });
    expect(response.status).toBe(200);
    expect(clock.sleeps).toEqual([4000]);
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.invalid/limited",
      "https://api.invalid/ok",
    ]);
  });

  test("并发调用共用同一个限速时隙：按速率逐个排开", async () => {
    const sentAt: number[] = [];
    const fetcher = (async () => {
      sentAt.push(performance.now());
      return Response.json({});
    }) as unknown as typeof fetch;
    // 20 req/s：相邻请求至少隔 50ms。用真实时钟，只断言下界（定时器不会提前触发）。
    const upstream = new BangumiUpstream({ fetcher, rate: () => 20 });
    const run = (name: string) =>
      upstream.fetch(`https://api.invalid/${name}`, { timeoutMs: 1000, priority: "background" });
    await Promise.all([run("a"), run("b"), run("c")]);
    expect(sentAt).toHaveLength(3);
    expect(sentAt[1]! - sentAt[0]!).toBeGreaterThanOrEqual(45);
    expect(sentAt[2]! - sentAt[1]!).toBeGreaterThanOrEqual(45);
  });

  test("没有给速率时不排时隙", async () => {
    const clock = fakeClock();
    const { fetcher } = fakeUpstream();
    const upstream = new BangumiUpstream({ fetcher, now: clock.now, sleep: clock.sleep });
    await Promise.all(
      ["a", "b", "c"].map((name) =>
        upstream.fetch(`https://api.invalid/${name}`, { timeoutMs: 1000, priority: "interactive" })
      )
    );
    expect(clock.sleeps).toEqual([]);
  });
});

/** 睡眠由测试逐个放行：放行时时钟推进相同毫秒，可以精确控制「别处在我等待时收到了限流」。 */
const manualClock = () => {
  const clock = {
    time: 0,
    pending: [] as Array<{ ms: number; release: () => void }>,
    now: () => clock.time,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        clock.pending.push({
          ms,
          release: () => {
            clock.time += ms;
            resolve();
          },
        });
      }),
  };
  return clock;
};

/** 每个地址的响应由测试决定何时、以什么状态返回；记录实际发出的地址。 */
const deferredUpstream = () => {
  const sent: string[] = [];
  const waiting = new Map<string, (response: Response) => void>();
  const fetcher = ((input: string | URL | Request) => {
    const url = requestUrlText(input);
    sent.push(url);
    return new Promise<Response>((resolve) => waiting.set(url, resolve));
  }) as unknown as typeof fetch;
  const answer = (url: string, status: number, headers: Record<string, string> = {}) =>
    waiting.get(url)!(new Response(null, { status, headers }));
  return { sent, fetcher, answer };
};

describe("冷却与时隙的时序", () => {
  const limited = "https://api.invalid/limited";
  const next = "https://api.invalid/next";

  test("等时隙期间别处收到限流：玩家请求醒来后不得发出，直接失败并带剩余冷却", async () => {
    const clock = manualClock();
    const { sent, fetcher, answer } = deferredUpstream();
    const upstream = new BangumiUpstream({
      fetcher,
      now: clock.now,
      sleep: clock.sleep,
      rate: () => 10,
    });
    const first = upstream
      .fetch(limited, { timeoutMs: 1000, priority: "interactive" })
      .catch((e) => e);
    // 乙紧接着排到下一个时隙，正在等。
    const second = upstream
      .fetch(next, { timeoutMs: 1000, priority: "interactive" })
      .catch((e) => e);
    await Bun.sleep(0);
    expect(clock.pending.map((item) => item.ms)).toEqual([100]);
    answer(limited, 429);
    expect(await first).toMatchObject({ code: "BANGUMI_RATE_LIMITED" });

    clock.pending[0]!.release();
    expect(await second).toMatchObject({
      code: "BANGUMI_RATE_LIMITED",
      details: { retryAfterMs: 4900 },
    });
    expect(sent).toEqual([limited]);
  });

  test("等时隙期间别处收到限流：后台请求醒来后继续等到冷却结束才发", async () => {
    const clock = manualClock();
    const { sent, fetcher, answer } = deferredUpstream();
    const upstream = new BangumiUpstream({
      fetcher,
      now: clock.now,
      sleep: clock.sleep,
      rate: () => 10,
    });
    const first = upstream
      .fetch(limited, { timeoutMs: 1000, priority: "interactive" })
      .catch((e) => e);
    const second = upstream.fetch(next, { timeoutMs: 1000, priority: "background" });
    await Bun.sleep(0);
    answer(limited, 429);
    await first;

    clock.pending[0]!.release();
    await Bun.sleep(0);
    // 时隙到了但冷却还剩 4900ms：先等够，期间一个请求也不发。
    expect(clock.pending.map((item) => item.ms)).toEqual([100, 4900]);
    expect(sent).toEqual([limited]);
    clock.pending[1]!.release();
    await Bun.sleep(0);
    expect(sent).toEqual([limited, next]);
    answer(next, 200);
    expect((await second).status).toBe(200);
  });

  test("后台请求睡眠期间冷却被别处延长，醒来后继续等", async () => {
    const clock = manualClock();
    const { sent, fetcher, answer } = deferredUpstream();
    const upstream = new BangumiUpstream({ fetcher, now: clock.now, sleep: clock.sleep });
    const slow = "https://api.invalid/slow";
    // 慢请求先发出（此时还没有冷却），之后才有人收到限流。
    const slowRequest = upstream
      .fetch(slow, { timeoutMs: 1000, priority: "interactive" })
      .catch((e) => e);
    const first = upstream
      .fetch(limited, { timeoutMs: 1000, priority: "interactive" })
      .catch((e) => e);
    await Bun.sleep(0);
    answer(limited, 429);
    await first;
    const waiter = upstream.fetch(next, { timeoutMs: 1000, priority: "background" });
    await Bun.sleep(0);
    expect(clock.pending.map((item) => item.ms)).toEqual([5000]);

    // 等待期间慢请求回了更长的限流：冷却被延长到三十秒。
    answer(slow, 429, { "Retry-After": "30" });
    await slowRequest;
    clock.pending[0]!.release();
    await Bun.sleep(0);
    expect(clock.pending.map((item) => item.ms)).toEqual([5000, 25_000]);
    expect(sent).toEqual([slow, limited]);
    clock.pending[1]!.release();
    await Bun.sleep(0);
    answer(next, 200);
    expect((await waiter).status).toBe(200);
  });

  test("冷却截止取较晚者：较短的等待时长不会缩短已有冷却", async () => {
    const clock = manualClock();
    const { fetcher, answer } = deferredUpstream();
    const upstream = new BangumiUpstream({ fetcher, now: clock.now, sleep: clock.sleep });
    const slow = "https://api.invalid/slow";
    const slowRequest = upstream
      .fetch(slow, { timeoutMs: 1000, priority: "interactive" })
      .catch((e) => e);
    const first = upstream
      .fetch(limited, { timeoutMs: 1000, priority: "interactive" })
      .catch((e) => e);
    await Bun.sleep(0);
    answer(limited, 429);
    await first;
    expect(upstream.cooldownRemainingMs()).toBe(5000);
    answer(slow, 429, { "Retry-After": "1" });
    await slowRequest;
    expect(upstream.cooldownRemainingMs()).toBe(5000);
  });

  test("后台请求睡眠结束后取消信号生效：不再发请求", async () => {
    const clock = manualClock();
    const { sent, fetcher, answer } = deferredUpstream();
    const upstream = new BangumiUpstream({ fetcher, now: clock.now, sleep: clock.sleep });
    const first = upstream
      .fetch(limited, { timeoutMs: 1000, priority: "interactive" })
      .catch((e) => e);
    await Bun.sleep(0);
    answer(limited, 429);
    await first;
    const controller = new AbortController();
    const waiter = upstream
      .fetch(next, { timeoutMs: 1000, priority: "background", signal: controller.signal })
      .catch((e) => e);
    await Bun.sleep(0);
    controller.abort(new Error("总预算用尽"));
    clock.pending[0]!.release();
    expect(await waiter).toMatchObject({ message: "总预算用尽" });
    expect(sent).toEqual([limited]);
  });

  test("睡满即视为冷却已过：时钟不动、睡眠为空操作时也不会原地空转", async () => {
    // 更新器等上游测试把时钟冻住、睡眠写成空操作：醒来后若还按时钟判定冷却，会无限循环。
    let sleeps = 0;
    const { calls, fetcher } = fakeUpstream((url) => (url.endsWith("/limited") ? 429 : 200));
    const upstream = new BangumiUpstream({
      fetcher,
      now: () => 0,
      sleep: async () => {
        sleeps += 1;
        if (sleeps > 2) throw new Error("睡眠被反复调用");
      },
    });
    await expect(
      upstream.fetch(limited, { timeoutMs: 1000, priority: "interactive" })
    ).rejects.toMatchObject({ code: "BANGUMI_RATE_LIMITED" });
    const response = await upstream.fetch(next, { timeoutMs: 1000, priority: "background" });
    expect(response.status).toBe(200);
    expect(sleeps).toBe(1);
    expect(calls).toHaveLength(2);
  });

  test("速率为零或未给出时一个时隙都不排", async () => {
    for (const rate of [() => 0, () => undefined]) {
      const clock = fakeClock();
      const { calls, fetcher } = fakeUpstream();
      const upstream = new BangumiUpstream({ fetcher, now: clock.now, sleep: clock.sleep, rate });
      await Promise.all(
        ["a", "b", "c"].map((name) =>
          upstream.fetch(`https://api.invalid/${name}`, { timeoutMs: 1000, priority: "background" })
        )
      );
      expect(calls).toHaveLength(3);
      expect(clock.sleeps).toEqual([]);
    }
  });
});

describe("四个调用方共用一个上游部件", () => {
  const datasetPath = () => {
    const path = join(tmpdir(), `bangumi-upstream-${crypto.randomUUID()}.sqlite`);
    new Database(path).close();
    return path;
  };

  test("补全一处收到限流，猜歌封面回源在冷却期内不发请求，到期后恢复", async () => {
    const clock = fakeClock();
    const { calls, fetcher } = fakeUpstream((url) => (url.includes("/characters/") ? 429 : 200));
    const upstream = new BangumiUpstream({ fetcher, now: clock.now, sleep: clock.sleep });
    const cee = new CEEEnrichment({
      dbPath: ":memory:",
      apiBase: "https://api.invalid",
      imageBase: "https://img.invalid",
      upstream,
      now: clock.now,
    });
    const path = datasetPath();
    const local = new LocalBangumiProvider({
      dbPath: path,
      apiBase: "https://api.invalid",
      imageBase: "https://img.invalid",
      upstream,
    });
    try {
      await expect(cee.resolveCharacterImage(1)).rejects.toMatchObject({
        code: "BANGUMI_RATE_LIMITED",
      });
      expect(calls).toHaveLength(1);

      // 冷却期内：猜歌侧不应再去打同一个上游。
      expect(await local.resolveSubjectImage("5")).toBeUndefined();
      expect(calls).toHaveLength(1);

      clock.time = 5000;
      expect(await local.resolveSubjectImage("5")).toBe(
        "https://img.invalid/r/200/pic/cover/l/aa/bb/1_x.jpg"
      );
      expect(calls).toHaveLength(2);
    } finally {
      local.close();
      await cee.close();
      await Bun.file(path).delete();
    }
  });

  test("猜歌封面因冷却被拒不会固化成五分钟负缓存", async () => {
    const clock = fakeClock();
    const { calls, fetcher } = fakeUpstream((url) => (url.includes("/characters/") ? 429 : 200));
    const upstream = new BangumiUpstream({ fetcher, now: clock.now, sleep: clock.sleep });
    const path = datasetPath();
    const local = new LocalBangumiProvider({
      dbPath: path,
      apiBase: "https://api.invalid",
      imageBase: "https://img.invalid",
      upstream,
    });
    try {
      expect(await local.resolveCharacterImage(1)).toBeUndefined();
      // 冷却一过立刻恢复，而不是等满负缓存的五分钟。
      clock.time = 5000;
      expect(await local.resolveSubjectImage("5")).toBeDefined();
      expect(await local.resolveCharacterImage(1)).toBeUndefined();
      expect(calls.filter((call) => call.url.includes("/characters/")).length).toBe(2);
    } finally {
      local.close();
      await Bun.file(path).delete();
    }
  });

  test("更新器的回源在冷却期内等待，限流本身不计入条目失败", async () => {
    const clock = fakeClock();
    let limited = true;
    const calls: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      const url = requestUrlText(input);
      calls.push(url);
      if (limited && url.endsWith("/v0/subjects/1")) {
        limited = false;
        return new Response(null, { status: 429 });
      }
      return Response.json({ name: "x" });
    }) as unknown as typeof fetch;
    const upstream = new BangumiUpstream({ fetcher, now: clock.now, sleep: clock.sleep });
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE subjects (
      id INTEGER PRIMARY KEY, type INTEGER NOT NULL, name TEXT NOT NULL, name_cn TEXT NOT NULL,
      aliases TEXT NOT NULL, infobox TEXT NOT NULL, summary TEXT NOT NULL, date TEXT NOT NULL,
      nsfw INTEGER NOT NULL, tags TEXT NOT NULL, raw_tags TEXT NOT NULL, meta_tags TEXT NOT NULL,
      score REAL NOT NULL, rating_count INTEGER NOT NULL, heat INTEGER NOT NULL, rank INTEGER NOT NULL,
      image TEXT NOT NULL)`);
    for (const id of [1, 2])
      db.query(
        "INSERT INTO subjects VALUES (?,2,'n','','[]','','','2020-01-01',0,'[]','{}','[]',0,0,?,0,'')"
      ).run(id, 10 - id);
    const updater = new SubjectUpdater({
      db,
      base: "https://api.invalid",
      upstream,
      now: clock.now,
    });
    // 条目 1 撞上限流：本轮不算它失败；条目 2 在冷却期内等够再发。
    expect(await updater.runRound()).toBe(1);
    expect(calls).toEqual([
      "https://api.invalid/v0/subjects/1",
      "https://api.invalid/v0/subjects/2",
    ]);
    expect(clock.sleeps).toContain(5000);
    const failures = db
      .query("SELECT subject_id, failures FROM bangumi_refresh ORDER BY subject_id")
      .all();
    expect(failures).toEqual([{ subject_id: 2, failures: 0 }]);
    db.close();
  });

  test("新条目发现的出站同样等待共享冷却", async () => {
    const clock = fakeClock();
    const calls: string[] = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrlText(input);
      calls.push(init?.method === "POST" ? `POST ${url}` : url);
      if (url.endsWith("/limited")) return new Response(null, { status: 429 });
      return Response.json({ data: [], total: 0 });
    }) as unknown as typeof fetch;
    const upstream = new BangumiUpstream({ fetcher, now: clock.now, sleep: clock.sleep });
    // 别处（例如角色补全）先触发了冷却。
    await expect(
      upstream.fetch("https://api.invalid/limited", { timeoutMs: 1000, priority: "interactive" })
    ).rejects.toMatchObject({ code: "BANGUMI_RATE_LIMITED" });

    const db = new Database(":memory:");
    const result = await discoverNewSubjects({
      db,
      base: "https://api.invalid",
      upstream,
      pauseMs: 0,
      since: "2026-01-01",
    });
    db.close();
    expect(result.candidates).toBe(0);
    // 先等够冷却，再发搜索请求。
    expect(clock.sleeps).toEqual([5000]);
    expect(calls).toEqual([
      "https://api.invalid/limited",
      "POST https://api.invalid/v0/search/subjects?limit=20&offset=0",
    ]);
  });
});
