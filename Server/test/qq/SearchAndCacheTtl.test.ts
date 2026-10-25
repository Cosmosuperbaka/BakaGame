import { describe, expect, it, mock, afterEach } from "bun:test";
import { QQMusicProvider } from "../../src/infrastructure/QQMusicProvider";
import qqmusic from "qqmusic-api-enhanced";
import { offlineAmll } from "./Fixtures";

const originals = {
  search: qqmusic.search,
  song_detail: qqmusic.song_detail,
  lyric: qqmusic.lyric,
  song_url: qqmusic.song_url,
};
const restore = () => Object.assign(qqmusic, originals);
afterEach(restore);

describe("QQ音乐检索缓存（MusicCache 语义）", () => {
  it("同键并发请求合并为一次上游调用，返回值是克隆不污染缓存", async () => {
    let calls = 0;
    let finishFirstSearch!: () => void;
    const firstSearchBlocker = new Promise<void>((resolve) => {
      finishFirstSearch = resolve;
    });
    const provider = new QQMusicProvider({ minRequestIntervalMs: 0 });
    qqmusic.search = mock(async () => {
      calls += 1;
      if (calls === 1) await firstSearchBlocker;
      return { status: 200, body: { songs: [{ mid: `m${calls}`, title: "歌曲" }] } };
    }) as any;

    const concurrentPromise = Promise.all([
      provider.search("并发"),
      provider.search("并发"),
      provider.search("并发"),
    ]);
    finishFirstSearch();
    const concurrent = await concurrentPromise;
    expect(calls).toBe(1);
    concurrent[0].push({ id: "qq:local", title: "本地改动", artist: "测试" });
    expect(concurrent[1]).toHaveLength(1);
    await expect(provider.search("并发")).resolves.toHaveLength(1);
    expect(calls).toBe(1);
  });

  it("匿名空结果沿用短 TTL，非空结果按公共 5 分钟口径缓存", async () => {
    let now = 1_000;
    let calls = 0;
    const provider = new QQMusicProvider({ now: () => now, minRequestIntervalMs: 0 });
    qqmusic.search = mock(async ({ keywords }: { keywords?: string }) => {
      calls += 1;
      return {
        status: 200,
        body: { songs: keywords === "有结果" ? [{ mid: "m1", title: "命中" }] : [] },
      };
    }) as any;

    await expect(provider.search("空结果")).resolves.toEqual([]);
    await expect(provider.search("空结果")).resolves.toEqual([]);
    expect(calls).toBe(1);

    // 空结果按 60s 短 TTL：硬过期（3×60s）之后必须重新回源，
    // 不能按「公共检索结果」钉住 5 分钟。
    now += 181_000;
    await expect(provider.search("空结果")).resolves.toEqual([]);
    expect(calls).toBe(2);

    await expect(provider.search("有结果")).resolves.toHaveLength(1);
    expect(calls).toBe(3);
    // 非空结果按 5 分钟口径：软过期（4 分钟）之内命中自不必说，
    // 软过期之后（这里 +361s）到硬过期（15 分钟）之前也先返回旧值，不阻塞调用方。
    now += 61_000;
    await expect(provider.search("有结果")).resolves.toHaveLength(1);
    expect(calls).toBe(3);
    now += 300_000;
    await expect(provider.search("有结果")).resolves.toHaveLength(1);
    expect(calls).toBe(3);
  });

  it("熔断期内缓存命中仍可服务，未命中的关键词才被拦截", async () => {
    let calls = 0;
    const provider = new QQMusicProvider({ now: () => 1_000, minRequestIntervalMs: 0 });
    qqmusic.search = mock(async () => {
      calls += 1;
      return { status: 200, body: { songs: [{ mid: "warm", title: "已有缓存" }] } };
    }) as any;
    await provider.search("已缓存", 5);
    expect(calls).toBe(1);

    qqmusic.search = mock(async () => {
      calls += 1;
      throw new Error("upstream down");
    }) as any;
    for (let index = 0; index < 3; index += 1) {
      await expect(provider.search(`失败${index}`, 5)).rejects.toThrow("upstream down");
    }
    // 熔断已开：新关键词返回空且不打上游，已缓存关键词照常返回缓存值。
    await expect(provider.search("未缓存", 5)).resolves.toEqual([]);
    expect(await provider.search("已缓存", 5)).toHaveLength(1);
    expect(calls).toBe(4);
  });

  it("播放地址按 Cookie 指纹分键，不同账号不共享直链缓存", async () => {
    let audioCalls = 0;
    const provider = new QQMusicProvider({ minRequestIntervalMs: 0, ...offlineAmll });
    qqmusic.song_detail = mock(async () => ({
      status: 200,
      body: { data: { track_info: { name: "T", singer: [{ name: "A" }] } } },
    })) as any;
    qqmusic.lyric = mock(async () => ({ status: 200, body: {} })) as any;
    qqmusic.song_url = mock(async () => {
      audioCalls += 1;
      return { status: 200, body: { data: [{ url: `https://cdn.example/${audioCalls}.mp3` }] } };
    }) as any;

    await expect(provider.getSong("qq:audio1", "uin=1; qm_keyst=a")).resolves.toMatchObject({
      audioUrl: "https://cdn.example/1.mp3",
    });
    await expect(provider.getSong("qq:audio1", "uin=2; qm_keyst=b")).resolves.toMatchObject({
      audioUrl: "https://cdn.example/2.mp3",
    });
    expect(audioCalls).toBe(2);
    // 元数据是公开数据共享缓存；直链只按账号各自命中，不再回源。
    await expect(provider.getSong("qq:audio1", "uin=1; qm_keyst=a")).resolves.toMatchObject({
      audioUrl: "https://cdn.example/1.mp3",
    });
    expect(audioCalls).toBe(2);
  });
});
