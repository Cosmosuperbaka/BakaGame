import { describe, expect, it } from "bun:test";
import { QQMusicProvider } from "../../src/infrastructure/QQMusicProvider";
import { amllResponse, amllTtmlFixture } from "./Fixtures";

describe("QQ音乐 AMLL 委托共享客户端", () => {
  it("按 qqMusicId 取正文；瞬态失败当次降级、恢复后同键回源", async () => {
    let calls = 0;
    const urls: string[] = [];
    const provider = new QQMusicProvider({
      amllRequestTimeoutMs: 20,
      amllFetcher: async (url: string) => {
        urls.push(url);
        if (url.includes("qqMusicId=")) {
          calls += 1;
          return calls > 1 ? amllResponse() : new Response(null, { status: 503 });
        }
        return amllResponse();
      },
    });

    expect(await provider.getAmllTtmlLyrics("qq:m1")).toBeUndefined();
    expect(urls[0]).toContain("get?qqMusicId=m1");
    expect(await provider.getAmllTtmlLyrics("qq:m1")).toBe(amllTtmlFixture());
    expect(calls).toBe(2);
  });

  it("确定缺失（404）照旧缓存，同键并发合并为一次请求", async () => {
    let calls = 0;
    const provider = new QQMusicProvider({
      amllFetcher: async () => {
        calls += 1;
        return new Response(null, { status: 404 });
      },
    });

    expect(
      await Promise.all(Array.from({ length: 10 }, () => provider.getAmllTtmlLyrics("qq:gone")))
    ).toEqual(Array(10).fill(undefined));
    expect(await provider.getAmllTtmlLyrics("qq:gone")).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("按歌名检索走 search 端点并在无结果时缓存空", async () => {
    const urls: string[] = [];
    let calls = 0;
    const provider = new QQMusicProvider({
      amllFetcher: async (url: string) => {
        urls.push(url);
        calls += 1;
        return Response.json({ status: 200, data: { items: [] } });
      },
    });

    expect(await provider.searchAmllTtmlLyrics("missing", "歌手")).toBeUndefined();
    expect(await provider.searchAmllTtmlLyrics("missing", "歌手")).toBeUndefined();
    expect(calls).toBe(1);
    expect(urls[0]).toContain("search?q=missing%20%E6%AD%8C%E6%89%8B&pageSize=5");
  });
});
