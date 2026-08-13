import { describe, expect, test } from "bun:test";

import {
  NeteaseMusicProvider,
  isInstrumentalLyricLine,
  parseLrc,
  sanitizeLyrics,
} from "../src/infrastructure/netease-music-provider";

describe("NeteaseMusicProvider", () => {
  test("filters instrumental placeholders without removing ordinary lyrics", () => {
    expect(isInstrumentalLyricLine("Music")).toBe(true);
    expect(isInstrumentalLyricLine("[Music]")).toBe(true);
    expect(isInstrumentalLyricLine("Music - Instrumental")).toBe(true);
    expect(isInstrumentalLyricLine("instrumental2")).toBe(true);
    expect(isInstrumentalLyricLine("we still hear music tonight")).toBe(false);

    const lyrics = parseLrc([
      "[00:01.00]Music",
      "[00:02.00][Music]",
      "[00:03.00]Music - Instrumental",
      "[00:04.00]verse one",
      "[00:05.00]verse two",
    ].join("\n"));
    expect(sanitizeLyrics(lyrics, { title: "answer", artist: "artist" })).toEqual([
      { time: 4_000, endTime: 5_000, text: "verse one" },
      { time: 5_000, endTime: 10_000, text: "verse two" },
    ]);
  });

  test("读取歌单、歌手歌曲与热度字段", async () => {
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({
        playlist_track_all: async () => ({
          body: {
            playlist: { id: 42, name: "自动题库", trackCount: 2 },
            songs: [
              { id: 1, name: "高热度", ar: [{ id: 7, name: "歌手甲" }], al: { name: "专辑" }, pop: 100_000 },
              { id: 2, name: "普通", ar: [{ id: 7, name: "歌手甲" }], al: { name: "专辑" }, pop: 999 },
            ],
          },
        }),
        cloudsearch: async ({ type }: { type: number }) => ({
          body: { result: type === 100 ? { artists: [{ id: 7, name: "歌手甲" }] } : { songs: [] } },
        }),
        artist_songs: async () => ({
          body: { songs: [{ id: 1, name: "高热度", ar: [{ id: 7, name: "歌手甲" }], al: { name: "专辑" }, pop: 100_000 }] },
        }),
        song_red_count: async () => ({ body: { code: 200, data: { count: 123_456, countDesc: "100w+" } } }),
      }),
    });

    await expect(provider.getPlaylistSongs("42")).resolves.toMatchObject({
      info: { id: "42", name: "自动题库", songCount: 2 },
      songs: [{ id: "1" }, { id: "2" }],
    });
    await expect(provider.searchArtists("歌手甲")).resolves.toEqual([{ id: "7", name: "歌手甲" }]);
    await expect(provider.getArtistSongs("7")).resolves.toEqual([
      expect.objectContaining({ id: "1" }),
    ]);
    await expect(provider.getSongPopularity("1")).resolves.toBe(123_456);
  });

  test("解析多时间戳 LRC 并补齐结束时间", () => {
    expect(parseLrc("[00:01.00][00:03.500]第一句\n[00:05.00]第二句")).toEqual([
      { time: 1_000, endTime: 3_500, text: "第一句" },
      { time: 3_500, endTime: 5_000, text: "第一句" },
      { time: 5_000, endTime: 10_000, text: "第二句" },
    ]);
  });

  test("过滤作词作曲编曲与标题信息并重新衔接时间轴", () => {
    const lyrics = parseLrc([
      "[00:01.00]答案歌",
      "[00:02.00]作词人：某某",
      "[00:03.00]第一句歌词",
      "[00:04.00]我们在唱答案歌",
      "[00:05.00]词曲：某某",
      "[00:07.00]第二句歌词",
      "[00:09.00]编曲人：某某",
      "[00:10.00]Production Coordination: Stanley Leung",
      "[00:11.00]Keyboards & Programming: 某某",
      "[00:12.00]Drums: 某某",
      "[00:13.00]Strings Arranged & Conducted by 某某",
      "[00:14.00]Recorded at example studio",
      "[00:15.00]Engineered by 某某",
      "[00:16.00]测试歌手",
    ].join("\n"));

    expect(sanitizeLyrics(lyrics, {
      title: "答案歌",
      artist: "测试歌手",
      album: "测试专辑",
    })).toEqual([
      { time: 3_000, endTime: 7_000, text: "第一句歌词" },
      { time: 7_000, endTime: 12_000, text: "第二句歌词" },
    ]);
  });

  test("猜测歌曲只读取元数据，无歌词歌曲也可以用于猜测", async () => {
    const calls: string[] = [];
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({
        song_detail: async () => {
          calls.push("song_detail");
          return {
            body: {
              songs: [{
                id: 77,
                name: "纯音乐",
                ar: [{ name: "演奏者" }],
                al: { name: "器乐专辑", publishTime: Date.UTC(2024, 0, 1) },
                pop: 66,
                dt: 120_000,
              }],
            },
          };
        },
        lyric_new: async () => {
          calls.push("lyric_new");
          throw new Error("不应请求歌词");
        },
        song_url_v1: async () => {
          calls.push("song_url_v1");
          throw new Error("不应请求音频");
        },
      }),
    });

    await expect(provider.getSongMetadata("77")).resolves.toMatchObject({
      id: "77",
      title: "纯音乐",
      audioUrl: "",
      lyrics: [],
      releaseYear: 2024,
    });
    expect(calls).toEqual(["song_detail"]);
  });

  test("出题歌曲没有歌词时仍返回播放资源", async () => {
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({
        song_detail: async () => ({
          body: {
            songs: [{
              id: 78,
              name: "纯音乐题",
              ar: [{ name: "演奏者" }],
              al: { name: "器乐专辑" },
              dt: 120_000,
            }],
          },
        }),
        lyric_new: async () => ({ body: { lrc: { lyric: "" } } }),
        song_url: async () => ({ body: { data: [{ url: "https://audio/78.mp3" }] } }),
      }),
    });

    await expect(provider.getSong("78")).resolves.toMatchObject({
      audioUrl: "https://audio/78.mp3",
      lyrics: [],
    });
  });

  test("扫码登录只把最终 Cookie 返回给调用者并可读取账号状态", async () => {
    const calls: string[] = [];
    const provider = new NeteaseMusicProvider({
      randomCNIP: false,
      loadApi: async () => ({
        login_qr_key: async (params: Record<string, unknown>) => {
          calls.push("login_qr_key");
          expect(params.cookie).toEqual({});
          return { body: { data: { code: 200, unikey: "qr-key" } } };
        },
        login_qr_create: async (params: Record<string, unknown>) => {
          calls.push("login_qr_create");
          expect(params).toMatchObject({ key: "qr-key", qrimg: true, randomCNIP: false });
          return {
            body: {
              code: 200,
              data: { qrurl: "https://music.163.com/login?codekey=qr-key", qrimg: "data:image/png;base64,qr" },
            },
          };
        },
        login_qr_check: async () => {
          calls.push("login_qr_check");
          return { body: { code: 803, message: "授权登录成功", cookie: "MUSIC_U=qr-cookie" } };
        },
        login_status: async (params: Record<string, unknown>) => {
          calls.push("login_status");
          expect(params.cookie).toBe("MUSIC_U=qr-cookie");
          expect(params.randomCNIP).toBe(false);
          return {
            body: {
              data: {
                code: 200,
                profile: { userId: 42, nickname: "扫码用户", avatarUrl: "https://img/avatar.jpg" },
              },
            },
          };
        },
      }),
    });

    await expect(provider.createQrLogin()).resolves.toMatchObject({
      key: "qr-key",
      qrImage: "data:image/png;base64,qr",
    });
    await expect(provider.checkQrLogin("qr-key")).resolves.toMatchObject({
      status: "authorized",
      message: "授权登录成功",
      session: {
        cookie: "MUSIC_U=qr-cookie",
        account: {
          userId: "42",
          nickname: "扫码用户",
          avatarUrl: "https://img/avatar.jpg",
        },
      },
    });
    expect(calls).toEqual([
      "login_qr_key",
      "login_qr_create",
      "login_qr_check",
      "login_status",
    ]);
  });

  test("扫码接口被网易云风控拦截时不向客户端暴露提醒链接", async () => {
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({
        login_qr_key: async () => ({
          body: {
            code: 8810,
            message: "您当前的网络环境存在安全风险",
            redirectUrl: "https://y.music.163.com/g/yida/private-risk-url",
          },
        }),
      }),
    });

    const error = await provider.createQrLogin().catch(
      (value) => value as Error & { code?: string; details?: unknown },
    ) as Error & { code?: string; details?: unknown };
    expect(error).toMatchObject({ code: "MUSIC_LOGIN_RISK" });
    expect(error.message).not.toContain("private-risk-url");
    expect(JSON.stringify(error)).not.toContain("private-risk-url");
  });

  test("匿名令牌只用于后端请求参数，不会作为登录结果返回", async () => {
    const observed: Record<string, unknown>[] = [];
    let registerParams: Record<string, unknown> | undefined;
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({
        register_anonimous: async (params: Record<string, unknown>) => {
          registerParams = params;
          return { cookie: ["MUSIC_A=anonymous-only"] };
        },
        cloudsearch: async (params: Record<string, unknown>) => {
          observed.push(params);
          return { body: { result: { songs: [] } } };
        },
      }),
    });

    await expect(provider.search("test")).resolves.toEqual([]);
    expect(registerParams?.cookie).toEqual({});
    expect(observed[0]?.cookie).toBe("MUSIC_A=anonymous-only");
  });

  test("通过增强 API 包聚合搜索、歌曲、歌词、播放地址与百科", async () => {
    const calls: string[] = [];
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({
        cloudsearch: async (params: Record<string, unknown>) => {
          expect(params.cookie).toBe("MUSIC_U=test");
          expect(params.randomCNIP).toBe(true);
          calls.push("cloudsearch");
          return {
            body: {
              result: {
                songs: [
                  {
                    id: 42,
                    name: "答案歌",
                    ar: [{ name: "歌手甲" }],
                    al: { name: "专辑甲", picUrl: "https://img/42.jpg" },
                    dt: 180_000,
                  },
                ],
              },
            },
          };
        },
        song_detail: async () => {
          calls.push("song_detail");
          return {
            body: {
              songs: [
                {
                  id: 42,
                  name: "答案歌",
                  ar: [{ name: "歌手甲" }],
                  al: {
                    name: "专辑甲",
                    picUrl: "https://img/42.jpg",
                    publishTime: Date.UTC(2020, 0, 1),
                  },
                  pop: 88,
                  dt: 180_000,
                },
              ],
            },
          };
        },
        song_url_v1: async () => {
          calls.push("song_url_v1");
          return { body: { data: [{ url: "https://audio/42.mp3" }] } };
        },
        lyric_new: async () => {
          calls.push("lyric_new");
          return { body: { lrc: { lyric: "[00:01.00]一\n[00:04.00]二" } } };
        },
        song_wiki_summary: async () => {
          calls.push("song_wiki_summary");
          return {
            body: {
              data: {
                blocks: [
                  { title: "语种", content: "国语" },
                  { title: "曲风", content: "流行、摇滚" },
                  { title: "歌曲简介", content: "测试百科" },
                ],
              },
            },
          };
        },
      }),
    });

    const search = await provider.search("答案", 20, "MUSIC_U=test");
    expect(search[0]).toMatchObject({ id: "42", title: "答案歌", artist: "歌手甲" });

    const song = await provider.getSong("42");
    expect(song).toMatchObject({
      id: "42",
      audioUrl: "https://audio/42.mp3",
      releaseYear: 2020,
      popularity: 88,
      language: "国语",
      encyclopedia: { summary: "测试百科", tags: ["流行", "摇滚"] },
    });
    expect(song.lyrics).toHaveLength(2);
    expect(calls).toContain("cloudsearch");
    expect(calls).toContain("song_wiki_summary");
  });

  test("播放地址避开缺少 xeapi 公钥的 v1 端点并在端点全部失败时返回业务错误", async () => {
    const calls: string[] = [];
    const baseApi = {
      song_detail: async () => ({
        body: {
          songs: [{ id: 42, name: "答案歌", ar: [{ name: "歌手甲" }], al: { name: "专辑甲" } }],
        },
      }),
      lyric_new: async () => ({
        body: { lrc: { lyric: "[00:01.00]第一句\n[00:04.00]第二句" } },
      }),
    };
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({
        ...baseApi,
        song_url: async () => {
          calls.push("song_url");
          return { body: { data: [{ url: "http://audio/42.mp3" }] } };
        },
        song_url_v1: async () => {
          calls.push("song_url_v1");
          throw new Error("xeapi public key is missing");
        },
      }),
    });

    await expect(provider.getSong("42")).resolves.toMatchObject({
      audioUrl: "https://audio/42.mp3",
    });
    expect(calls).toEqual(["song_url"]);

    const unavailableProvider = new NeteaseMusicProvider({
      loadApi: async () => ({
        ...baseApi,
        song_url: async () => {
          throw new Error("legacy endpoint failed");
        },
        song_url_v1: async () => {
          throw new Error("xeapi public key is missing");
        },
      }),
    });
    await expect(unavailableProvider.getSong("42")).rejects.toMatchObject({
      code: "MUSIC_API_FAILED",
    });
  });

  test("登录状态会读取会员信息，并区分会员与非会员", async () => {
    const createProvider = (vipCode: number, expireTime: number) => new NeteaseMusicProvider({
      randomCNIP: false,
      loadApi: async () => ({
        login_status: async () => ({
          body: {
            data: {
              code: 200,
              profile: { userId: 42, nickname: "会员测试" },
            },
          },
        }),
        vip_info_v2: async (params: Record<string, unknown>) => {
          expect(params).toMatchObject({ uid: "42", cookie: "MUSIC_U=test" });
          return {
            body: {
              code: 200,
              data: { associator: { vipCode, expireTime } },
            },
          };
        },
      }),
    });

    await expect(createProvider(100, Date.now() + 60_000).getLoginStatus("MUSIC_U=test"))
      .resolves.toMatchObject({
        account: { vipStatus: "vip", vipType: 100 },
      });
    await expect(createProvider(0, Date.now() - 60_000).getLoginStatus("MUSIC_U=test"))
      .resolves.toMatchObject({
        account: { vipStatus: "nonVip" },
      });
  });

  test("登录状态接口返回嵌套失效码时不会误判为已登录", async () => {
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({
        login_status: async () => ({
          body: {
            code: 200,
            data: { code: 301, profile: null, account: null },
          },
        }),
      }),
    });

    await expect(provider.getLoginStatus("MUSIC_U=expired"))
      .rejects.toMatchObject({ code: "MUSIC_SESSION_INVALID" });
  });

  test("搜索缓存会合并并发请求并保持有界", async () => {
    let calls = 0;
    const provider = new NeteaseMusicProvider({
      cacheMaxEntries: 1,
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        cloudsearch: async ({ keywords }: { keywords: string }) => {
          calls += 1;
          await Bun.sleep(5);
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

    const concurrent = await Promise.all([
      provider.search("同一首歌"),
      provider.search("同一首歌"),
      provider.search("同一首歌"),
    ]);
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

    expect(requests[0]?.realIP).toBe(requests[1]?.realIP);
    expect(requests[0]?.realIP).toMatch(/^116\.(?:2[5-9]|[3-8]\d|9[0-4])\.\d{1,3}\.\d{1,3}$/);
    expect(requests[2]?.realIP).toMatch(/^116\.(?:2[5-9]|[3-8]\d|9[0-4])\.\d{1,3}\.\d{1,3}$/);
    expect(requests.every((params) => params.randomCNIP === true)).toBe(true);
  });

  test("上游 405 会透传消息、清空队列并在冷却期快速失败", async () => {
    let calls = 0;
    let rejectFirst!: (reason: unknown) => void;
    const firstResponse = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const provider = new NeteaseMusicProvider({
      maxConcurrentRequests: 1,
      minRequestIntervalMs: 0,
      rateLimitCooldownMs: 30,
      maxRateLimitCooldownMs: 30,
      queueTimeoutMs: 1_000,
      loadApi: async () => ({
        cloudsearch: async () => {
          calls += 1;
          if (calls === 1) return firstResponse;
          return { body: { result: { songs: [] } } };
        },
      }),
    });

    const pending = [
      provider.search("请求一"),
      provider.search("请求二"),
      provider.search("请求三"),
    ];
    while (calls === 0) await Bun.sleep(1);
    await Bun.sleep(1);
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

    await Bun.sleep(35);
    await expect(provider.search("冷却结束")).resolves.toEqual([]);
    expect(calls).toBe(2);
  });

  test("上游正常返回 405 body 时同样进入冷却并透传消息", async () => {
    let calls = 0;
    const provider = new NeteaseMusicProvider({
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

    await Bun.sleep(35);
    await expect(provider.search("冷却结束恢复")).resolves.toEqual([]);
    expect(calls).toBe(2);
  });

  test("排队请求会过期而不是等待活动请求结束后补发", async () => {
    let calls = 0;
    let release!: () => void;
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
          if (calls === 1) await blocker;
          return { body: { result: { songs: [] } } };
        },
      }),
    });

    const active = provider.search("活动请求");
    while (calls === 0) await Bun.sleep(1);
    const queued = provider.search("陈旧请求");
    await expect(queued).rejects.toMatchObject({
      code: "MUSIC_API_RATE_LIMITED",
      message: "网易云请求等待超时，请稍后重试",
    });
    expect(calls).toBe(1);
    release();
    await expect(active).resolves.toEqual([]);
    expect(calls).toBe(1);
  });
});
