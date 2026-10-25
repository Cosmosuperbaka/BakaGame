import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { NeteaseMusicProvider } from "../../src/infrastructure/NeteaseMusicProvider";

describe("播放地址与解灰", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = (async () => {
      throw new Error("测试禁止网络请求");
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("获取歌曲副歌并支持空数据安全降级与全量加载装配", async () => {
    let chorusCalls = 0;
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({
        song_chorus: async ({ id }: { id: string | number }) => {
          chorusCalls += 1;
          if (String(id) === "100") {
            return {
              body: {
                code: 200,
                chorus: [{ id: 100, startTime: 45_000, endTime: 85_000, ugcLocked: 0 }],
              },
            };
          }
          return {
            body: {
              code: 200,
              chorus: [],
            },
          };
        },
        song_detail: async () => ({
          body: {
            songs: [
              {
                id: 100,
                name: "副歌测试曲",
                ar: [{ id: 1, name: "歌手" }],
                al: { id: 1, name: "专辑" },
                dt: 240_000,
              },
            ],
          },
        }),
        song_url: async () => ({
          body: {
            data: [{ id: 100, url: "http://music.example.com/100.mp3" }],
          },
        }),
        lyric_new: async () => ({
          body: {
            lrc: { lyric: "[00:10.00]第一句歌词\n[00:20.00]第二句歌词" },
          },
        }),
      }),
    });

    const chorusNormal = await provider.getSongChorus("100");
    expect(chorusNormal).toEqual({ startTime: 45_000, endTime: 85_000 });

    const chorusEmpty = await provider.getSongChorus("200");
    expect(chorusEmpty).toBeUndefined();
    await expect(provider.getSongChorus("200")).resolves.toBeUndefined();
    expect(chorusCalls).toBe(2);

    const fullSong = await provider.getSong("100");
    expect(fullSong.chorus).toEqual({ startTime: 45_000, endTime: 85_000 });
    expect(fullSong.audioUrl).toBe("https://music.example.com/100.mp3");
  });

  test("播放地址命中短缓存，并支持强制刷新", async () => {
    let urlCalls = 0;
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        song_detail: async () => ({
          body: { songs: [{ id: 7, name: "缓存曲", ar: [{ name: "歌手" }] }] },
        }),
        song_url: async () => ({
          body: { data: [{ id: 7, url: `http://music.example.com/${++urlCalls}.mp3` }] },
        }),
        lyric_new: async () => ({ body: { lrc: { lyric: "[00:01.00]缓存歌词" } } }),
      }),
    });

    await expect(provider.getSong("7")).resolves.toMatchObject({
      audioUrl: "https://music.example.com/1.mp3",
    });
    await expect(provider.getSong("7")).resolves.toMatchObject({
      audioUrl: "https://music.example.com/1.mp3",
    });
    expect(urlCalls).toBe(1);
    await expect(provider.refreshSongAudio!("7")).resolves.toBe("https://music.example.com/2.mp3");
    expect(urlCalls).toBe(2);
  });

  test("播放地址取空时不缓存负结果，后台恢复后必须能重试成功", async () => {
    let urlCalls = 0;
    // 首次回源上游抖动返回空地址，第二次恢复返回真实地址。
    // 空地址若被写进缓存，后续整个 TTL 内所有重试都会拿到空值 —— 玩家表现为
    // 「这首歌永远加载不出来」，且与出题随机性无关的偶发抖动会被放大成长期故障。
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        song_detail: async () => ({
          body: { songs: [{ id: 15, name: "抖动曲", ar: [{ name: "歌手" }] }] },
        }),
        song_url: async () => {
          urlCalls += 1;
          return urlCalls === 1
            ? { body: { data: [{ id: 15, url: null }] } }
            : { body: { data: [{ id: 15, url: "http://music.example.com/15.mp3" }] } };
        },
        lyric_new: async () => ({ body: { lrc: { lyric: "[00:01.00]抖动歌词" } } }),
      }),
    });

    await expect(provider.getSong("15")).rejects.toMatchObject({ code: "SONG_UNAVAILABLE" });
    // 第二次必须真正回源而不是复用被缓存的空值。
    await expect(provider.getSong("15")).resolves.toMatchObject({
      audioUrl: "https://music.example.com/15.mp3",
    });
    expect(urlCalls).toBe(2);
  });

  test("网易云歌曲无播放地址时自动触发全局解灰并返回 HTTPS 音频", async () => {
    let unblockCalls = 0;
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        song_detail: async () => ({
          body: { songs: [{ id: 88, name: "版权受限曲", ar: [{ name: "歌手" }] }] },
        }),
        song_url: async () => ({ body: { data: [{ id: 88, url: null, code: 404 }] } }),
        song_url_match: async ({ id }: { id: string | number }) => {
          unblockCalls += 1;
          return { body: { code: 200, data: `http://unblock.example.com/${id}.mp3` } };
        },
        lyric_new: async () => ({ body: { lrc: { lyric: "[00:01.00]测试歌词" } } }),
      }),
    });

    const song = await provider.getSong("88");
    expect(song.audioUrl).toBe("https://unblock.example.com/88.mp3");
    expect(unblockCalls).toBe(1);
  });

  test("网易云仅返回试听片段时自动触发解灰并替换为完整音频", async () => {
    let unblockCalls = 0;
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        song_detail: async () => ({
          body: { songs: [{ id: 89, name: "VIP试听曲", ar: [{ name: "歌手" }] }] },
        }),
        song_url: async () => ({
          body: {
            data: [
              {
                id: 89,
                url: "http://trial.example.com/89.mp3",
                freeTrialInfo: { start: 0, end: 30 },
              },
            ],
          },
        }),
        song_url_match: async ({ id }: { id: string | number }) => {
          unblockCalls += 1;
          return { body: { code: 200, data: `http://unblock.example.com/full-${id}.mp3` } };
        },
        lyric_new: async () => ({ body: { lrc: { lyric: "[00:01.00]试听替换歌词" } } }),
      }),
    });

    const song = await provider.getSong("89");
    expect(song.audioUrl).toBe("https://unblock.example.com/full-89.mp3");
    expect(unblockCalls).toBe(1);
  });

  test("官方只给试听片段且解灰失败时抛不可用，不把试听当成播放地址", async () => {
    // 试听片段同样是 audio/mpeg、同样能 Range 206，探测起来与整曲无异（实测只有约 30 秒）。
    // 一旦在解灰失败时退回它，出题会拿到一个片段作答案，玩家在片段播完后对着静音猜歌。
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        song_detail: async () => ({
          body: { songs: [{ id: 94, name: "试听且解灰失败曲", ar: [{ name: "歌手" }] }] },
        }),
        song_url: async () => ({
          body: {
            data: [
              {
                id: 94,
                url: "http://trial.example.com/94.mp3",
                freeTrialInfo: { start: 0, end: 30 },
              },
            ],
          },
        }),
        song_url_match: async () => ({ body: { code: 200, data: null } }),
        lyric_new: async () => ({ body: { lrc: { lyric: "[00:01.00]试听歌词" } } }),
      }),
    });

    await expect(provider.getSong("94")).rejects.toMatchObject({
      code: "SONG_UNAVAILABLE",
      message: "该歌曲暂时没有可用播放地址",
    });
  });

  test("解灰音源挂起不返回时会超时并按不可用处理，不会把整轮出题钉死", async () => {
    // 上游确实存在「请求被丢弃、Promise 永不 settle」的情况。没有上界时 getSong 会永远挂起，
    // 自动出题随即永久停在 automaticRoundLoading，房间再也开不了下一轮（这条用例会直接超时失败）。
    const attempted: string[] = [];
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      // 用极小的上界驱动同一段逻辑，不必等真实的秒级超时
      unblockSourceTimeoutMs: 10,
      unblockTotalBudgetMs: 45,
      loadApi: async () => ({
        song_detail: async () => ({
          body: { songs: [{ id: 95, name: "解灰挂起曲", ar: [{ name: "歌手" }] }] },
        }),
        song_url: async () => ({ body: { data: [{ id: 95, url: null, code: 404 }] } }),
        song_url_match: ({ source }: { source?: string }) => {
          attempted.push(String(source));
          return new Promise(() => {});
        },
        lyric_new: async () => ({ body: { lrc: { lyric: "[00:01.00]歌词" } } }),
      }),
    });

    await expect(provider.getSong("95")).rejects.toMatchObject({ code: "SONG_UNAVAILABLE" });
    expect(attempted.length).toBeGreaterThan(0);
    // 单个音源超时后继续换源，但总预算用尽即停手，不会把 8 个音源全等满
    expect(attempted.length).toBeLessThanOrEqual(8);
  });

  test("song_url_match 缺失时平滑回退至 song_url_v1 带 unblock 参数解灰", async () => {
    let v1UnblockCalls = 0;
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        song_detail: async () => ({
          body: { songs: [{ id: 90, name: "回退解灰曲", ar: [{ name: "歌手" }] }] },
        }),
        song_url: async () => ({ body: { data: [{ id: 90, url: null }] } }),
        song_url_v1: async (params: Record<string, unknown>) => {
          if (params.unblock === "true") {
            v1UnblockCalls += 1;
            return {
              body: {
                data: [{ id: 90, url: "http://v1-unblock.example.com/90.mp3" }],
              },
            };
          }
          throw new Error("xeapi missing");
        },
        lyric_new: async () => ({ body: { lrc: { lyric: "[00:01.00]回退歌词" } } }),
      }),
    });

    const song = await provider.getSong("90");
    expect(song.audioUrl).toBe("https://v1-unblock.example.com/90.mp3");
    expect(v1UnblockCalls).toBe(1);
  });

  test("关闭全局解灰时受限歌曲不发起解灰并抛出 SONG_UNAVAILABLE", async () => {
    let unblockCalls = 0;
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      enableGeneralUnblock: false,
      loadApi: async () => ({
        song_detail: async () => ({
          body: { songs: [{ id: 91, name: "禁用解灰曲", ar: [{ name: "歌手" }] }] },
        }),
        song_url: async () => ({ body: { data: [{ id: 91, url: null }] } }),
        song_url_match: async () => {
          unblockCalls += 1;
          return { body: { code: 200, data: "http://unblock/91.mp3" } };
        },
        lyric_new: async () => ({ body: { lrc: { lyric: "[00:01.00]歌词" } } }),
      }),
    });

    await expect(provider.getSong("91")).rejects.toMatchObject({
      code: "SONG_UNAVAILABLE",
      message: "该歌曲暂时没有可用播放地址",
    });
    expect(unblockCalls).toBe(0);
  });

  test("首个音源只返回网易云官方灰链时跳过该音源并采用后续音源", async () => {
    const attempted: string[] = [];
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      enableGeneralUnblock: true,
      loadApi: async () => ({
        song_detail: async () => ({
          body: { songs: [{ id: 93, name: "灰链兜底曲", ar: [{ name: "歌手" }] }] },
        }),
        song_url: async () => ({ body: { data: [{ id: 93, url: null }] } }),
        song_url_match: async ({ id, source }: { id: string | number; source?: string }) => {
          attempted.push(String(source));
          if (attempted.length === 1) {
            // 网易云官方外链兜底：字符串非空，但受限歌曲播放器只能拿到下载页 HTML
            return {
              body: { code: 200, data: `https://music.163.com/song/media/outer/url?id=${id}.mp3` },
            };
          }
          return { body: { code: 200, data: `http://unblock.example.com/full-${id}.mp3` } };
        },
        lyric_new: async () => ({ body: { lrc: { lyric: "[00:01.00]灰链曲歌词" } } }),
      }),
    });

    const song = await provider.getSong("93");
    expect(song.audioUrl).toBe("https://unblock.example.com/full-93.mp3");
    expect(attempted.length).toBeGreaterThan(1);
    expect(attempted[0]).toBe("unm");
  });

  test("所有音源都只能给出网易云官方灰链时抛出 SONG_UNAVAILABLE 而非伪解灰地址", async () => {
    const attempted: string[] = [];
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      enableGeneralUnblock: true,
      loadApi: async () => ({
        song_detail: async () => ({
          body: { songs: [{ id: 94, name: "无解曲", ar: [{ name: "歌手" }] }] },
        }),
        song_url: async () => ({ body: { data: [{ id: 94, url: null }] } }),
        song_url_match: async ({ id, source }: { id: string | number; source?: string }) => {
          attempted.push(String(source));
          return {
            body: { code: 200, data: `https://music.163.com/song/media/outer/url?id=${id}.mp3` },
          };
        },
        lyric_new: async () => ({ body: { lrc: { lyric: "[00:01.00]无解曲歌词" } } }),
      }),
    });

    await expect(provider.getSong("94")).rejects.toMatchObject({
      code: "SONG_UNAVAILABLE",
      message: "该歌曲暂时没有可用播放地址",
    });
    expect(attempted.length).toBeGreaterThan(1);
    expect(attempted).toContain("unm");
    expect(attempted).toContain("bugpk");
  });

  test("正常可用官方全曲不触发解灰", async () => {
    let unblockCalls = 0;
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      enableGeneralUnblock: true,
      loadApi: async () => ({
        song_detail: async () => ({
          body: { songs: [{ id: 92, name: "正常曲目", ar: [{ name: "歌手" }] }] },
        }),
        song_url: async () => ({
          body: {
            data: [{ id: 92, url: "http://official.example.com/92.mp3", freeTrialInfo: null }],
          },
        }),
        song_url_match: async () => {
          unblockCalls += 1;
          return { body: { code: 200, data: "http://unblock/92.mp3" } };
        },
        lyric_new: async () => ({ body: { lrc: { lyric: "[00:01.00]官方曲歌词" } } }),
      }),
    });

    const song = await provider.getSong("92");
    expect(song.audioUrl).toBe("https://official.example.com/92.mp3");
    expect(unblockCalls).toBe(0);
  });
});
