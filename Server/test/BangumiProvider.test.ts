import { describe, expect, test } from "bun:test";
import {
  BangumiProvider,
  extractBangumiMusicTracks,
  rewriteBangumiImageUrl,
} from "../src/infrastructure/BangumiProvider";
import { requestBodyText } from "./RequestFixtures";

const results = () => Response.json({ data: [] });
const tick = () => Bun.sleep(1);

describe("Bangumi 远端截止与排队", () => {
  for (const stage of ["fetch", "body"] as const)
    test(`${stage} 挂起会中止、释放槽位及同键在途，不缓存失败`, async () => {
      let calls = 0;
      const signals: AbortSignal[] = [];
      const provider = new BangumiProvider({
        apiUrl: "https://bangumi.invalid",
        maxConcurrentRequests: 1,
        requestTimeoutMs: 25,
        fetcher: async (_url, init) => {
          signals.push(init!.signal!);
          calls++;
          if (calls > 1) return results();
          if (stage === "fetch") return new Promise<Response>(() => {});
          return new Response(new ReadableStream({ start() {}, cancel() {} }));
        },
      });
      const failure = provider.searchSubjects("first").catch((error) => error);
      await tick();
      expect(signals).toHaveLength(1);
      expect(await failure).toMatchObject({
        code: "BANGUMI_UPSTREAM_ERROR",
        message: "Bangumi 请求超时",
      });
      expect(signals[0].aborted).toBe(true);
      expect(await provider.searchSubjects("second")).toEqual([]);
      expect(await provider.searchSubjects("first")).toEqual([]);
      expect(calls).toBe(3);
      // mock 即使忽略 signal，PQueue 仍释放槽位；原生 fetch 负责取消响应体。
    });

  test("队列中的截止不补发，429 后排队请求取消且冷却后恢复", async () => {
    let release!: (response: Response) => void;
    let calls = 0;
    let now = 0;
    const provider = new BangumiProvider({
      apiUrl: "https://bangumi.invalid",
      maxConcurrentRequests: 1,
      maxQueuedRequests: 1,
      requestTimeoutMs: 100,
      now: () => now,
      rateLimitCooldownMs: 500,
      fetcher: async () => {
        calls++;
        return calls === 1
          ? new Promise<Response>((resolve) => {
              release = resolve;
            })
          : results();
      },
    });
    const first = provider.searchSubjects("first").catch((error) => error);
    const queued = provider.searchSubjects("queued").catch((error) => error);
    await expect(provider.searchSubjects("overflow")).rejects.toMatchObject({
      code: "BANGUMI_RATE_LIMITED",
    });
    release(new Response(null, { status: 429 }));
    expect(await first).toMatchObject({ code: "BANGUMI_RATE_LIMITED" });
    expect(await queued).toMatchObject({ code: "BANGUMI_RATE_LIMITED" });
    expect(calls).toBe(1);
    now = 501;
    expect(await provider.searchSubjects("queued")).toEqual([]);
    expect(calls).toBe(2);
  });

  test("等待与执行共用截止且最终清空队列", async () => {
    let calls = 0;
    const provider = new BangumiProvider({
      apiUrl: "https://bangumi.invalid",
      maxConcurrentRequests: 1,
      requestTimeoutMs: 20,
      fetcher: async () => {
        calls++;
        return new Promise<Response>(() => {});
      },
    });
    const first = provider.searchSubjects("first").catch((error) => error);
    const second = provider.searchSubjects("second").catch((error) => error);
    expect(await first).toMatchObject({ code: "BANGUMI_UPSTREAM_ERROR" });
    expect(await second).toMatchObject({ code: "BANGUMI_UPSTREAM_ERROR" });
    expect(calls).toBeLessThanOrEqual(2);
    expect((provider as unknown as { queue: { size: number; pending: number } }).queue.size).toBe(
      0
    );
  });
});

test("原生队列移除已取消的等待任务，不补发上游", async () => {
  let release!: (response: Response) => void,
    calls = 0;
  const provider = new BangumiProvider({
    apiUrl: "https://bangumi.invalid",
    maxConcurrentRequests: 1,
    fetcher: async () => {
      calls++;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    },
  });
  const first = provider.searchSubjects("active");
  const controller = new AbortController();
  const queued = (
    provider as unknown as { requestJson: (path: string, init: RequestInit) => Promise<unknown> }
  ).requestJson("/queued", { signal: controller.signal });
  const error = new Error("cancel queued");
  controller.abort(error);
  await expect(queued).rejects.toBe(error);
  release(results());
  await first;
  expect(calls).toBe(1);
});

