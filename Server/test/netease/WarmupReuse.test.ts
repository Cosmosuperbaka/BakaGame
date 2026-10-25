import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { NeteaseMusicProvider } from "../../src/infrastructure/NeteaseMusicProvider";

const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async () => {
    throw new Error("测试禁止网络请求");
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("网易云上游预热与登录态复用", () => {
  const anonApi = (onRegister?: () => void) => ({
    register_anonimous: async () => {
      onRegister?.();
      return { body: { code: 200, cookie: "MUSIC_A=anonymous" } };
    },
  });

  test("预热只加载一次接口包并只注册一次匿名令牌", async () => {
    let loads = 0,
      registrations = 0;
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      loadApi: async () => {
        loads += 1;
        return anonApi(() => {
          registrations += 1;
        });
      },
    });

    await provider.warmUp();
    await provider.warmUp();

    expect(loads).toBe(1);
    expect(registrations).toBe(1);
  });

  test("预热失败不钉死惰性加载，后续请求仍可重试", async () => {
    let loads = 0;
    const warnings: string[] = [];
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      logger: {
        warn: (message: string) => {
          warnings.push(message);
        },
      } as never,
      loadApi: async () => {
        loads += 1;
        if (loads === 1) throw new Error("接口包加载瞬时失败");
        return anonApi();
      },
    });

    await expect(provider.warmUp()).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);

    // 拒绝的 Promise 若留在字段上，第二次预热仍会拿到同一个失败结果。
    await expect(provider.warmUp()).resolves.toBeUndefined();
    expect(loads).toBe(2);
    expect(warnings).toHaveLength(1);
  });

  test("同一 Cookie 的登录态在复用窗口内只回源一次，且返回值不可污染缓存", async () => {
    let statusCalls = 0;
    const provider = new NeteaseMusicProvider({
      randomCNIP: false,
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        ...anonApi(),
        login_status: async () => {
          statusCalls += 1;
          return { body: { data: { code: 200, profile: { userId: 42, nickname: "复用测试" } } } };
        },
        vip_info_v2: async () => ({
          body: {
            code: 200,
            data: { associator: { vipCode: 100, expireTime: Date.now() + 60_000 } },
          },
        }),
      }),
    });

    const first = await provider.getLoginStatus("MUSIC_U=reuse");
    expect(first.account).toMatchObject({ nickname: "复用测试", vipStatus: "vip" });

    const second = await provider.getLoginStatus("MUSIC_U=reuse");
    expect(second.account).toMatchObject({ nickname: "复用测试", vipStatus: "vip" });
    expect(statusCalls).toBe(1);

    second.account.nickname = "被调用方改写";
    await expect(provider.getLoginStatus("MUSIC_U=reuse")).resolves.toMatchObject({
      account: { nickname: "复用测试" },
    });
    expect(statusCalls).toBe(1);
  });

  test("校验失败不进入复用缓存，凭据恢复后仍重新回源", async () => {
    let statusCalls = 0,
      valid = false;
    const provider = new NeteaseMusicProvider({
      randomCNIP: false,
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        ...anonApi(),
        login_status: async () => {
          statusCalls += 1;
          return valid
            ? { body: { data: { code: 200, profile: { userId: 42, nickname: "恢复登录" } } } }
            : { body: { data: { code: 301, profile: null } } };
        },
        vip_info_v2: async () => ({ body: { code: 200, data: {} } }),
      }),
    });

    await expect(provider.getLoginStatus("MUSIC_U=stale")).rejects.toMatchObject({
      code: "MUSIC_SESSION_INVALID",
    });

    valid = true;
    await expect(provider.getLoginStatus("MUSIC_U=stale")).resolves.toMatchObject({
      account: { nickname: "恢复登录" },
    });
    expect(statusCalls).toBe(2);
  });

  test("传入对象或聚合 Cookie 时不会因 cookie?.trim 崩溃且能正确命中", async () => {
    let passedCookie: any = null;
    const provider = new NeteaseMusicProvider({
      randomCNIP: false,
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        ...anonApi(),
        playlist_detail: async (options: any) => {
          passedCookie = options?.cookie;
          return {
            body: {
              playlist: {
                id: 100,
                name: "聚合测试歌单",
                tracks: [{ id: 1, name: "曲目", ar: [{ name: "歌手" }] }],
              },
            },
          };
        },
      }),
    });

    const res = await (provider as any).getPlaylistSongs("100", {
      netease: "MUSIC_U=obj_test",
      qq: "qq_test",
    });
    expect(res.info.name).toBe("聚合测试歌单");
    expect(passedCookie).toBe("MUSIC_U=obj_test");
  });
});
