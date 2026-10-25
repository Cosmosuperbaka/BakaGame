import { describe, expect, it, mock, afterEach } from "bun:test";
import { QQMusicProvider } from "../../src/infrastructure/QQMusicProvider";
import { musicIpScope } from "../../src/infrastructure/MusicIpScope";
import qqmusic from "qqmusic-api-enhanced";
import { offlineAmll } from "./Fixtures";

const originals = {
  search: qqmusic.search,
  song_detail: qqmusic.song_detail,
  lyric: qqmusic.lyric,
};
const restore = () => Object.assign(qqmusic, originals);
afterEach(restore);

describe("QQ音乐上游队列与限流退避", () => {
  for (const upstreamStatus of [429, 503]) {
    it(`上游返回 ${upstreamStatus} 时进入限流退避，冷却期内快速失败且不回源`, async () => {
      let virtualTime = 1_000;
      let calls = 0;
      const provider = new QQMusicProvider({
        now: () => virtualTime,
        random: { nextFloat: () => 0 },
        minRequestIntervalMs: 0,
        rateLimitCooldownMs: 30,
        maxRateLimitCooldownMs: 30,
      });
      qqmusic.search = mock(async () => {
        calls += 1;
        return calls === 1
          ? { status: upstreamStatus, body: { code: upstreamStatus, message: "请求过于频繁" } }
          : { status: 200, body: { songs: [] } };
      }) as any;

      await expect(provider.search("首次限流")).rejects.toMatchObject({
        code: "MUSIC_API_RATE_LIMITED",
        message: "请求过于频繁",
        details: { upstreamCode: upstreamStatus },
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

  it("HTTP 200 但 body.code 为限流码时同样进入退避", async () => {
    let virtualTime = 1_000;
    let calls = 0;
    const provider = new QQMusicProvider({
      now: () => virtualTime,
      random: { nextFloat: () => 0 },
      minRequestIntervalMs: 0,
      rateLimitCooldownMs: 30,
      maxRateLimitCooldownMs: 30,
    });
    qqmusic.search = mock(async () => {
      calls += 1;
      return calls === 1
        ? { status: 200, body: { code: 429, message: "请求过于频繁" } }
        : { status: 200, body: { songs: [] } };
    }) as any;

    await expect(provider.search("body 限流")).rejects.toMatchObject({
      code: "MUSIC_API_RATE_LIMITED",
      message: "请求过于频繁",
      details: { upstreamCode: 429 },
    });
    expect(calls).toBe(1);
    virtualTime += 50;
    await expect(provider.search("冷却结束")).resolves.toEqual([]);
    expect(calls).toBe(2);
  });

  it("本地排队超时按 MUSIC_API_BUSY 编码，与上游限流分开", async () => {
    let calls = 0;
    let release!: () => void;
    let notifyFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      notifyFirstStarted = resolve;
    });
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = new QQMusicProvider({
      minRequestIntervalMs: 0,
      anonymousMaxConcurrentRequests: 1,
      queueTimeoutMs: 15,
      ...offlineAmll,
    });
    qqmusic.song_detail = mock(async () => {
      calls += 1;
      if (calls === 1) {
        notifyFirstStarted();
        await blocker;
      }
      return {
        status: 200,
        body: { data: { track_info: { name: "T", singer: [{ name: "A" }] } } },
      };
    }) as any;
    qqmusic.lyric = mock(async () => ({ status: 200, body: {} })) as any;

    const active = provider.getSongMetadata("qq:busy1");
    await firstStarted;
    const queued = provider.getSongMetadata("qq:busy2");
    // 全程没有上游限流，只是本进程把自己堵住了：必须与限流分开编码，排查方向才不会跑偏。
    await expect(queued).rejects.toMatchObject({
      code: "MUSIC_API_BUSY",
      message: "QQ音乐匿名请求等待超时，请稍后重试",
    });
    expect(calls).toBe(1);
    release();
    await expect(active).resolves.toMatchObject({ title: "T" });
    expect(calls).toBe(1);
  });

  it("作用域外的匿名调用发限频告警，包了玩家作用域的调用不触发", async () => {
    const warnings: Array<{ message: string; meta: unknown }> = [];
    let virtualTime = 1_700_000_000_000;
    const provider = new QQMusicProvider({
      now: () => virtualTime,
      minRequestIntervalMs: 0,
      logger: {
        warn: (message: string, meta: unknown) => warnings.push({ message, meta }),
      } as any,
    });
    qqmusic.search = mock(async () => ({ status: 200, body: { songs: [] } })) as any;

    await provider.search("甲");
    // 回落仍在发生，但告警按间隔限频：满载时逐条 warn 会盖掉真正的故障。
    virtualTime += 1_000;
    await provider.search("乙");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe("音乐请求缺少玩家 IP 作用域，已回落共享匿名出口");
    expect(warnings[0]?.meta).toMatchObject({ fallbackScope: "anonymous" });

    const beforeScoped = warnings.length;
    await musicIpScope.run("player:conn-qq", () => provider.search("丙"));
    expect(warnings).toHaveLength(beforeScoped);
  });
});
