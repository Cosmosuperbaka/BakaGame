import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { NeteaseMusicProvider } from "../../src/infrastructure/NeteaseMusicProvider";

describe("登录状态", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = (async () => {
      throw new Error("测试禁止网络请求");
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("登录状态会读取会员信息，并区分会员与非会员", async () => {
    const createProvider = (vipCode: number, expireTime: number) =>
      new NeteaseMusicProvider({
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

    await expect(
      createProvider(100, Date.now() + 60_000).getLoginStatus("MUSIC_U=test")
    ).resolves.toMatchObject({
      account: { vipStatus: "vip", vipType: 100 },
    });
    await expect(
      createProvider(0, Date.now() - 60_000).getLoginStatus("MUSIC_U=test")
    ).resolves.toMatchObject({
      account: { vipStatus: "nonVip" },
    });
  });

  test("会员展示档位按超级黑胶 > 黑胶 > 音乐包取，到期时间与等级跟着这一档", async () => {
    const future = Date.now() + 86_400_000;
    const later = future + 86_400_000;
    const createProvider = (data: Record<string, unknown>) =>
      new NeteaseMusicProvider({
        randomCNIP: false,
        loadApi: async () => ({
          login_status: async () => ({
            body: { data: { code: 200, profile: { userId: 7, nickname: "档位测试" } } },
          }),
          vip_info_v2: async () => ({ body: { code: 200, data } }),
        }),
      });
    const account = async (data: Record<string, unknown>) =>
      (await createProvider(data).getLoginStatus("MUSIC_U=tier")).account;

    expect(
      await account({
        redVipLevel: 5,
        associator: { vipCode: 100, expireTime: later },
        redplus: { vipCode: 300, expireTime: future },
        musicPackage: { vipCode: 220, expireTime: later },
      })
    ).toMatchObject({ vipStatus: "vip", vipTier: "svip", vipLevel: 5, vipExpireTime: future });
    // 超级黑胶已过期：退到黑胶，等级超出 7 时夹到 7。
    expect(
      await account({
        redVipLevel: 9,
        associator: { vipCode: 100, expireTime: later },
        redplus: { vipCode: 300, expireTime: Date.now() - 1 },
      })
    ).toMatchObject({ vipTier: "vip", vipLevel: 7, vipExpireTime: later });
    const music = await account({
      redVipLevel: 3,
      musicPackage: { vipCode: 220, expireTime: future },
    });
    expect(music).toMatchObject({ vipTier: "musicPackage", vipExpireTime: future });
    expect(music.vipLevel).toBeUndefined();
    const none = await account({ redVipLevel: 0 });
    expect(none.vipStatus).toBe("nonVip");
    expect(none.vipTier).toBeUndefined();
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

    await expect(provider.getLoginStatus("MUSIC_U=expired")).rejects.toMatchObject({
      code: "MUSIC_SESSION_INVALID",
    });
  });
});
