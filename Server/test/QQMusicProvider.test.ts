import { describe, expect, it, mock, afterEach } from "bun:test";
import { QQMusicProvider, stripHtmlTags } from "../src/infrastructure/QQMusicProvider";
import qqmusic from "qqmusic-api-enhanced";

const originalSearch = qqmusic.search;
const originalLoginStatus = qqmusic.login_status;

afterEach(() => {
  qqmusic.search = originalSearch;
  qqmusic.login_status = originalLoginStatus;
});

describe("QQMusicProvider", () => {
  describe("stripHtmlTags", () => {
    it("正确剥离各类 HTML 高亮与富文本标签", () => {
      expect(stripHtmlTags("<em>晴天</em>")).toBe("晴天");
      expect(stripHtmlTags("<em>晴天</em> (深情版)")).toBe("晴天 (深情版)");
      expect(stripHtmlTags("周涛美<em>杰伦</em>")).toBe("周涛美杰伦");
      expect(stripHtmlTags("<span class=\"highlight\">晴天</span>")).toBe("晴天");
      expect(stripHtmlTags("普通歌曲名")).toBe("普通歌曲名");
      expect(stripHtmlTags(undefined)).toBe("");
      expect(stripHtmlTags(null)).toBe("");
    });
  });

  describe("search 结果标签净化", () => {
    it("剥离搜索结果中的 <em> 标签并保留版本副标题", async () => {
      const provider = new QQMusicProvider();
      const mockSearch = mock(async () => ({
        status: 200,
        body: {
          songs: [
            {
              mid: "001",
              title: "<em>晴天</em> (Live)",
              name: "晴天",
              singer: [{ name: "<em>周杰伦</em>" }],
              albumname: "<em>十一月的萧邦</em>",
            },
          ],
        },
      }));
      qqmusic.search = mockSearch as any;

      const results = await provider.search("晴天", 5);
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("晴天 (Live)");
      expect(results[0].artist).toBe("周杰伦");
      expect(results[0].album).toBe("十一月的萧邦");
    });
  });

  describe("getLoginStatus 内存缓存", () => {
    it("在 TTL 内复用有效登录状态，0ms 瞬间响应且不重复触发公网 RPC", async () => {
      const provider = new QQMusicProvider();
      let callCount = 0;
      qqmusic.login_status = mock(async () => {
        callCount++;
        return {
          status: 200,
          body: {
            code: 200,
            isLogin: true,
            account: {
              userId: "12345678",
              nickname: "淋雨之前",
              avatarUrl: "https://example.com/avatar.jpg",
              vipStatus: "vip",
              vipTier: "vip",
              vipLevel: 6,
              vipYear: true,
              vipExpireTime: 1800000000000,
            },
          },
        } as any;
      });

      const session1 = await provider.getLoginStatus("qm_keyst=mock_token_123");
      expect(session1.account.nickname).toBe("淋雨之前");
      expect(session1.account.vipLevel).toBe(6);
      expect(callCount).toBe(1);

      // 第二次请求同一 Cookie 应命中 LRU 缓存，callCount 不再递增
      const session2 = await provider.getLoginStatus("qm_keyst=mock_token_123");
      expect(session2.account.nickname).toBe("淋雨之前");
      expect(session2.account.vipLevel).toBe(6);
      expect(callCount).toBe(1);

      // 支持对象格式 { qq: cookie } 命中相同缓存
      const session3 = await provider.getLoginStatus({ qq: "qm_keyst=mock_token_123" });
      expect(session3.account.nickname).toBe("淋雨之前");
      expect(callCount).toBe(1);
    });

    it("空 Cookie 抛出异常且不写缓存", async () => {
      const provider = new QQMusicProvider();
      await expect(provider.getLoginStatus("")).rejects.toThrow();
      await expect(provider.getLoginStatus({ qq: "" })).rejects.toThrow();
    });
  });
});
