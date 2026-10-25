import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { NeteaseMusicProvider, parseLrc } from "../../src/infrastructure/NeteaseMusicProvider";
import {
  isCreditLyricLine,
  isInstrumentalLyricLine,
  isUnusableLyricLine,
  sanitizeLyrics,
} from "../../src/infrastructure/LyricLines";

describe("网易云检索与歌单", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = (async () => {
      throw new Error("测试禁止网络请求");
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("filters instrumental placeholders without removing ordinary lyrics", () => {
    expect(isInstrumentalLyricLine("Music")).toBe(true);
    expect(isInstrumentalLyricLine("[Music]")).toBe(true);
    expect(isInstrumentalLyricLine("Music - Instrumental")).toBe(true);
    expect(isInstrumentalLyricLine("instrumental2")).toBe(true);
    expect(isInstrumentalLyricLine("we still hear music tonight")).toBe(false);

    const lyrics = parseLrc(
      [
        "[00:01.00]Music",
        "[00:02.00][Music]",
        "[00:03.00]Music - Instrumental",
        "[00:04.00]verse one",
        "[00:05.00]verse two",
      ].join("\n")
    );
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
              {
                id: 1,
                name: "高热度",
                ar: [{ id: 7, name: "歌手甲" }],
                al: { name: "专辑" },
                pop: 100_000,
              },
              {
                id: 2,
                name: "普通",
                ar: [{ id: 7, name: "歌手甲" }],
                al: { name: "专辑" },
                pop: 999,
              },
            ],
          },
        }),
        cloudsearch: async ({ type }: { type: number }) => ({
          body: { result: type === 100 ? { artists: [{ id: 7, name: "歌手甲" }] } : { songs: [] } },
        }),
        artist_songs: async () => ({
          body: {
            songs: [
              {
                id: 1,
                name: "高热度",
                ar: [{ id: 7, name: "歌手甲" }],
                al: { name: "专辑" },
                pop: 100_000,
              },
            ],
          },
        }),
        song_red_count: async () => ({
          body: { code: 200, data: { count: 123_456, countDesc: "100w+" } },
        }),
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

  test("专辑检索取回专辑，曲目必须从顶层 songs 读取", async () => {
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({
        cloudsearch: async ({ type }: { type: number }) => ({
          body: {
            result:
              type === 10
                ? {
                    albums: [
                      {
                        id: 55_900,
                        name: "風がそよぐ場所",
                        artist: { id: 1, name: "小松未歩" },
                        size: 2,
                      },
                    ],
                  }
                : { songs: [] },
          },
        }),
        // 真实响应形态：曲目在**顶层** `songs`，而 `album.songs` 是同名 / 单曲专辑上的
        // **空数组**。实现若写成 `album.songs ?? body.songs`，`??` 不会回退，专辑路径会
        // 静默拿到空列表（实测事故：`getAlbumSongs` 对《風がそよぐ場所》返回 0 条，
        // 而顶层其实有 2 条）。这条用例钉死读取顺序。
        album: async () => ({
          body: {
            songs: [
              {
                id: 591_324,
                name: "風がそよぐ場所",
                ar: [{ name: "小松未歩" }],
                al: { name: "風がそよぐ場所" },
                dt: 261_960,
              },
              {
                id: 591_325,
                name: "elephant",
                ar: [{ name: "小松未歩" }],
                al: { name: "風がそよぐ場所" },
                dt: 240_000,
              },
            ],
            album: { id: 55_900, name: "風がそよぐ場所", songs: [] },
          },
        }),
      }),
    });

    await expect(provider.searchAlbums("風がそよぐ場所")).resolves.toEqual([
      expect.objectContaining({
        id: "55900",
        name: "風がそよぐ場所",
        artist: "小松未歩",
        songCount: 2,
      }),
    ]);
    await expect(provider.getAlbumSongs("55900")).resolves.toEqual([
      expect.objectContaining({ id: "591324", title: "風がそよぐ場所", artist: "小松未歩" }),
      expect.objectContaining({ id: "591325", title: "elephant" }),
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
              songs: [
                {
                  id: 77,
                  name: "纯音乐",
                  ar: [{ name: "演奏者" }],
                  al: { name: "器乐专辑", publishTime: Date.UTC(2024, 0, 1) },
                  pop: 66,
                  dt: 120_000,
                },
              ],
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
            songs: [
              {
                id: 78,
                name: "纯音乐题",
                ar: [{ name: "演奏者" }],
                al: { name: "器乐专辑" },
                dt: 120_000,
              },
            ],
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

  test("歌单超过单页上限时继续翻页取完并去重", async () => {
    const total = 1201;
    const all = Array.from({ length: total }, (_, index) => ({
      id: index + 1,
      name: `曲目${index + 1}`,
      ar: [{ id: 7, name: "歌手甲" }],
      al: { name: "专辑" },
    }));
    const offsets: number[] = [];
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({
        playlist_track_all: async (params: Record<string, unknown>) => {
          const offset = Number(params.offset ?? 0);
          const limit = Number(params.limit ?? 1000);
          offsets.push(offset);
          return { body: { songs: all.slice(offset, offset + limit) } };
        },
        // playlist_track_all 不返回歌单名与曲目总数，需要详情补上。
        playlist_detail: async () => ({
          body: { playlist: { id: 42, name: "超长歌单", trackCount: total } },
        }),
      }),
    });

    const result = await provider.getPlaylistSongs("42");
    expect(result.info).toEqual({ id: "42", name: "超长歌单", songCount: total });
    expect(result.songs).toHaveLength(total);
    expect(result.songs.at(-1)?.id).toBe(String(total));
    expect(new Set(result.songs.map((song) => song.id)).size).toBe(total);
    // 第二页取完即停，不会为空页再发一次请求
    expect(offsets).toEqual([0, 1000]);
  });

  test("歌单接口不支持翻页时不会重复取整页", async () => {
    let calls = 0;
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({
        // 只提供 playlist_detail：它忽略 offset，每页都返回同一份 tracks
        playlist_detail: async () => {
          calls += 1;
          return {
            body: {
              playlist: {
                id: 42,
                name: "两首",
                tracks: [
                  { id: 1, name: "曲目一", ar: [{ name: "歌手甲" }] },
                  { id: 2, name: "曲目二", ar: [{ name: "歌手甲" }] },
                ],
              },
            },
          };
        },
      }),
    });

    const result = await provider.getPlaylistSongs("42");
    expect(result.songs.map((song) => song.id)).toEqual(["1", "2"]);
    expect(result.info).toEqual({ id: "42", name: "两首", songCount: 2 });
    // 响应不带 trackCount 时只能靠「本页没有新增曲目」终止翻页；请求数必须仍然有界
    expect(calls).toBeLessThan(10);
  });

  test("歌单翻页中途失败时保留已取到的曲目", async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({
      id: index + 1,
      name: `曲目${index + 1}`,
      ar: [{ name: "歌手甲" }],
    }));
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({
        playlist_track_all: async (params: Record<string, unknown>) => {
          if (Number(params.offset ?? 0) > 0) throw new Error("上游翻页失败");
          return { body: { songs: firstPage } };
        },
        playlist_detail: async () => ({
          body: { playlist: { id: 42, name: "半途", trackCount: 1201 } },
        }),
      }),
    });

    const result = await provider.getPlaylistSongs("42");
    expect(result.info.songCount).toBe(1201);
    expect(result.songs).toHaveLength(1000);
  });

  test("角色正文分类优先于结构署名，重复副歌时间轴保留", () => {
    const body = [
      "【男】山河辽阔",
      "【女】灯火阑珊",
      "合：星河灿烂",
      "solo：满天星辰",
      "rap：灯火阑珊",
      "男：让我用心把你留下来",
      "rap：看我的风景",
    ];
    for (const text of body) {
      expect(isCreditLyricLine(text)).toBe(false);
      expect(isUnusableLyricLine(text)).toBe(false);
    }
    for (const text of [
      "男：",
      "【男】",
      "作词：张三",
      "Guitar Solo：John Smith",
      "版权所有：唱片公司",
      "采样率：44100Hz",
    ])
      expect(isUnusableLyricLine(text)).toBe(true);
    const lines = [...body, body[0]].map((text, index) => ({
      time: index * 1000,
      endTime: (index + 1) * 1000,
      text,
    }));
    expect(
      sanitizeLyrics(lines, { title: "答案", artist: "歌手" }).map((line) => line.text)
    ).toEqual([...body, body[0]]);
  });
});
