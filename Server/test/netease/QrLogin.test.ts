import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { NeteaseMusicProvider } from "../../src/infrastructure/NeteaseMusicProvider";

describe("扫码登录", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = (async () => {
      throw new Error("测试禁止网络请求");
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("扫码登录只把最终 Cookie 返回给调用者并可读取账号状态", async () => {
    const calls: string[] = [];
    const provider = new NeteaseMusicProvider({
      randomCNIP: false,
      loadApi: async () => ({
        login_qr_key: async (params: Record<string, unknown>) => {
          calls.push("login_qr_key");
          expect(params.cookie).toEqual({
            os: "pc",
            appver: "3.1.29.205117",
            osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
            channel: "netease",
            mobilename: "BakaGame",
            model: "BakaGame",
          });
          expect(String(params.ua)).toContain("NeteaseMusicDesktop");
          return { body: { data: { code: 200, unikey: "qr-key" } } };
        },
        login_qr_create: async (params: Record<string, unknown>) => {
          calls.push("login_qr_create");
          expect(params).toMatchObject({
            key: "qr-key",
            qrimg: true,
            platform: "BakaGame",
            randomCNIP: false,
            cookie: {
              os: "pc",
              appver: "3.1.29.205117",
              osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
              channel: "netease",
              mobilename: "BakaGame",
              model: "BakaGame",
            },
          });
          expect(String(params.ua)).toContain("NeteaseMusicDesktop");
          return {
            body: {
              code: 200,
              data: {
                qrurl: "https://music.163.com/login?codekey=qr-key",
                qrimg: "data:image/png;base64,qr",
              },
            },
          };
        },
        login_qr_check: async (params: Record<string, unknown>) => {
          calls.push("login_qr_check");
          expect(params.cookie).toEqual({
            os: "pc",
            appver: "3.1.29.205117",
            osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
            channel: "netease",
            mobilename: "BakaGame",
            model: "BakaGame",
          });
          expect(String(params.ua)).toContain("NeteaseMusicDesktop");
          return { body: { code: 803, message: "授权登录成功", cookie: "MUSIC_U=qr-cookie" } };
        },
        deviceinfo_center_upload: async (params: Record<string, unknown>) => {
          calls.push("deviceinfo_center_upload");
          expect(params.deviceName).toBe("BakaGame");
          expect(String(params.cookie)).toContain("MUSIC_U=qr-cookie");
          expect(String(params.cookie)).toContain("os=pc");
          return { body: { code: 200, data: {} } };
        },
        login_status: async (params: Record<string, unknown>) => {
          calls.push("login_status");
          expect(params.cookie).toBe("MUSIC_U=qr-cookie");
          // 该用例显式关闭 randomCNIP，此时不应携带 realIP；开启时的行为由会话 IP 用例覆盖。
          expect(params.randomCNIP).toBe(false);
          return {
            body: {
              data: {
                code: 200,
                profile: { userId: 42, nickname: "扫码用户", avatarUrl: "https://img/avatar.jpg" },
              },
            },
          };
        },
      }),
    });

    await expect(provider.createQrLogin()).resolves.toMatchObject({
      key: "qr-key",
      qrImage: "data:image/png;base64,qr",
    });
    await expect(provider.checkQrLogin("qr-key")).resolves.toMatchObject({
      status: "authorized",
      message: "授权登录成功",
      session: {
        cookie: "MUSIC_U=qr-cookie",
        account: {
          userId: "42",
          nickname: "扫码用户",
          avatarUrl: "https://img/avatar.jpg",
        },
      },
    });
    expect(calls).toEqual([
      "login_qr_key",
      "login_qr_create",
      "login_qr_check",
      "deviceinfo_center_upload",
      "login_status",
    ]);
  });

  test("扫码登录全链路共用同一 CN 出口 IP 且登录后凭证继续复用", async () => {
    const requests: Array<{ endpoint: string; cookie: unknown; realIP: unknown }> = [];
    const record = (endpoint: string, params: Record<string, unknown>) => {
      requests.push({ endpoint, cookie: params.cookie, realIP: params.realIP });
    };
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        login_qr_key: async (params: Record<string, unknown>) => {
          record("login_qr_key", params);
          return { body: { data: { code: 200, unikey: "session-key" } } };
        },
        login_qr_create: async (params: Record<string, unknown>) => {
          record("login_qr_create", params);
          return {
            body: {
              code: 200,
              data: {
                qrurl: "https://music.163.com/login?codekey=session-key",
                qrimg: "data:image/png;base64,qr",
              },
            },
          };
        },
        login_qr_check: async (params: Record<string, unknown>) => {
          record("login_qr_check", params);
          return { body: { code: 803, message: "授权登录成功", cookie: "MUSIC_U=session-cookie" } };
        },
        deviceinfo_center_upload: async (params: Record<string, unknown>) => {
          record("deviceinfo_center_upload", params);
          return { body: { code: 200, data: {} } };
        },
        login_status: async (params: Record<string, unknown>) => {
          record("login_status", params);
          return {
            body: { data: { code: 200, profile: { userId: 42, nickname: "会话用户" } } },
          };
        },
        cloudsearch: async (params: Record<string, unknown>) => {
          record("cloudsearch", params);
          return { body: { result: { songs: [] } } };
        },
      }),
    });

    await provider.createQrLogin();
    await provider.checkQrLogin("session-key");
    // 登录后使用同一凭证的普通请求
    await provider.search("登录后请求", 20, "MUSIC_U=session-cookie");

    const loginChain = requests.filter((entry) => entry.endpoint !== "cloudsearch");
    const ips = new Set(loginChain.map((entry) => String(entry.realIP)));
    // 二维码创建、轮询、设备上报、状态校验必须共用同一个出口 IP：
    // 历史实现里 login_status 显式关闭 realIP，导致登录态一建立就与登录 IP 脱钩而失效。
    expect(ips.size).toBe(1);
    expect(loginChain.every((entry) => entry.realIP !== undefined)).toBe(true);

    const postLogin = requests.find((entry) => entry.endpoint === "cloudsearch");
    expect(String(postLogin?.realIP)).toBe([...ips][0]);
  });

  test("不同登录凭证使用互不相同的稳定 IP", async () => {
    const byCookie = new Map<string, string[]>();
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        cloudsearch: async (params: Record<string, unknown>) => {
          const cookie = String(params.cookie);
          const bucket = byCookie.get(cookie) ?? [];
          bucket.push(String(params.realIP));
          byCookie.set(cookie, bucket);
          return { body: { result: { songs: [] } } };
        },
      }),
    });

    await provider.search("甲一", 20, "MUSIC_U=alpha");
    await provider.search("甲二", 20, "MUSIC_U=alpha");
    await provider.search("乙一", 20, "MUSIC_U=beta");

    const alpha = byCookie.get("MUSIC_U=alpha") ?? [];
    const beta = byCookie.get("MUSIC_U=beta") ?? [];
    expect(alpha).toHaveLength(2);
    expect(alpha[0]).toBe(alpha[1]);
    expect(beta).toHaveLength(1);
    expect(alpha[0]).not.toBe(beta[0]);
  });

  test("支持自定义登录设备名称并在扫码登录成功时自动上报", async () => {
    let uploadedDeviceName: string | undefined;
    let capturedCreate: Record<string, unknown> | undefined;
    const provider = new NeteaseMusicProvider({
      deviceName: "CustomMusicBox",
      loadApi: async () => ({
        login_qr_key: async (params: Record<string, unknown>) => {
          expect(params.cookie).toEqual({
            os: "pc",
            appver: "3.1.29.205117",
            osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
            channel: "netease",
            mobilename: "CustomMusicBox",
            model: "CustomMusicBox",
          });
          return { body: { data: { code: 200, unikey: "custom-key" } } };
        },
        login_qr_create: async (params: Record<string, unknown>) => {
          capturedCreate = params;
          return {
            body: {
              code: 200,
              data: {
                qrurl: "https://music.163.com/login?codekey=custom-key",
                qrimg: "data:image/png;base64,custom",
              },
            },
          };
        },
        login_qr_check: async () => ({
          body: { code: 803, message: "授权成功", cookie: "MUSIC_U=custom-cookie" },
        }),
        deviceinfo_center_upload: async (params: Record<string, unknown>) => {
          uploadedDeviceName = String(params.deviceName);
          return { body: { code: 200, data: {} } };
        },
        login_status: async () => ({
          body: {
            data: {
              code: 200,
              profile: { userId: 99, nickname: "自定义设备用户" },
            },
          },
        }),
      }),
    });

    await provider.createQrLogin();
    expect(capturedCreate?.platform).toBe("CustomMusicBox");
    expect(capturedCreate?.cookie).toEqual({
      os: "pc",
      appver: "3.1.29.205117",
      osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
      channel: "netease",
      mobilename: "CustomMusicBox",
      model: "CustomMusicBox",
    });

    await provider.checkQrLogin("custom-key");
    expect(uploadedDeviceName).toBe("CustomMusicBox");
  });

  test("uploadDeviceInfo 在接口异常时记录告警且不中断流程", async () => {
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({
        deviceinfo_center_upload: async () => {
          throw new Error("网络超时或被风控");
        },
      }),
    });

    const success = await provider.uploadDeviceInfo("MUSIC_U=fake-cookie");
    expect(success).toBe(false);

    // 空 Cookie 场景直接返回 false
    await expect(provider.uploadDeviceInfo("   ")).resolves.toBe(false);
  });

  test("uploadDeviceInfo 只走原生 deviceinfo_center_upload 模块", async () => {
    const calls: string[] = [];
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({
        deviceinfo_center_upload: async (params: Record<string, unknown>) => {
          calls.push("deviceinfo_center_upload");
          expect(params.deviceName).toBe("BakaGame");
          return { body: { code: 200, data: {} } };
        },
      }),
    });

    await expect(provider.uploadDeviceInfo("MUSIC_U=only-native")).resolves.toBe(true);
    expect(calls).toEqual(["deviceinfo_center_upload"]);
  });

  test("接口包缺少 deviceinfo_center_upload 时静默降级，不回退包内 util 自拼请求", async () => {
    // 回归护栏：旧实现会在模块缺失时直接 import 包的 `util/request` + `util/option` 自拼 EAPI，
    // 属于「直接导入传递依赖」。移除该回退后再遇到缺模块必须干净返回 false。
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({}),
    });

    await expect(provider.uploadDeviceInfo("MUSIC_U=no-native-module")).resolves.toBe(false);
  });

  test("扫码接口被网易云风控拦截时不向客户端暴露提醒链接", async () => {
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({
        login_qr_key: async () => ({
          body: {
            code: 8810,
            message: "您当前的网络环境存在安全风险",
            redirectUrl: "https://y.music.163.com/g/yida/private-risk-url",
          },
        }),
      }),
    });

    const error = (await provider
      .createQrLogin()
      .catch((value) => value as Error & { code?: string; details?: unknown })) as Error & {
      code?: string;
      details?: unknown;
    };
    expect(error).toMatchObject({ code: "MUSIC_LOGIN_RISK" });
    expect(error.message).not.toContain("private-risk-url");
    expect(JSON.stringify(error)).not.toContain("private-risk-url");
  });

  test("匿名令牌只用于后端请求参数，不会作为登录结果返回", async () => {
    const observed: Record<string, unknown>[] = [];
    let registerParams: Record<string, unknown> | undefined;
    const provider = new NeteaseMusicProvider({
      loadApi: async () => ({
        register_anonimous: async (params: Record<string, unknown>) => {
          registerParams = params;
          return { cookie: ["MUSIC_A=anonymous-only"] };
        },
        cloudsearch: async (params: Record<string, unknown>) => {
          observed.push(params);
          return { body: { result: { songs: [] } } };
        },
      }),
    });

    await expect(provider.search("test")).resolves.toEqual([]);
    expect(registerParams?.cookie).toEqual({});
    expect(observed[0]?.cookie).toBe("MUSIC_A=anonymous-only");
  });

  /**
   * 扫码登录会话必须按「二维码 unikey」分桶。
   *
   * 曾经会话 scope 是 provider 级单值：两个房间的房主在相近时间扫码时，后发起者覆盖前者，
   * 于是先完成的那位被绑上别人的会话 IP（永久错绑）、后完成的那位压根没绑上登录握手时的 IP。
   * 更糟的是旧实现让 IP 选取无条件优先这个全局字段，任意一个用户处于扫码等待期，
   * 全进程所有房间的请求都会被带上该会话的 IP。
   */
  test("并发扫码登录各自绑定自己的会话 IP，不会互相串号", async () => {
    const calls: Array<{ endpoint: string; key?: string; realIP?: unknown; cookie?: unknown }> = [];
    let keySeq = 0;
    const provider = new NeteaseMusicProvider({
      minRequestIntervalMs: 0,
      loadApi: async () => ({
        login_qr_key: async (params: Record<string, unknown>) => {
          keySeq += 1;
          calls.push({ endpoint: "key", realIP: params.realIP });
          return { body: { code: 200, data: { unikey: `key-${keySeq}` } } };
        },
        login_qr_create: async (params: Record<string, unknown>) => {
          calls.push({ endpoint: "create", key: String(params.key), realIP: params.realIP });
          return {
            body: {
              code: 200,
              data: { qrurl: "https://qr.example", qrimg: "data:image/png;base64,x" },
            },
          };
        },
        login_qr_check: async (params: Record<string, unknown>) => {
          calls.push({ endpoint: "check", key: String(params.key), realIP: params.realIP });
          return {
            body: { code: 803, message: "授权登录成功" },
            // 真实上游把 cookie 放在响应顶层的数组里
            cookie: [`MUSIC_U=session-${params.key}`],
          };
        },
        login_status: async (params: Record<string, unknown>) => {
          calls.push({ endpoint: "status", realIP: params.realIP });
          return {
            body: {
              code: 200,
              data: { code: 200, profile: { userId: 10001, nickname: "测试用户" } },
            },
          };
        },
        deviceinfo_center_upload: async () => ({ body: { code: 200 } }),
        cloudsearch: async (params: Record<string, unknown>) => {
          calls.push({ endpoint: "search", realIP: params.realIP, cookie: params.cookie });
          return { body: { result: { songs: [] } } };
        },
      }),
    });

    const qrA = await provider.createQrLogin();
    // 后发起者：旧实现在这一步就把 A 的会话 scope 覆盖掉
    const qrB = await provider.createQrLogin();
    const resultA = await provider.checkQrLogin(qrA.key);
    const resultB = await provider.checkQrLogin(qrB.key);

    expect(resultA.status).toBe("authorized");
    expect(resultB.status).toBe("authorized");

    const ipOf = (endpoint: string, key?: string) =>
      calls
        .filter((call) => call.endpoint === endpoint && (key === undefined || call.key === key))
        .map((call) => call.realIP);

    const ipA = ipOf("check", qrA.key)[0];
    const ipB = ipOf("check", qrB.key)[0];

    // 同一轮扫码：建码与轮询必须是同一个出口 IP
    expect(ipOf("create", qrA.key)[0]).toBe(ipA);
    expect(ipOf("create", qrB.key)[0]).toBe(ipB);
    // 两轮会话互不串号
    expect(ipA).not.toBe(ipB);

    // 登录完成后用各自凭证发起普通请求，应继续复用自己登录时的那个 IP
    await provider.search("歌曲甲", 20, `MUSIC_U=session-${qrA.key}`);
    await provider.search("歌曲乙", 20, `MUSIC_U=session-${qrB.key}`);
    const searches = calls.filter((call) => call.endpoint === "search");
    expect(searches[0]?.realIP).toBe(ipA);
    expect(searches[1]?.realIP).toBe(ipB);
  });
});