// ==================== 曲目解析（纯函数） ====================

const kindOf = (tracks: Array<{ title: string; kind: string }>, title: string) =>
  tracks.find((track) => track.title === title)?.kind;
const artistOf = (tracks: Array<{ title: string; artist?: string }>, title: string) =>
  tracks.find((track) => track.title === title)?.artist;

describe("曲目解析：infobox 与关联条目两路来源", () => {
  test("顺序前缀逐行分类：OP/ED/IN/TM 与各中文类别标记", () => {
    const lines = [
      "OP1：Title A - Artist A",
      "ED2：Title B",
      "IN3：Title C",
      "TM4：Title D",
      "插入曲1：Title E",
      "片头曲：Title F",
      "片尾曲：Title G",
      "主题歌：Title H",
      "OST：Title I",
      "Remix：Title J",
      "角色歌1：Title K",
      "同人音乐：Title L",
      "印象曲：Title M",
      "Vocaloid：Title N",
      "Drama：Title O",
      "Vocal：Title P",
      "Radio：Title Q",
      "Arrange：Title R",
      "单曲：Title S",
      "精选集：Title T",
      "朗读剧：Title U",
      "艺人专辑：Title V",
      "Soundtrack：Title W",
      "Character Song：Title X",
      "Image Song：Title Y",
    ];
    const tracks = extractBangumiMusicTracks([{ key: "主题歌", value: lines.join("\n") }]);
    expect(kindOf(tracks, "Title A")).toBe("opening");
    expect(kindOf(tracks, "Title B")).toBe("ending");
    expect(kindOf(tracks, "Title C")).toBe("insert");
    expect(kindOf(tracks, "Title D")).toBe("theme");
    expect(kindOf(tracks, "Title E")).toBe("insert");
    expect(kindOf(tracks, "Title F")).toBe("opening");
    expect(kindOf(tracks, "Title G")).toBe("ending");
    expect(kindOf(tracks, "Title H")).toBe("theme");
    expect(kindOf(tracks, "Title I")).toBe("ost");
    expect(kindOf(tracks, "Title J")).toBe("remix");
    expect(kindOf(tracks, "Title K")).toBe("character");
    expect(kindOf(tracks, "Title L")).toBe("doujin");
    expect(kindOf(tracks, "Title M")).toBe("image");
    expect(kindOf(tracks, "Title N")).toBe("vocaloid");
    expect(kindOf(tracks, "Title O")).toBe("drama");
    expect(kindOf(tracks, "Title P")).toBe("vocal");
    expect(kindOf(tracks, "Title Q")).toBe("radio");
    expect(kindOf(tracks, "Title R")).toBe("arrange");
    expect(kindOf(tracks, "Title S")).toBe("single");
    expect(kindOf(tracks, "Title T")).toBe("collection");
    expect(kindOf(tracks, "Title U")).toBe("reading");
    expect(kindOf(tracks, "Title V")).toBe("artistAlbum");
    expect(kindOf(tracks, "Title W")).toBe("ost");
    expect(kindOf(tracks, "Title X")).toBe("character");
    expect(kindOf(tracks, "Title Y")).toBe("image");
    expect(artistOf(tracks, "Title A")).toBe("Artist A");
    expect(artistOf(tracks, "Title B")).toBeUndefined();
  });

  test("版本后缀剥离：括号标注、装饰后缀、裸后缀与 feat. 均生成去版本变体", () => {
    const relations = [
      { type: 3, relation: "插入曲", name: "Song A (Instrumental)" },
      { type: 3, relation: "插入曲", name: "Song B -Live-" },
      { type: 3, relation: "插入曲", name: "Song C TV size" },
      { type: 3, relation: "插入曲", name: "Song D feat. Guest" },
      { type: 3, relation: "插入曲", name: "Song E" },
      { type: 3, relation: "插入曲", name: "Song F / Song G" },
      { type: 3, relation: "插入曲", name: "Song H (Instrumental) -Live-" },
    ];
    const tracks = extractBangumiMusicTracks([], relations);
    expect(kindOf(tracks, "Song A")).toBe("insert");
    expect(kindOf(tracks, "Song B")).toBe("insert");
    expect(kindOf(tracks, "Song C")).toBe("insert");
    expect(kindOf(tracks, "Song D")).toBe("insert");
    // 原始名保留一份，去版本变体额外入池
    expect(kindOf(tracks, "Song A (Instrumental)")).toBe("insert");
    expect(kindOf(tracks, "Song B -Live-")).toBe("insert");
    // 无任何版本标记时不产生重复条目
    expect(tracks.filter((track) => track.title === "Song E")).toHaveLength(1);
    // 斜杠并列曲名逐段展开
    expect(kindOf(tracks, "Song F")).toBe("insert");
    expect(kindOf(tracks, "Song G")).toBe("insert");
    // 括号与装饰后缀连续剥离（while 多轮）
    expect(kindOf(tracks, "Song H")).toBe("insert");
  });

  test("infobox 三种取值形态：字符串、字符串数组与结构体数组", () => {
    const infobox = [
      { key: "主题曲", value: ["Song One - Singer One", "Song Two"] },
      {
        key: "片头曲",
        value: [
          { v: "Head Song", artist: "Singer H" },
          { v: "Tail Song", k: "角色歌" },
          { v: "Skip Me", k: "分镜" },
          { title: "Name Only", name: "Singer X" },
        ],
      },
      { key: "别名", value: "Not A Track" },
    ];
    const tracks = extractBangumiMusicTracks(infobox);
    expect(kindOf(tracks, "Song One")).toBe("theme");
    expect(artistOf(tracks, "Song One")).toBe("Singer One");
    expect(kindOf(tracks, "Song Two")).toBe("theme");
    expect(kindOf(tracks, "Head Song")).toBe("opening");
    expect(artistOf(tracks, "Head Song")).toBe("Singer H");
    expect(kindOf(tracks, "Tail Song")).toBe("character");
    expect(tracks.some((track) => track.title === "Skip Me")).toBe(false);
    expect(artistOf(tracks, "Name Only")).toBe("Singer X");
    expect(tracks.some((track) => track.title === "Not A Track")).toBe(false);
  });

  test("关联条目：引号副标题拆艺人、『其他』细化、署名剔除与重复剔除", () => {
    const relations = [
      { type: 3, relation: "片头曲", name: "「紅蓮華」LiSA" },
      { type: 3, relation: "其他", name: "Original Soundtrack" },
      { type: 3, relation: "其他", name: "Remix ver." },
      { type: 2, relation: "片尾曲", name: "Wrong Type" },
      { type: 3, relation: "片尾曲", name: "©Project" },
      { type: 3, relation: "片尾曲", name: "「Only Title」" },
    ];
    const tracks = extractBangumiMusicTracks([], relations, ["Solo Artist"]);
    expect(kindOf(tracks, "紅蓮華")).toBe("opening");
    expect(artistOf(tracks, "紅蓮華")).toBe("LiSA");
    expect(artistOf(tracks, "「紅蓮華」LiSA")).toBe("LiSA");
    expect(kindOf(tracks, "Original Soundtrack")).toBe("ost");
    expect(kindOf(tracks, "Remix ver.")).toBe("remix");
    expect(kindOf(tracks, "Remix")).toBe("remix");
    expect(tracks.some((track) => track.title === "Wrong Type")).toBe(false);
    expect(tracks.some((track) => track.title.includes("©"))).toBe(false);
    // 唯一演出者作为兜底艺人
    expect(artistOf(tracks, "Only Title")).toBe("Solo Artist");
  });

  test("版权署名条目与完全重复曲目一律不进池", () => {
    const tracks = extractBangumiMusicTracks(
      [{ key: "主题曲", value: "©Studio Track" }],
      [
        { type: 3, relation: "片头曲", name: "Same Song" },
        { type: 3, relation: "片头曲", name: "Same Song" },
      ]
    );
    expect(tracks.some((track) => track.title.includes("©"))).toBe(false);
    expect(tracks.filter((track) => track.title === "Same Song")).toHaveLength(1);
  });
});

