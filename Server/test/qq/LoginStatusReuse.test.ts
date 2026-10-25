import { describe, expect, it, mock, afterEach } from "bun:test";
import { QQMusicProvider } from "../../src/infrastructure/QQMusicProvider";
import qqmusic from "qqmusic-api-enhanced";

const originals = {
  login_status: qqmusic.login_status,
  login_refresh: qqmusic.login_refresh,
};
const restore = () => Object.assign(qqmusic, originals);
afterEach(restore);

describe("QQ音乐登录态复用（对齐网易云口径）", () => {
  it("同一 Cookie 的登录态在复用窗口内只回源一次，且返回值不可污染缓存", async () => {
    let statusCalls = 0;
    const provider = new QQMusicProvider();
    qqmusic.login_status = mock(async () => {
      statusCalls += 1;
      return {
        status: 200,
        body: {
          isLogin: true,
          account: { userId: "7", nickname: "复用测试", vipLevel: 5 },
        },
      };
    }) as any;

    const first = await provider.getLoginStatus("qm_keyst=reuse");
    expect(first.account).toMatchObject({ nickname: "复用测试", vipLevel: 5 });

    const second = await provider.getLoginStatus("qm_keyst=reuse");
    expect(statusCalls).toBe(1);

    second.account.nickname = "被调用方改写";
    await expect(provider.getLoginStatus("qm_keyst=reuse")).resolves.toMatchObject({
      account: { nickname: "复用测试" },
    });
    expect(statusCalls).toBe(1);
  });

  it("聚合形态凭据只取 QQ 一侧并按该凭据复用", async () => {
    let seen: unknown;
    let statusCalls = 0;
    const provider = new QQMusicProvider();
    qqmusic.login_status = mock(async ({ cookie }: { cookie?: unknown }) => {
      statusCalls += 1;
      seen = cookie;
      return {
        status: 200,
        body: { isLogin: true, account: { userId: "9", nickname: "组合" } },
      };
    }) as any;

    await expect(
      provider.getLoginStatus({ qq: "qm_keyst=combo", netease: "MUSIC_U=x" })
    ).resolves.toMatchObject({ account: { nickname: "组合" } });
    await provider.getLoginStatus({ qq: "qm_keyst=combo", netease: "MUSIC_U=x" });
    expect(seen).toBe("qm_keyst=combo");
    expect(statusCalls).toBe(1);
  });

  it("轮换后的新 Cookie 也写入复用缓存，用新 Cookie 查询不再回源", async () => {
    let statusCalls = 0;
    const provider = new QQMusicProvider();
    qqmusic.login_status = mock(async () => {
      statusCalls += 1;
      return {
        status: 200,
        body: {
          isLogin: true,
          cookieStr: "qm_keyst=fresh",
          account: { userId: "9", nickname: "已登录" },
        },
      };
    }) as any;

    const session = await provider.getLoginStatus("qm_keyst=old");
    expect(session.cookie).toBe("qm_keyst=fresh");
    // 状态接口轮换出的新 Cookie 已写入缓存：直接命中，不重新回源。
    const again = await provider.getLoginStatus("qm_keyst=fresh");
    expect(again.cookie).toBe("qm_keyst=fresh");
    expect(statusCalls).toBe(1);
  });
});
