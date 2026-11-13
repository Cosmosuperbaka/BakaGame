import { describe, expect, it } from "bun:test";
import { AppError } from "../src/domain/Errors";
import { fingerprintCookie, LoginStatusCache } from "../src/infrastructure/music/MusicCredential";
import type { MusicLoginSession } from "../src/infrastructure/music/MusicProvider";
import {
  PLAYLIST_MAX_PAGES,
  PLAYLIST_PAGE_SIZE,
  readRemainingPlaylistPages,
  warnIfPlaylistTruncated,
} from "../src/infrastructure/music/PlaylistPaging";
import { raceWithTimeout } from "../src/infrastructure/music/RaceTimeout";
import { createMusicQueue } from "../src/infrastructure/music/UpstreamQueueFactory";

const never = () => new Promise<never>(() => {});

const session = (cookie: string, nickname = "测试号"): MusicLoginSession => ({
  cookie,
  account: { nickname, vipStatus: "nonVip" },
});

describe("raceWithTimeout", () => {
  it("任务先结算时取任务结果", async () => {
    await expect(raceWithTimeout(Promise.resolve("done"), 50, () => "late")).resolves.toBe("done");
  });

  it("超时按回调回落成值", async () => {
    await expect(raceWithTimeout(never(), 10, () => "fallback")).resolves.toBe("fallback");
  });

  it("超时回调抛错时以该错误拒绝，错误码保持", async () => {
    await expect(
      raceWithTimeout(never(), 10, () => {
        throw new AppError("MUSIC_API_TIMEOUT", "搜索超时");
      })
    ).rejects.toMatchObject({ code: "MUSIC_API_TIMEOUT", message: "搜索超时" });
  });

  it("超时之后才拒绝的原任务不会变成未处理拒绝", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let rejectLate: (error: Error) => void = () => {};
      const late = new Promise<string>((_, reject) => {
        rejectLate = reject;
      });
      await expect(raceWithTimeout(late, 5, () => "fallback")).resolves.toBe("fallback");
      rejectLate(new Error("迟到的失败"));
      await Bun.sleep(20);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("LoginStatusCache", () => {
  const create = () => new LoginStatusCache({ maxEntries: 8, ttlMs: 60_000 });

  it("同键并发校验合并成一次回源，结果是互不影响的副本", async () => {
    const cache = create();
    let calls = 0;
    const load = async () => {
      calls += 1;
      await Bun.sleep(5);
      return session("cookie-a");
    };
    const [first, second] = await Promise.all([cache.resolve("k", load), cache.resolve("k", load)]);
    expect(calls).toBe(1);
    first.account.nickname = "被改写";
    expect(second.account.nickname).toBe("测试号");
    const reused = await cache.resolve("k", load);
    expect(calls).toBe(1);
    expect(reused.account.nickname).toBe("测试号");
  });

  it("校验失败不入缓存，下一次照常回源", async () => {
    const cache = create();
    let calls = 0;
    await expect(
      cache.resolve("k", async () => {
        calls += 1;
        throw new AppError("MUSIC_SESSION_INVALID", "失效");
      })
    ).rejects.toMatchObject({ code: "MUSIC_SESSION_INVALID" });
    await expect(
      cache.resolve("k", async () => {
        calls += 1;
        return session("cookie-a");
      })
    ).resolves.toMatchObject({ cookie: "cookie-a" });
    expect(calls).toBe(2);
  });

  it("强制续期绕过缓存读取，并与普通校验分开合并", async () => {
    const cache = create();
    await cache.resolve("k", async () => session("old"));
    let refreshCalls = 0;
    const refresh = async () => {
      refreshCalls += 1;
      await Bun.sleep(5);
      return session("new");
    };
    const [a, b] = await Promise.all([
      cache.resolve("k", refresh, { force: true }),
      cache.resolve("k", refresh, { force: true }),
    ]);
    expect(refreshCalls).toBe(1);
    expect([a.cookie, b.cookie]).toEqual(["new", "new"]);
    // 续期结果覆盖了旧缓存：普通读取拿到新凭据。
    await expect(cache.resolve("k", async () => session("never"))).resolves.toMatchObject({
      cookie: "new",
    });
  });

  it("凭据被轮换后，新凭据的键下也能复用同一份结果", async () => {
    const cache = create();
    const rotated = session("rotated");
    cache.remember("k2", rotated);
    let calls = 0;
    await expect(
      cache.resolve("k2", async () => {
        calls += 1;
        return session("other");
      })
    ).resolves.toMatchObject({ cookie: "rotated" });
    expect(calls).toBe(0);
  });
});

describe("fingerprintCookie", () => {
  it("同一原文得到同一个 16 位十六进制指纹，原文不出现在指纹里", () => {
    const fingerprint = fingerprintCookie("MUSIC_U=secret-value");
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint).toBe(fingerprintCookie("MUSIC_U=secret-value"));
    expect(fingerprint).not.toContain("secret");
    expect(fingerprintCookie("MUSIC_U=another")).not.toBe(fingerprint);
  });
});

describe("readRemainingPlaylistPages", () => {
  const makeRun = (pages: Array<number[] | undefined>, declaredCount?: number) => {
    const collected: number[] = [];
    const fetched: number[] = [];
    const run = (firstAdded = 1) =>
      readRemainingPlaylistPages<number>({
        firstAdded,
        declaredCount,
        collectedCount: () => collected.length,
        fetchPage: async (page) => {
          fetched.push(page);
          return pages[page - 1];
        },
        collect: (rawSongs) => {
          let added = 0;
          for (const raw of rawSongs) {
            if (collected.includes(raw)) continue;
            collected.push(raw);
            added += 1;
          }
          return added;
        },
      });
    return { run, fetched, collected };
  };
  const fullPage = (offset: number) =>
    Array.from({ length: PLAYLIST_PAGE_SIZE }, (_, index) => offset + index);

  it("整页就继续翻，不足一页即停", async () => {
    const { run, fetched, collected } = makeRun([fullPage(0), [5_000, 5_001]]);
    await run();
    expect(fetched).toEqual([1, 2]);
    expect(collected.length).toBe(PLAYLIST_PAGE_SIZE + 2);
  });

  it("首页没有新增曲目时一页都不翻", async () => {
    const { run, fetched } = makeRun([fullPage(0)]);
    await run(0);
    expect(fetched).toEqual([]);
  });

  it("已取够声明总数就停", async () => {
    const { run, fetched, collected } = makeRun([fullPage(0)], 0);
    await run();
    expect(fetched).toEqual([]);
    expect(collected).toEqual([]);
  });

  it("翻页失败只结束翻页，不丢已取到的曲目", async () => {
    const { run, fetched, collected } = makeRun([fullPage(0), undefined, fullPage(9_000)]);
    await run();
    expect(fetched).toEqual([1, 2]);
    expect(collected.length).toBe(PLAYLIST_PAGE_SIZE);
  });

  it("本页没有新增曲目（上游对超范围偏移重复整页）即停", async () => {
    const repeated = fullPage(0);
    const { run, fetched, collected } = makeRun([repeated, repeated, repeated]);
    collected.push(...repeated);
    await run();
    expect(fetched).toEqual([1]);
  });

  it("页数以硬上限封顶", async () => {
    const pages = Array.from({ length: PLAYLIST_MAX_PAGES + 10 }, (_, index) =>
      fullPage(index * PLAYLIST_PAGE_SIZE)
    );
    const { run, fetched } = makeRun(pages);
    await run();
    expect(fetched.length).toBe(PLAYLIST_MAX_PAGES - 1);
  });
});

describe("warnIfPlaylistTruncated", () => {
  it("读到的比声明的少才告警，带声明数与实取数", () => {
    const warnings: Array<{ message: string; context: unknown }> = [];
    const logger = {
      warn: (message: string, context?: Record<string, unknown>) =>
        warnings.push({ message, context }),
    };
    warnIfPlaylistTruncated(logger, "歌单读取不完整", { playlistId: "1" }, 100, 100);
    expect(warnings).toEqual([]);
    warnIfPlaylistTruncated(logger, "歌单读取不完整", { playlistId: "1" }, 100, 40);
    expect(warnings).toEqual([
      {
        message: "歌单读取不完整",
        context: { playlistId: "1", declared: 100, fetched: 40 },
      },
    ]);
  });
});

describe("createMusicQueue", () => {
  const limited = (value: unknown) =>
    typeof value === "object" &&
    value !== null &&
    (value as { limited?: boolean }).limited === true;
  const create = (rateLimitUpstreamCode?: number) =>
    createMusicQueue({
      now: () => Date.now(),
      random: { nextFloat: () => 0 },
      tuning: { requestTimeoutMs: 20, minRequestIntervalMs: 0, maxConcurrentRequests: 1 },
      messages: {
        queueFull: "排队过多",
        queueTimeout: "等待超时",
        requestTimeout: "请求超时",
        rateLimitFallback: "操作频繁",
      },
      isRateLimitError: limited,
      readRateLimitMessage: (_error, fallback) => fallback,
      onRateLimitCooldown: () => {},
      rateLimitUpstreamCode,
    });

  it("已开始的请求超过运行时限：用统一的超时错误码与平台文案", async () => {
    await expect(create().scheduleRequest(never, "scope:a")).rejects.toMatchObject({
      code: "MUSIC_API_TIMEOUT",
      message: "请求超时",
    });
  });

  it("限流冷却期内快速拒绝：错误码统一，上游码只在平台声明时携带", async () => {
    const withCode = create(405);
    // 首个限流结果照常返回给调用方（由 provider 转成业务异常），同时让该作用域进入冷却。
    await withCode.scheduleRequest(async () => ({ limited: true }), "s");
    const rejected = await withCode.scheduleRequest(async () => "ok", "s").catch((e: unknown) => e);
    expect(rejected).toMatchObject({ code: "MUSIC_API_RATE_LIMITED" });
    expect((rejected as AppError).details).toMatchObject({ upstreamCode: 405 });

    const withoutCode = create();
    await withoutCode.scheduleRequest(async () => ({ limited: true }), "s");
    const plain = await withoutCode.scheduleRequest(async () => "ok", "s").catch((e: unknown) => e);
    expect((plain as AppError).details).not.toHaveProperty("upstreamCode");
  });
});
