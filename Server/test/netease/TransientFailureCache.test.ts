import { describe, expect, test } from "bun:test";
import { NeteaseMusicProvider } from "../../src/infrastructure/music/NeteaseMusicProvider";

const songDetail = async () => ({
  body: {
    songs: [
      {
        id: 42,
        name: "答案歌",
        ar: [{ name: "歌手甲" }],
        al: { name: "专辑甲" },
        dt: 180_000,
      },
    ],
  },
});

const createProvider = (api: Record<string, unknown>) =>
  new NeteaseMusicProvider({
    minRequestIntervalMs: 0,
    loadApi: async () => api,
  });

describe("网易云可选数据：瞬态失败不得被当成「上游没有」缓存", () => {
  test("热度首次请求失败后，下一次必须回源并取到数值", async () => {
    let calls = 0;
    const provider = createProvider({
      song_red_count: async () => {
        calls += 1;
        if (calls === 1) throw new Error("upstream 500");
        return { body: { data: { count: 7 } } };
      },
    });

    await expect(provider.getSongPopularity("42")).rejects.toBeDefined();
    await expect(provider.getSongPopularity("42")).resolves.toBe(7);
    expect(calls).toBe(2);
  });

  test("副歌首次请求失败后，下一次必须回源并取到区间", async () => {
    let calls = 0;
    const provider = createProvider({
      song_chorus: async () => {
        calls += 1;
        if (calls === 1) throw new Error("upstream 500");
        return { body: { data: [{ startTime: 1_000, endTime: 9_000 }] } };
      },
    });

    await expect(provider.getSongChorus("42")).rejects.toBeDefined();
    await expect(provider.getSongChorus("42")).resolves.toEqual({
      startTime: 1_000,
      endTime: 9_000,
    });
    expect(calls).toBe(2);
  });

  test("上游明确没有数据（空结果）仍按 TTL 缓存，不重复回源", async () => {
    let calls = 0;
    const provider = createProvider({
      song_red_count: async () => {
        calls += 1;
        return { body: { data: {} } };
      },
    });

    await expect(provider.getSongPopularity("42")).resolves.toBeUndefined();
    await expect(provider.getSongPopularity("42")).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  test("接口包缺少该端点属于「确实没有」，同样缓存", async () => {
    const provider = createProvider({});
    await expect(provider.getSongPopularity("42")).resolves.toBeUndefined();
    await expect(provider.getSongChorus("42")).resolves.toBeUndefined();
  });

  test("百科请求失败时元数据照常返回，但不缓存残缺结果，下次补回百科", async () => {
    let wikiCalls = 0;
    const provider = createProvider({
      song_detail: songDetail,
      song_wiki_summary: async () => {
        wikiCalls += 1;
        if (wikiCalls === 1) throw new Error("upstream 500");
        return { body: { data: { blocks: [{ title: "曲风", content: "流行、摇滚" }] } } };
      },
      song_wiki_home: async () => {
        throw new Error("upstream 500");
      },
    });

    const first = await provider.getSongMetadata("42");
    expect(first.encyclopedia.tags).toEqual([]);

    const second = await provider.getSongMetadata("42");
    expect(second.encyclopedia.tags).toEqual(["流行", "摇滚"]);
    expect(wikiCalls).toBe(2);
  });

  test("热度失败时元数据同样不缓存残缺结果", async () => {
    let redCalls = 0;
    const provider = createProvider({
      song_detail: songDetail,
      song_red_count: async () => {
        redCalls += 1;
        if (redCalls === 1) throw new Error("upstream 500");
        return { body: { data: { count: 9 } } };
      },
    });

    expect((await provider.getSongMetadata("42")).popularity).toBeUndefined();
    expect((await provider.getSongMetadata("42")).popularity).toBe(9);
  });

  test("歌单详情补充请求失败时只做短缓存，让下一轮有机会补全", async () => {
    let detailCalls = 0;
    let now = 1_000_000;
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      now: () => now,
      loadApi: async () => ({
        playlist_track_all: async () => ({
          body: {
            songs: [{ id: 1, name: "甲", ar: [{ name: "歌手甲" }], al: { name: "专辑" } }],
          },
        }),
        playlist_detail: async () => {
          detailCalls += 1;
          if (detailCalls === 1) throw new Error("upstream 500");
          return { body: { playlist: { name: "题库", trackCount: 1 } } };
        },
      }),
    });

    expect((await provider.getPlaylistSongs("9")).info.name).toBe("歌单 9");
    // 短缓存期内仍是降级结果；硬过期后才重新回源补全。
    now += 181_000;
    expect((await provider.getPlaylistSongs("9")).info.name).toBe("题库");
    expect(detailCalls).toBe(2);
  });
});
