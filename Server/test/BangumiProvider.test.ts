import { describe, expect, test } from "bun:test";
import { AppError } from "../src/domain/Errors";
import {
  BangumiProvider,
  extractBangumiMusicTracks,
  rewriteBangumiImageUrl,
} from "../src/infrastructure/BangumiProvider";

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("BangumiProvider", () => {
  test("重写 lain 图床并保留路径查询参数", () => {
    expect(rewriteBangumiImageUrl("https://lain.bgm.tv/pic/cover/l/ab.jpg?x=1#h", "https://img.example/bgm"))
      .toBe("https://img.example/bgm/pic/cover/l/ab.jpg?x=1#h");
    expect(rewriteBangumiImageUrl("https://other.example/a.jpg", "https://img.example/bgm"))
      .toBe("https://other.example/a.jpg");
    expect(rewriteBangumiImageUrl("https://lain.bgm.tv/a.jpg", "")).toBe("https://lain.bgm.tv/a.jpg");
  });

  test("标准化搜索和详情并解析主题曲", async () => {
    const provider = new BangumiProvider({
      apiUrl: "https://api.example",
      imageUrl: "https://img.example",
      fetcher: async (url, init) => {
        if (init?.method === "POST") {
          return response({ data: [{ id: 1, name: "Raw", name_cn: "中文", date: "2024-01-01", images: { medium: "https://lain.bgm.tv/c.jpg" }, rating: { score: 8.2, total: 500 }, tags: [{ name: "动作" }], meta_tags: ["TV"] }] });
        }
        return response({ id: 1, name: "Raw", name_cn: "中文", date: "2024-01-01", images: { medium: "https://lain.bgm.tv/c.jpg" }, rating: { score: 8.2, total: 500 }, infobox: [
          { key: "片头曲", value: [{ k: "歌手", v: "主题曲" }] },
          { key: "片尾曲", value: "片尾歌 - 歌手乙" },
        ] });
      },
    });
    await expect(provider.searchSubjects("raw")).resolves.toMatchObject([
      { id: "1", nameCn: "中文", imageUrl: "https://img.example/c.jpg", year: 2024, rating: 8.2, ratingCount: 500 },
    ]);
    const details = await provider.getSubject("1");
    expect(details.musicTracks).toEqual(expect.arrayContaining([
      { title: "主题曲", artist: "歌手", kind: "opening" },
      { title: "片尾歌", artist: "歌手乙", kind: "ending" },
    ]));
    expect(extractBangumiMusicTracks([])).toEqual([]);
  });

  test("并发请求合并且 429 映射为业务错误", async () => {
    let calls = 0;
    const provider = new BangumiProvider({
      apiUrl: "https://api.example",
      fetcher: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return response({ data: [{ id: 1, name: "番剧" }] });
      },
    });
    await Promise.all([provider.searchSubjects("x"), provider.searchSubjects("x")]);
    expect(calls).toBe(1);

    const limited = new BangumiProvider({ apiUrl: "https://api.example", fetcher: async () => response({}, 429) });
    await expect(limited.searchSubjects("x")).rejects.toMatchObject({ code: "BANGUMI_RATE_LIMITED" } satisfies Partial<AppError>);
  });

  test("有界缓存淘汰旧结果，队列限制并发请求", async () => {
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    const provider = new BangumiProvider({
      apiUrl: "https://api.example",
      cacheMaxEntries: 1,
      maxConcurrentRequests: 1,
      fetcher: async () => {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return response({ data: [{ id: calls, name: "番剧" }] });
      },
    });
    await Promise.all([provider.searchSubjects("甲"), provider.searchSubjects("乙"), provider.searchSubjects("丙")]);
    await provider.searchSubjects("甲");

    expect(maximumActive).toBe(1);
    expect(calls).toBe(4);
  });

  test("触发 429 后拒绝冷却期请求且不再访问上游", async () => {
    let now = 1_000;
    let calls = 0;
    const provider = new BangumiProvider({
      apiUrl: "https://api.example",
      now: () => now,
      fetcher: async () => {
        calls += 1;
        return response({}, 429);
      },
    });
    await expect(provider.searchSubjects("第一次")).rejects.toMatchObject({
      code: "BANGUMI_RATE_LIMITED",
      details: { retryAfterMs: 5_000 },
    } satisfies Partial<AppError>);
    await expect(provider.searchSubjects("第二次")).rejects.toMatchObject({ code: "BANGUMI_RATE_LIMITED" } satisfies Partial<AppError>);
    expect(calls).toBe(1);

    now += 5_000;
    await expect(provider.searchSubjects("冷却后")).rejects.toMatchObject({ code: "BANGUMI_RATE_LIMITED" } satisfies Partial<AppError>);
    expect(calls).toBe(2);
  });
});
