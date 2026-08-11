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
    await expect(provider.checkQrLogin("qr-key")).resolves.toEqual({
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

  test("手机与邮箱登录不会持久化凭据且仅返回登录 Cookie", async () => {
    const provider = new NeteaseMusicProvider({
      randomCNIP: false,
      loadApi: async () => ({
        captcha_sent: async (params: Record<string, unknown>) => {
          expect(params).toMatchObject({ phone: "13800000000", ctcode: "86", randomCNIP: false });
          return { body: { code: 200 } };
        },
        login_cellphone: async (params: Record<string, unknown>) => {
          expect(params).toMatchObject({
            phone: "13800000000",
            countrycode: "86",
            captcha: "123456",
            randomCNIP: false,
          });
          return {
            body: {
              code: 200,
              cookie: "MUSIC_U=phone-cookie",
              profile: { userId: 1, nickname: "手机用户" },
            },
          };
        },
        login: async (params: Record<string, unknown>) => {
          expect(params).toMatchObject({
            email: "user@example.com",
            password: "secret password",
            randomCNIP: false,
          });
          return {
            body: {
              code: 200,
              cookie: "MUSIC_U=email-cookie",
              profile: { userId: 2, nickname: "邮箱用户" },
            },
          };
        },
      }),
    });

    await expect(provider.sendPhoneCaptcha("13800000000", "86")).resolves.toBeUndefined();
    await expect(provider.loginWithPhone({
      phone: "13800000000",
      countryCode: "86",
      captcha: "123456",
    })).resolves.toMatchObject({ cookie: "MUSIC_U=phone-cookie", account: { nickname: "手机用户" } });
    await expect(provider.loginWithEmail("user@example.com", "secret password")).resolves.toMatchObject({
      cookie: "MUSIC_U=email-cookie",
      account: { nickname: "邮箱用户" },
    });
  });

  test("登录请求显式传递随机中国 IP 并且不向客户端返回拦截提醒链接", async () => {
    let loginParams: Record<string, unknown> | undefined;
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({
        login_cellphone: async (params: Record<string, unknown>) => {
          loginParams = params;
          return {
            body: {
              code: 8810,
              message: "当前登录存在安全风险，请稍后再试",
              redirectUrl: "https://y.music.163.com/g/yida/example",
            },
          };
        },
      }),
    });

    const result = provider.loginWithPhone({ phone: "13800000000", password: "secret" });
    await expect(result).rejects.toMatchObject({
      code: "MUSIC_LOGIN_RISK",
      details: {
        upstreamCode: 8810,
      },
    });
    expect(loginParams?.randomCNIP).toBe(true);
    expect(loginParams?.realIP).toMatch(/^116\.(2[5-9]|[3-8]\d|9[0-4])\.\d{1,3}\.\d{1,3}$/);
    expect(loginParams?.cookie).toEqual({});
    expect(loginParams?.password).toBe("secret");
  });

  test("旧版验证码接口返回错误时会回退到 v1 接口", async () => {
    const calls: string[] = [];
    const provider = new NeteaseMusicProvider({
      randomCNIP: false,
      loadApi: async () => ({
        captcha_sent: async () => {
          calls.push("captcha_sent");
          return { body: { code: 400, message: "旧接口不可用" } };
        },
        captcha_sent_v1: async (params: Record<string, unknown>) => {
          calls.push("captcha_sent_v1");
          expect(params.cookie).toEqual({});
          return { body: { code: 200 } };
        },
      }),
    });

    await expect(provider.sendPhoneCaptcha("13800000000", "86")).resolves.toBeUndefined();
    expect(calls).toEqual(["captcha_sent", "captcha_sent_v1"]);
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
});
