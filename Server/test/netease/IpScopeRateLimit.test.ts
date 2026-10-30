import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  NeteaseMusicProvider,
  parseChinaIpRanges,
  musicIpScope,
  randomChineseIp,
  readChinaIpRanges,
  runWithAnonymousMusicIpScope,
} from "../../src/infrastructure/NeteaseMusicProvider";

describe("IP 作用域与限流", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = (async () => {
      throw new Error("测试禁止网络请求");
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("搜索缓存会合并并发请求并保持有界", async () => {
    let calls = 0;
    let finishFirstSearch!: () => void;
    const firstSearchBlocker = new Promise<void>((resolve) => {
      finishFirstSearch = resolve;
    });
    const provider = new NeteaseMusicProvider({
      cacheMaxEntries: 1,
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        cloudsearch: async ({ keywords }: { keywords: string }) => {
          calls += 1;
          if (calls === 1) {
            await firstSearchBlocker;
          }
          return {
            body: {
              result: {
                songs: [{ id: calls, name: keywords, ar: [{ name: "测试歌手" }] }],
              },
            },
          };
        },
      }),
    });

    const concurrentPromise = Promise.all([
      provider.search("同一首歌"),
      provider.search("同一首歌"),
      provider.search("同一首歌"),
    ]);
    finishFirstSearch();
    const concurrent = await concurrentPromise;
    expect(calls).toBe(1);
    concurrent[0].push({ id: "local", title: "本地改动", artist: "测试" });
    expect(concurrent[1]).toHaveLength(1);
    await expect(provider.search("同一首歌")).resolves.toHaveLength(1);
    expect(calls).toBe(1);

    await provider.search("另一首歌");
    await provider.search("同一首歌");
    expect(calls).toBe(3);
  });

  test("同一登录态复用稳定的随机中国 IP", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        cloudsearch: async (params: Record<string, unknown>) => {
          requests.push(params);
          return { body: { result: { songs: [] } } };
        },
      }),
    });

    await provider.search("歌曲甲", 20, "MUSIC_U=user-a");
    await provider.search("歌曲乙", 20, "MUSIC_U=user-a");
    await provider.search("歌曲丙", 20, "MUSIC_U=user-b");

    const ranges = readChinaIpRanges();
    const inChina = (ip: unknown) => {
      const value =
        String(ip)
          .split(".")
          .reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
      return ranges.some((range) => value >= range.start && value <= range.end);
    };

    expect(requests[0]?.realIP).toBe(requests[1]?.realIP);
    expect(inChina(requests[0]?.realIP)).toBe(true);
    expect(inChina(requests[2]?.realIP)).toBe(true);
    expect(requests[0]?.realIP).not.toBe(requests[2]?.realIP);
    expect(requests.every((params) => params.randomCNIP === true)).toBe(true);
  });

  test("匿名请求按玩家作用域各持一个 IP，同一玩家在作用域内稳定复用", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        cloudsearch: async (params: Record<string, unknown>) => {
          requests.push(params);
          return { body: { result: { songs: [] } } };
        },
      }),
    });

    // 历史实现把全部匿名请求压在同一个 "anonymous" scope 上：一个人把配额打平，
    // 全服跟着 405。玩家作用域让每个连接各持一个出口。
    await musicIpScope.run("player:conn-a", async () => {
      await provider.search("甲一");
      await provider.search("甲二");
    });
    await musicIpScope.run("player:conn-b", () => provider.search("乙一"));

    expect(requests[0]?.realIP).toBe(requests[1]?.realIP);
    expect(requests[0]?.realIP).not.toBe(requests[2]?.realIP);
  });

  test("带房主凭证的请求不受玩家作用域影响，仍沿用凭证自己的 IP", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        cloudsearch: async (params: Record<string, unknown>) => {
          requests.push(params);
          return { body: { result: { songs: [] } } };
        },
      }),
    });

    // 凭证与出口 IP 绑定：同一份房主 cookie 无论从哪个玩家的作用域发出都必须用同一个 IP，
    // 否则登录态会按异地登录判定失效。
    await musicIpScope.run("player:conn-a", () => provider.search("凭证甲", 20, "MUSIC_U=host-a"));
    await musicIpScope.run("player:conn-b", () => provider.search("凭证乙", 20, "MUSIC_U=host-a"));

    expect(requests[0]?.realIP).toBe(requests[1]?.realIP);
  });

  for (const upstreamCode of [406, 429, 503]) {
    test(`上游返回 ${upstreamCode} 时与 405 同等进入限流退避`, async () => {
      let virtualTime = 1_000;
      let calls = 0;
      const provider = new NeteaseMusicProvider({
        now: () => virtualTime,
        random: { nextFloat: () => 0 },
        minRequestIntervalMs: 0,
        rateLimitCooldownMs: 30,
        maxRateLimitCooldownMs: 30,
        loadApi: async () => ({
          cloudsearch: async () => {
            calls += 1;
            return calls === 1
              ? { body: { code: upstreamCode, message: "操作频繁，请稍候再试" } }
              : { body: { result: { songs: [] } } };
          },
        }),
      });

      // 实测登录二维码接口返回的正是 406；只认 405 会让整条扫码链路既不退避也不提示。
      await expect(provider.search("首次限流")).rejects.toMatchObject({
        code: "MUSIC_API_RATE_LIMITED",
        message: "操作频繁，请稍候再试",
        details: { upstreamCode },
      });
      await expect(provider.search("冷却期内")).rejects.toMatchObject({
        code: "MUSIC_API_RATE_LIMITED",
      });
      expect(calls).toBe(1);

      virtualTime += 50;
      await expect(provider.search("冷却结束")).resolves.toEqual([]);
      expect(calls).toBe(2);
    });
  }

  test("触发限流后刷新该作用域的伪装 IP，退避结束的请求换一个出口", async () => {
    let virtualTime = 1_000;
    let calls = 0;
    const requests: Array<Record<string, unknown>> = [];
    const provider = new NeteaseMusicProvider({
      now: () => virtualTime,
      minRequestIntervalMs: 0,
      rateLimitCooldownMs: 30,
      maxRateLimitCooldownMs: 30,
      loadApi: async () => ({
        cloudsearch: async (params: Record<string, unknown>) => {
          requests.push(params);
          calls += 1;
          return calls === 1
            ? { body: { code: 405, message: "操作频繁，请稍候再试" } }
            : { body: { result: { songs: [] } } };
        },
      }),
    });

    await musicIpScope.run("player:conn-a", async () => {
      await expect(provider.search("触发限流")).rejects.toMatchObject({
        code: "MUSIC_API_RATE_LIMITED",
      });
      virtualTime += 50;
      await expect(provider.search("恢复")).resolves.toEqual([]);
    });

    // 同一个玩家作用域，但限流之后必须换出口：否则退避一结束就撞回同一个已计满的 IP。
    expect(requests[0]?.realIP).toBeDefined();
    expect(requests[0]?.realIP).not.toBe(requests[1]?.realIP);
  });

  test("一个作用域触发限流不阻断其它作用域的请求", async () => {
    const virtualTime = 1_000;
    const requests: string[] = [];
    const provider = new NeteaseMusicProvider({
      now: () => virtualTime,
      random: { nextFloat: () => 0 },
      minRequestIntervalMs: 0,
      rateLimitCooldownMs: 30,
      maxRateLimitCooldownMs: 30,
      loadApi: async () => ({
        cloudsearch: async ({ keywords }: { keywords: string }) => {
          requests.push(keywords);
          return keywords === "限流"
            ? { body: { code: 405, message: "操作频繁，请稍候再试" } }
            : { body: { result: { songs: [] } } };
        },
      }),
    });

    await musicIpScope.run("player:conn-a", async () => {
      await expect(provider.search("限流")).rejects.toMatchObject({
        code: "MUSIC_API_RATE_LIMITED",
      });
      // 同一作用域的配额确实被打满：冷却期内继续快速失败。
      await expect(provider.search("限流后")).rejects.toMatchObject({
        code: "MUSIC_API_RATE_LIMITED",
      });
    });
    // 另一个玩家的出口有自己的配额，不能因为别人撞了 405 一起停掉。
    await musicIpScope.run("player:conn-b", () => provider.search("正常"));

    expect(requests).toEqual(["限流", "正常"]);
  });

  test("同一作用域同一波并发 405 只记一档退避", async () => {
    let virtualTime = 1_000;
    let calls = 0;
    let started = 0;
    let releaseBoth!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const provider = new NeteaseMusicProvider({
      now: () => virtualTime,
      random: { nextFloat: () => 0 },
      maxConcurrentRequests: 2,
      minRequestIntervalMs: 0,
      rateLimitCooldownMs: 30,
      maxRateLimitCooldownMs: 600,
      loadApi: async () => ({
        cloudsearch: async () => {
          calls += 1;
          if (calls > 2) return { body: { result: { songs: [] } } };
          started += 1;
          if (started === 2) releaseBoth();
          await bothStarted;
          return { body: { code: 405, message: "操作频繁，请稍候再试" } };
        },
      }),
    });

    await musicIpScope.run("player:conn-burst", async () => {
      const settled = await Promise.allSettled([
        provider.search("并发甲"),
        provider.search("并发乙"),
      ]);
      expect(settled.every((result) => result.status === "rejected")).toBe(true);
      // 一次出题会并发五六条请求，若每条 405 各记一档，30ms 的起点会被顶成分钟级。
      virtualTime += 31;
      await expect(provider.search("恢复")).resolves.toEqual([]);
    });
    expect(calls).toBe(3);
  });

  test("一个作用域限流时，其它作用域已排队的请求重新入队并照常执行", async () => {
    const virtualTime = 1_000;
    let firstStarted = false;
    let releaseFirst!: () => void;
    const firstBlocker = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: string[] = [];
    const provider = new NeteaseMusicProvider({
      now: () => virtualTime,
      random: { nextFloat: () => 0 },
      maxConcurrentRequests: 1,
      minRequestIntervalMs: 0,
      rateLimitCooldownMs: 30,
      maxRateLimitCooldownMs: 30,
      queueTimeoutMs: 1_000,
      loadApi: async () => ({
        cloudsearch: async ({ keywords }: { keywords: string }) => {
          calls.push(keywords);
          if (keywords === "甲") {
            firstStarted = true;
            await firstBlocker;
            return { body: { code: 405, message: "操作频繁，请稍候再试" } };
          }
          return { body: { result: { songs: [] } } };
        },
      }),
    });

    const limited = musicIpScope.run("player:conn-a", () => provider.search("甲"));
    while (!firstStarted) await new Promise((resolve) => setTimeout(resolve, 1));
    const queued = musicIpScope.run("player:conn-b", () => provider.search("乙"));
    releaseFirst();

    await expect(limited).rejects.toMatchObject({ code: "MUSIC_API_RATE_LIMITED" });
    await expect(queued).resolves.toEqual([]);
    expect(calls).toEqual(["甲", "乙"]);
  });

  test("随机中国 IP 生成必然落在包内 CN 网段且不携带日志副作用", () => {
    const ranges = readChinaIpRanges();
    expect(ranges.length).toBeGreaterThan(4000);
    const inRange = (ip: string) => {
      const value = ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
      return ranges.some((range) => value >= range.start && value <= range.end);
    };
    for (let index = 0; index < 2000; index += 1) {
      const ip = randomChineseIp(ranges);
      expect(ip).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
      expect(inRange(ip)).toBe(true);
    }
  });

  test("支持注入 random 生成确定性伪装中国 IP", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      random: { nextFloat: () => 0.5 },
      loadApi: async () => ({
        cloudsearch: async (params: Record<string, unknown>) => {
          requests.push(params);
          return { body: { result: { songs: [] } } };
        },
      }),
    });

    await provider.search("测试歌曲", 20, "MUSIC_U=user-deterministic");
    // 同一随机源必然产出同一 IP；具体取值由 CN 网段权重决定，这里只锁定确定性与合法网段。
    const ip = String(requests[0]?.realIP);
    expect(ip).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
    const ranges = readChinaIpRanges();
    const value = ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
    expect(ranges.some((range) => value >= range.start && value <= range.end)).toBe(true);
    expect(randomChineseIp(ranges, { nextFloat: () => 0.5 })).toBe(
      randomChineseIp(ranges, { nextFloat: () => 0.5 })
    );
  });

  test("CN 网段解析会忽略 BOM、注释与非法行并保底兜底", () => {
    const parsed = parseChinaIpRanges(
      "\uFEFF1.1.8.0/24\n# comment\n\nbad-line\n999.1.1.1/8\n10.0.0.0/8\n"
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ start: 0x01010800, end: 0x010108ff, count: 256 });
    // 数据缺失时仍需产出合法 IPv4，避免彻底无法出网。
    expect(randomChineseIp([])).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
  });

  test("上游 405 会透传消息、清空队列并在冷却期快速失败", async () => {
    let calls = 0;
    let virtualTime = 1_000;
    let rejectFirst!: (reason: unknown) => void;
    let notifyFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      notifyFirstStarted = resolve;
    });
    const firstResponse = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const provider = new NeteaseMusicProvider({
      now: () => virtualTime,
      random: { nextFloat: () => 0 },
      maxConcurrentRequests: 1,
      minRequestIntervalMs: 0,
      rateLimitCooldownMs: 30,
      maxRateLimitCooldownMs: 30,
      queueTimeoutMs: 1_000,
      loadApi: async () => ({
        cloudsearch: async () => {
          calls += 1;
          if (calls === 1) {
            notifyFirstStarted();
            return firstResponse;
          }
          return { body: { result: { songs: [] } } };
        },
      }),
    });

    const pending = [
      provider.search("请求一"),
      provider.search("请求二"),
      provider.search("请求三"),
    ];
    await firstStarted;
    rejectFirst({
      status: 405,
      body: {
        code: 405,
        msg: "操作频繁，请稍候再试",
      },
    });

    const settled = await Promise.allSettled(pending);
    expect(calls).toBe(1);
    for (const result of settled) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({
          code: "MUSIC_API_RATE_LIMITED",
          message: "操作频繁，请稍候再试",
          details: { upstreamCode: 405 },
        });
      }
    }

    await expect(provider.search("冷却中")).rejects.toMatchObject({
      code: "MUSIC_API_RATE_LIMITED",
      message: "操作频繁，请稍候再试",
    });
    expect(calls).toBe(1);

    virtualTime += 50;
    await expect(provider.search("冷却结束")).resolves.toEqual([]);
    expect(calls).toBe(2);
  });

  test("上游正常返回 405 body 时同样进入冷却并透传消息", async () => {
    let calls = 0;
    let virtualTime = 1_000;
    const provider = new NeteaseMusicProvider({
      now: () => virtualTime,
      random: { nextFloat: () => 0 },
      minRequestIntervalMs: 0,
      rateLimitCooldownMs: 30,
      maxRateLimitCooldownMs: 30,
      loadApi: async () => ({
        cloudsearch: async () => {
          calls += 1;
          return calls === 1
            ? { body: { code: 405, message: "操作频繁，请稍候再试" } }
            : { body: { result: { songs: [] } } };
        },
      }),
    });

    await expect(provider.search("正常返回限流")).rejects.toMatchObject({
      code: "MUSIC_API_RATE_LIMITED",
      message: "操作频繁，请稍候再试",
      details: { upstreamCode: 405 },
    });
    await expect(provider.search("冷却期间快速失败")).rejects.toMatchObject({
      code: "MUSIC_API_RATE_LIMITED",
      message: "操作频繁，请稍候再试",
    });
    expect(calls).toBe(1);

    virtualTime += 50;
    await expect(provider.search("冷却结束恢复")).resolves.toEqual([]);
    expect(calls).toBe(2);
  });

  test("排队请求会过期而不是等待活动请求结束后补发", async () => {
    let calls = 0;
    let release!: () => void;
    let notifyFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      notifyFirstStarted = resolve;
    });
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = new NeteaseMusicProvider({
      maxConcurrentRequests: 1,
      minRequestIntervalMs: 0,
      queueTimeoutMs: 15,
      loadApi: async () => ({
        cloudsearch: async () => {
          calls += 1;
          if (calls === 1) {
            notifyFirstStarted();
            await blocker;
          }
          return { body: { result: { songs: [] } } };
        },
      }),
    });

    const active = provider.search("活动请求");
    await firstStarted;
    const queued = provider.search("陈旧请求");
    // 本地排队超时必须与上游限流分开编码：这里全程没有发生任何 405/406，
    // 只是本进程把自己堵住了，报成「限流」会让线上排查方向完全跑偏。
    await expect(queued).rejects.toMatchObject({
      code: "MUSIC_API_BUSY",
      message: "网易云请求等待超时，请稍后重试",
    });
    expect(calls).toBe(1);
    release();
    await expect(active).resolves.toEqual([]);
    expect(calls).toBe(1);
  });

  test("可选接口调用失败时记录采样告警日志并降级", async () => {
    const warnings: Array<{ message: string; meta: unknown }> = [];
    const fakeLogger = {
      warn: (message: string, meta: unknown) => {
        warnings.push({ message, meta });
      },
    } as any;

    const provider = new NeteaseMusicProvider({
      logger: fakeLogger,
      loadApi: async () => ({
        song_red_count: async () => {
          throw new Error("上游网络抖动");
        },
      }),
    });

    // 包上玩家作用域：本用例只验「可选接口降级」这一条告警。作用域缺失会另外发一条自己的
    // 告警（见下面那条专项用例），不在这儿混进同一条计数。
    const popularity = await musicIpScope.run("player:conn-optional", () =>
      provider.getSongPopularity("123")
    );
    expect(popularity).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe("网易云可选接口调用降级");
    expect(warnings[0]?.meta).toMatchObject({
      endpoints: ["song_red_count"],
    });
  });

  /**
   * 「忘记包玩家作用域」过去与后台预热共用同一条静默回落：现场只看到全服 405，
   * 看不到「所有人的匿名请求又挤回同一个出口 IP」这层原因，而前置条件只写在注释里。
   * 现在每次降级都计数，并按固定间隔最多补一条告警；显式声明的后台任务不占这条额度。
   */
  test("作用域外的匿名调用发限频告警，显式声明的后台任务不触发", async () => {
    const warnings: Array<{ message: string; meta: unknown }> = [];
    let virtualTime = 1_700_000_000_000;
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      now: () => virtualTime,
      logger: {
        warn: (message: string, meta: unknown) => {
          warnings.push({ message, meta });
        },
      } as any,
      loadApi: async () => ({
        cloudsearch: async () => ({ body: { result: { songs: [] } } }),
      }),
    });

    await provider.search("甲");
    // 回落仍在发生，但告警按间隔限频：满载时每条匿名请求都命中它，逐条 warn 会盖掉真正的故障。
    virtualTime += 1_000;
    await provider.search("乙");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe("音乐请求缺少玩家 IP 作用域，已回落共享匿名出口");
    expect(warnings[0]?.meta).toMatchObject({ fallbackScope: "anonymous" });

    virtualTime += 60_000;
    await provider.search("丙");
    expect(warnings).toHaveLength(2);

    // 预热与缓存维护按共享出口工作是设计如此，不能和「新调用链漏包作用域」共用一条告警。
    const beforeBackground = warnings.length;
    await runWithAnonymousMusicIpScope(() => provider.search("后台"));
    expect(warnings).toHaveLength(beforeBackground);

    // 包了玩家作用域的调用链不该出现这条告警。
    const beforeScoped = warnings.length;
    await musicIpScope.run("player:conn-scoped", () => provider.search("丁"));
    expect(warnings).toHaveLength(beforeScoped);
  });

  test("支持通过注入 now 与 random 驱动限流退避、冷却熔断与恢复", async () => {
    let virtualTime = 1_700_000_000_000;
    let upstreamCalls = 0;
    const provider = new NeteaseMusicProvider({
      now: () => virtualTime,
      random: { nextFloat: () => 0 },
      minRequestIntervalMs: 0,
      rateLimitCooldownMs: 5_000,
      loadApi: async () => ({
        cloudsearch: async () => {
          upstreamCalls += 1;
          if (upstreamCalls === 1) {
            return { body: { code: 405, message: "操作太频繁" } };
          }
          return { body: { result: { songs: [{ id: 99, name: "恢复歌曲" }] } } };
        },
      }),
    });

    // 1. 触发限流，进入 5s 冷却
    await expect(provider.search("测试1")).rejects.toMatchObject({
      code: "MUSIC_API_RATE_LIMITED",
    });
    expect(upstreamCalls).toBe(1);

    // 2. 推进 1 秒，仍在冷却中，本地直接拦截且不请求上游
    virtualTime += 1_000;
    await expect(provider.search("测试2")).rejects.toMatchObject({
      code: "MUSIC_API_RATE_LIMITED",
    });
    expect(upstreamCalls).toBe(1);

    // 3. 推进 5 秒越过冷却期，成功调用并恢复
    virtualTime += 5_000;
    const songs = await provider.search("测试3");
    expect(songs).toHaveLength(1);
    expect(songs[0]?.id).toBe("99");
    expect(upstreamCalls).toBe(2);
  });
});
