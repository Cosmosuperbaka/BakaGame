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

  test("搜索请求携带年份范围过滤", async () => {
    let requestBody: unknown;
    const provider = new BangumiProvider({
      apiUrl: "https://api.example",
      fetcher: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body));
        return response({ data: [] });
      },
    });

    await provider.searchSubjects("", 20, { startYear: 2016, endYear: 2026 });

    expect(requestBody).toEqual({
      keyword: "",
      sort: "heat",
      filter: {
        type: [2],
        air_date: [">=2016-01-01", "<2027-01-01"],
      },
    });
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

  test("解析 OST、Remix、角色曲、插曲、同人音乐等具体曲目类型", () => {
    const infobox = [
      {
        key: "主题歌",
        value: "OP1: 炎 - LiSA\nED1: from the edge\nOST: Main Theme - 泽野弘之\nRemix: Gurenge (Remix)\n角色歌: 灶门炭治郎之歌 - 花江夏树\nIN: 战斗曲\n同人音乐: 东方同人曲\n印象曲: 黎明之歌",
      },
      {
        key: "原声带",
        value: [{ k: "OST", v: "Original Sound Track Vol.1" }],
      },
      {
        key: "角色曲",
        value: "Hero Song - 声优",
      },
    ];

    const tracks = extractBangumiMusicTracks(infobox);
    expect(tracks).toEqual(expect.arrayContaining([
      { title: "炎", artist: "LiSA", kind: "opening" },
      { title: "from the edge", artist: undefined, kind: "ending" },
      { title: "Main Theme", artist: "泽野弘之", kind: "ost" },
      { title: "Gurenge (Remix)", artist: undefined, kind: "remix" },
      { title: "灶门炭治郎之歌", artist: "花江夏树", kind: "character" },
      { title: "战斗曲", artist: undefined, kind: "insert" },
      { title: "东方同人曲", artist: undefined, kind: "doujin" },
      { title: "黎明之歌", artist: undefined, kind: "image" },
      { title: "Original Sound Track Vol.1", artist: undefined, kind: "ost" },
      { title: "Hero Song", artist: "声优", kind: "character" },
    ]));
  });

  test("严格排除 Staff、分镜、演出与主要角色等非曲目字段", () => {
    const infobox = [
      { key: "OP・ED 分镜", value: "石原立也 / 山田尚子" },
      { key: "OP・ED 演出", value: "石原立也 / 山田尚子" },
      { key: "OP・ED 动画制作", value: "京都アニメーション" },
      { key: "主题歌作词", value: "Ayase" },
      { key: "主题歌作曲", value: "Ayase" },
      { key: "主题歌编曲", value: "Ayase" },
      { key: "角色设定", value: "堀口悠紀子" },
      { key: "主要角色", value: "平沢唯、秋山澪" },
      { key: "音响监督", value: "鶴岡陽太" },
      { key: "音乐制作", value: "ポニーキャニオン" },
    ];

    const tracks = extractBangumiMusicTracks(infobox);
    expect(tracks).toEqual([]);
  });

  test("解析关联音乐条目并支持单曲拆分与歌手关联", async () => {
    const provider = new BangumiProvider({
      apiUrl: "https://api.example",
      fetcher: async (url) => {
        if (url.endsWith("/subjects/101/subjects")) {
          return response([
            { id: 1001, type: 3, relation: "片头曲", name: "メグメル／だんご大家族" },
            { id: 1002, type: 3, relation: "片尾曲", name: "Don’t say “lazy”" },
            { id: 1003, type: 3, relation: "插入歌", name: "ふわふわ時間" },
            { id: 1004, type: 3, relation: "角色歌", name: "TVアニメ「日常」キャラクターソング 「なののネジ回りラプソディ」／東雲なの" },
            { id: 1005, type: 1, relation: "书籍", name: "漫画原作" }, // 非音乐类型
          ]);
        }
        return response({
          id: 101,
          name: "Test Anime",
          name_cn: "测试番剧",
          infobox: [
            { key: "OP・ED 分镜", value: "监督甲" },
            { key: "主题歌演出", value: "YOASOBI（OP1）" },
          ],
        });
      },
    });

    const subject = await provider.getSubject("101");
    // 不包含 staff
    expect(subject.musicTracks.find((t) => t.title === "监督甲")).toBeUndefined();
    // 包含关联音乐并拆分
    expect(subject.musicTracks).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "メグメル", kind: "opening" }),
      expect.objectContaining({ title: "だんご大家族", kind: "opening" }),
      expect.objectContaining({ title: "Don’t say “lazy”", kind: "ending" }),
      expect.objectContaining({ title: "ふわふわ時間", kind: "insert" }),
      expect.objectContaining({ title: "なののネジ回りラプソディ", artist: "東雲なの", kind: "character" }),
    ]));
    // OP 和 ED 排在 character 之前
    const opIndex = subject.musicTracks.findIndex((t) => t.kind === "opening");
    const charIndex = subject.musicTracks.findIndex((t) => t.kind === "character");
    expect(opIndex).toBeLessThan(charIndex);
  });
});