describe("rewriteBangumiImageUrl", () => {
  test("无镜像前缀原样透传，标准封面形状映射到图床档位", () => {
    expect(rewriteBangumiImageUrl(undefined)).toBeUndefined();
    expect(rewriteBangumiImageUrl("https://lain.bgm.tv/pic/cover/l/aa/bb/1_x.jpg")).toBe(
      "https://lain.bgm.tv/pic/cover/l/aa/bb/1_x.jpg"
    );
    expect(
      rewriteBangumiImageUrl("https://lain.bgm.tv/pic/cover/l/aa/bb/1_x.jpg", "https://img.example")
    ).toBe("https://img.example/r/200/pic/cover/l/aa/bb/1_x.jpg");
  });
});

// ==================== 远端接口（注入 fetcher） ====================

const jsonResponse = (body: unknown) => Response.json(body);

describe("BangumiProvider 远端接口", () => {
  test("searchSubjects：构造规范载荷、过滤坏条目并重写镜像地址", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = new BangumiProvider({
      apiUrl: "https://api.invalid/",
      imageUrl: "https://img.example/",
      fetcher: async (input, init) => {
        calls.push({ url: String(input), init });
        return jsonResponse({
          data: [
            {
              id: 1,
              name: "Test",
              name_cn: "测试",
              date: "2020-04-05",
              images: { large: "https://lain.bgm.tv/pic/cover/l/aa/bb/1_x.jpg" },
              rating: { score: 7.5, total: 100 },
              tags: [{ name: "动作" }, "日常"],
              meta_tags: ["原创"],
            },
            { id: 2, name: "NoExtra" },
            { name: "NoId" },
          ],
        });
      },
    });
    const rows = await provider.searchSubjects(" 测试 ", 5, { startYear: 2010, endYear: 2020 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.invalid/v0/search/subjects?limit=5");
    expect(JSON.parse(requestBodyText(calls[0].init))).toEqual({
      keyword: "测试",
      sort: "heat",
      filter: { type: [2], air_date: [">=2010-01-01", "<2021-01-01"] },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: "1",
      name: "Test",
      nameCn: "测试",
      imageUrl: "https://img.example/r/200/pic/cover/l/aa/bb/1_x.jpg",
      year: 2020,
      rating: 7.5,
      ratingCount: 100,
      tags: ["动作", "日常"],
      metaTags: ["原创"],
    });
    expect(rows[1].id).toBe("2");
    expect(rows[1].nameCn).toBe("NoExtra");
    expect(rows[1].imageUrl).toBeUndefined();
    expect(rows[1].year).toBeUndefined();
    expect(rows[1].rating).toBeUndefined();
    expect(rows[1].tags).toEqual([]);
    // 同参数命中进程内缓存：不再回源
    await provider.searchSubjects(" 测试 ", 5, { startYear: 2010, endYear: 2020 });
    expect(calls).toHaveLength(1);
  });

  test("getSubject：聚合副请求曲目、容忍副请求失败与空 id 拒绝", async () => {
    const fetcher = async (input: string) => {
      const url = String(input);
      if (url.endsWith("/8/subjects")) {
        return jsonResponse([
          { type: 3, relation: "片头曲", name: "「壱雫空」MyGO!!!!!" },
          { type: 3, relation: "其他", name: "Original Soundtrack" },
        ]);
      }
      if (url.endsWith("/9/subjects")) throw new Error("relations down");
      if (url.endsWith("/v0/subjects/9")) {
        return jsonResponse({
          id: 9,
          name: "Nine",
          infobox: [{ key: "插入曲", value: "Nine Song - Niner" }],
        });
      }
      return jsonResponse({
        id: 8,
        name: "ItsMyGO",
        name_cn: "迷途之子",
        date: "2023-06-29",
        locked: true,
        summary: "乐队故事",
        images: { large: "https://lain.bgm.tv/pic/cover/l/cc/dd/8.jpg" },
        infobox: [
          { key: "主题歌 / 演出", value: "MyGO!!!!!" },
          { key: "插入曲", value: "焚音 - MyGO!!!!!" },
        ],
      });
    };
    const provider = new BangumiProvider({
      apiUrl: "https://api.invalid",
      imageUrl: "https://img.example",
      fetcher,
    });
    const detail = await provider.getSubject("8");
    expect(detail.name).toBe("ItsMyGO");
    expect(detail.nameCn).toBe("迷途之子");
    expect(detail.summary).toBe("乐队故事");
    expect(detail.locked).toBe(true);
    expect(detail.year).toBe(2023);
    expect(detail.imageUrl).toBe("https://img.example/r/200/pic/cover/l/cc/dd/8.jpg");
    const tracks = detail.musicTracks ?? [];
    expect(tracks.some((track) => track.title === "壱雫空" && track.kind === "opening")).toBe(true);
    expect(
      tracks.some((track) => track.title === "Original Soundtrack" && track.kind === "ost")
    ).toBe(true);
    expect(
      tracks.some(
        (track) => track.title === "焚音" && track.artist === "MyGO!!!!!" && track.kind === "insert"
      )
    ).toBe(true);

    // 副请求（关联条目）失败：主体照常返回，只是没有关联曲目
    const nine = await provider.getSubject("9");
    expect(nine.name).toBe("Nine");
    expect(
      (nine.musicTracks ?? []).some(
        (track) => track.title === "Nine Song" && track.artist === "Niner"
      )
    ).toBe(true);

    await expect(provider.getSubject("   ")).rejects.toMatchObject({
      code: "BANGUMI_SUBJECT_NOT_FOUND",
    });
  });

  test("chooseRandomSubject：按随机索引取详情，空候选报错", async () => {
    const provider = new BangumiProvider({
      apiUrl: "https://api.invalid",
      fetcher: async (input) => {
        const url = String(input);
        if (url.includes("/v0/search/subjects")) {
          return jsonResponse({
            data: [
              { id: 1, name: "One" },
              { id: 2, name: "Two" },
            ],
          });
        }
        if (url.endsWith("/2/subjects")) return jsonResponse([]);
        if (url.endsWith("/v0/subjects/2")) return jsonResponse({ id: 2, name: "Two" });
        return jsonResponse({ id: 1, name: "One" });
      },
    });
    const picked = await provider.chooseRandomSubject({}, () => 0.99);
    expect(picked.id).toBe("2");
    expect(picked.name).toBe("Two");

    const empty = new BangumiProvider({
      apiUrl: "https://api.invalid",
      fetcher: async () => jsonResponse({ data: [] }),
    });
    await expect(empty.chooseRandomSubject()).rejects.toMatchObject({ code: "BANGUMI_NO_SUBJECT" });
  });

  test("resolveCharacterImage：成功结果才进缓存，失败与非法 id 不回源", async () => {
    let calls = 0;
    let mode: "ok" | "fail" | "empty" = "fail";
    const provider = new BangumiProvider({
      apiUrl: "https://api.invalid",
      imageUrl: "https://img.example",
      fetcher: async () => {
        calls++;
        if (mode === "fail") throw new Error("upstream down");
        if (mode === "empty") return jsonResponse({ images: {} });
        return jsonResponse({
          images: { large: "https://lain.bgm.tv/pic/crt/l/aa/bb/12393_crt_x.jpg" },
        });
      },
    });
    expect(await provider.resolveCharacterImage(0)).toBeUndefined();
    expect(await provider.resolveCharacterImage(-1)).toBeUndefined();
    expect(await provider.resolveCharacterImage(1.5)).toBeUndefined();
    expect(calls).toBe(0);
    // 失败 / 空结果都不写成功缓存，下次仍会重试回源
    expect(await provider.resolveCharacterImage(12393)).toBeUndefined();
    mode = "empty";
    expect(await provider.resolveCharacterImage(12393)).toBeUndefined();
    mode = "ok";
    expect(await provider.resolveCharacterImage(12393)).toBe(
      "https://img.example/r/400/pic/crt/l/aa/bb/12393_crt_x.jpg"
    );
    expect(calls).toBe(3);
    // 成功结果进内存缓存：不再回源
    expect(await provider.resolveCharacterImage(12393)).toBe(
      "https://img.example/r/400/pic/crt/l/aa/bb/12393_crt_x.jpg"
    );
    expect(calls).toBe(3);
  });

  test("resolveSubjectImage：合法 id 回源重写，失败与非法输入回退 undefined", async () => {
    let calls = 0;
    let fail = false;
    const provider = new BangumiProvider({
      apiUrl: "https://api.invalid",
      imageUrl: "https://img.example",
      fetcher: async () => {
        calls++;
        if (fail) throw new Error("down");
        return jsonResponse({
          images: { large: "https://lain.bgm.tv/pic/cover/l/aa/bb/12_x.jpg" },
        });
      },
    });
    expect(await provider.resolveSubjectImage("12")).toBe(
      "https://img.example/r/200/pic/cover/l/aa/bb/12_x.jpg"
    );
    expect(await provider.resolveSubjectImage("abc")).toBeUndefined();
    expect(await provider.resolveSubjectImage("0")).toBeUndefined();
    expect(calls).toBe(1);
    fail = true;
    expect(await provider.resolveSubjectImage("13")).toBeUndefined();
    expect(calls).toBe(2);
  });
});
