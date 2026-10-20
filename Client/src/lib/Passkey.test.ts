import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthRequestError } from "./Api";

// 端点调用与系统弹窗各换一个桩：这里只验「先取选项、再让浏览器做 ceremony、最后回传响应」的编排。
const authGet = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const authPost = vi.hoisted(() =>
  vi.fn<(path: string, body: Record<string, unknown>) => Promise<unknown>>()
);

vi.mock("./Api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./Api")>()),
  authGet,
  authPost,
}));

const browserSupportsWebAuthn = vi.hoisted(() => vi.fn<() => boolean>());
const startAuthentication = vi.hoisted(() =>
  vi.fn<(input: { optionsJSON: unknown }) => Promise<unknown>>()
);
const startRegistration = vi.hoisted(() =>
  vi.fn<(input: { optionsJSON: unknown }) => Promise<unknown>>()
);

vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
}));

import {
  PASSKEY_NAME_MAX,
  addPasskey,
  autoPasskeyName,
  describeDevice,
  listPasskeys,
  passkeyErrorMessage,
  passkeyRegistrationErrorMessage,
  passkeySupported,
  platformAuthenticatorAvailable,
  removePasskey,
  renamePasskey,
  signInWithPasskey,
} from "./Passkey";

/** 自动取名要读 `navigator`，测试里换成固定线索，结果不受运行环境默认的 UA 影响。 */
const stubNavigator = (userAgent: string, userAgentData?: unknown) =>
  vi.stubGlobal("navigator", { userAgent, userAgentData });

afterEach(() => vi.unstubAllGlobals());

const UA = {
  windowsChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  windowsFirefox:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  wechatIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50 NetType/WIFI Language/zh_CN",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
};

describe("通行密钥客户端", () => {
  it("能力探测直接读 WebAuthn 是否可用", () => {
    browserSupportsWebAuthn.mockReturnValue(true);
    expect(passkeySupported()).toBe(true);
    browserSupportsWebAuthn.mockReturnValue(false);
    expect(passkeySupported()).toBe(false);
  });

  it("设备名优先读品牌清单，去掉内核名与占位", () => {
    expect(
      describeDevice({
        platform: "Windows",
        brands: [{ brand: "Not:A-Brand" }, { brand: "Chromium" }, { brand: "Google Chrome" }],
      })
    ).toBe("Windows · Chrome");
    expect(
      describeDevice({
        platform: "macOS",
        brands: [{ brand: "Chromium" }, { brand: "Microsoft Edge" }],
      })
    ).toBe("macOS · Microsoft Edge");
  });

  it("没有品牌清单时退回 UA 字符串认出系统与浏览器", () => {
    expect(describeDevice({ userAgent: UA.windowsChrome })).toBe("Windows · Chrome");
    expect(describeDevice({ userAgent: UA.windowsFirefox })).toBe("Windows · Firefox");
    expect(describeDevice({ userAgent: UA.iphoneSafari })).toBe("iOS · Safari");
    expect(describeDevice({ userAgent: UA.macSafari })).toBe("macOS · Safari");
    expect(describeDevice({ userAgent: UA.wechatIphone })).toBe("iOS · 微信");
  });

  it("认不出的线索给空串，由调用方兜底而不是编一个「未知设备」", () => {
    expect(describeDevice({})).toBe("");
    expect(describeDevice({ userAgent: "SomeBot/1.0" })).toBe("");
  });

  it("登录：取认证选项交给浏览器，再把响应回传给校验端点", async () => {
    const optionsJSON = { challenge: "c1", rpId: "game.example.com" };
    authGet.mockResolvedValue(optionsJSON);
    startAuthentication.mockResolvedValue("assertion");

    await signInWithPasskey();

    expect(authGet).toHaveBeenCalledWith("/passkey/generate-authenticate-options");
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON });
    expect(authPost).toHaveBeenCalledWith("/passkey/verify-authentication", {
      response: "assertion",
    });
  });

  it("添加：注册响应里的保管方拼进自动名，一并落库", async () => {
    stubNavigator(UA.windowsChrome, {
      platform: "Windows",
      brands: [{ brand: "Chromium" }, { brand: "Google Chrome" }],
    });
    const optionsJSON = { challenge: "c2", rp: { id: "game.example.com" } };
    authGet.mockResolvedValue(optionsJSON);

    startRegistration.mockResolvedValue({ id: "cred-1", authenticatorAttachment: "platform" });
    await addPasskey();
    expect(authPost).toHaveBeenCalledWith("/passkey/verify-registration", {
      response: { id: "cred-1", authenticatorAttachment: "platform" },
      name: "Windows · Chrome（本机解锁）",
    });

    startRegistration.mockResolvedValue({
      id: "cred-2",
      authenticatorAttachment: "cross-platform",
    });
    await addPasskey();
    expect(authPost).toHaveBeenLastCalledWith("/passkey/verify-registration", {
      response: { id: "cred-2", authenticatorAttachment: "cross-platform" },
      name: "Windows · Chrome（跨设备密钥）",
    });
  });

  it("自动名把保管方写进名字：本机解锁与跨设备密钥可区分", () => {
    stubNavigator(UA.windowsChrome, {
      platform: "Windows",
      brands: [{ brand: "Chromium" }, { brand: "Google Chrome" }],
    });

    expect(autoPasskeyName("platform")).toBe("Windows · Chrome（本机解锁）");
    expect(autoPasskeyName("cross-platform")).toBe("Windows · Chrome（跨设备密钥）");
    expect(autoPasskeyName()).toBe("Windows · Chrome");
  });

  it("认不出设备时也给出可读的名字，不留空名", async () => {
    stubNavigator("SomeBot/1.0");
    authGet.mockResolvedValue({ challenge: "c3" });
    startRegistration.mockResolvedValue({ id: "cred-3" });

    await addPasskey();

    expect(authPost).toHaveBeenCalledWith("/passkey/verify-registration", {
      response: { id: "cred-3" },
      name: "本设备",
    });
  });

  it("两路注册各自限定验证器类型，保留服务端的其余选择", async () => {
    stubNavigator(UA.windowsChrome, {
      platform: "Windows",
      brands: [{ brand: "Chromium" }, { brand: "Google Chrome" }],
    });
    const optionsJSON = {
      challenge: "c4",
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    };
    authGet.mockResolvedValue(optionsJSON);

    startRegistration.mockResolvedValue({ id: "cred-p", authenticatorAttachment: "platform" });
    await addPasskey("platform");
    expect(startRegistration).toHaveBeenLastCalledWith({
      optionsJSON: {
        challenge: "c4",
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "preferred",
          authenticatorAttachment: "platform",
        },
      },
    });
    expect(authPost).toHaveBeenLastCalledWith("/passkey/verify-registration", {
      response: { id: "cred-p", authenticatorAttachment: "platform" },
      name: "Windows · Chrome（本机解锁）",
    });

    startRegistration.mockResolvedValue({
      id: "cred-x",
      authenticatorAttachment: "cross-platform",
    });
    await addPasskey("cross-platform");
    expect(startRegistration).toHaveBeenLastCalledWith({
      optionsJSON: {
        challenge: "c4",
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "preferred",
          authenticatorAttachment: "cross-platform",
        },
      },
    });
    expect(authPost).toHaveBeenLastCalledWith("/passkey/verify-registration", {
      response: { id: "cred-x", authenticatorAttachment: "cross-platform" },
      name: "Windows · Chrome（跨设备密钥）",
    });
    // 服务端下发的选项只被克隆，不在原对象上追加类型。
    expect(optionsJSON.authenticatorSelection).toEqual({
      residentKey: "required",
      userVerification: "preferred",
    });
  });

  it("回执不报保管方时，名字退回玩家选的那一类", async () => {
    stubNavigator(UA.windowsChrome, { platform: "Windows" });
    authGet.mockResolvedValue({ challenge: "c5" });
    startRegistration.mockResolvedValue({ id: "cred-5" });

    await addPasskey("cross-platform");

    expect(authPost).toHaveBeenLastCalledWith("/passkey/verify-registration", {
      response: { id: "cred-5" },
      name: "Windows · Chrome（跨设备密钥）",
    });
  });

  it("系统验证器探测：不支持或异常时返回 undefined，交给调用方决定", async () => {
    browserSupportsWebAuthn.mockReturnValue(false);
    await expect(platformAuthenticatorAvailable()).resolves.toBeUndefined();

    browserSupportsWebAuthn.mockReturnValue(true);
    vi.stubGlobal("PublicKeyCredential", {
      isUserVerifyingPlatformAuthenticatorAvailable: vi.fn().mockResolvedValue(false),
    });
    await expect(platformAuthenticatorAvailable()).resolves.toBe(false);

    vi.stubGlobal("PublicKeyCredential", {
      isUserVerifyingPlatformAuthenticatorAvailable: vi.fn().mockRejectedValue(new Error("x")),
    });
    await expect(platformAuthenticatorAvailable()).resolves.toBeUndefined();
  });

  it("改名只提交去掉首尾与超长部分后的名字", async () => {
    authPost.mockResolvedValue(undefined);

    await renamePasskey("pk-1", `  ${"密".repeat(PASSKEY_NAME_MAX + 10)}  `);

    expect(authPost).toHaveBeenCalledWith("/passkey/update-passkey", {
      id: "pk-1",
      name: "密".repeat(PASSKEY_NAME_MAX),
    });
  });

  it("列表与移除只走服务端开放的端点", async () => {
    authGet.mockResolvedValue([]);
    await expect(listPasskeys()).resolves.toEqual([]);
    expect(authGet).toHaveBeenCalledWith("/passkey/list-user-passkeys");

    authPost.mockResolvedValue(undefined);
    await removePasskey("pk-1");
    expect(authPost).toHaveBeenCalledWith("/passkey/delete-passkey", { id: "pk-1" });
  });

  it("浏览器取消记作用户意愿，不报成密钥坏了", () => {
    expect(passkeyErrorMessage(new DOMException("x", "AbortError"), "兜底")).toBe(
      "已取消通行密钥验证"
    );
    expect(passkeyErrorMessage(new DOMException("x", "NotAllowedError"), "兜底")).toBe(
      "已取消通行密钥验证，或本设备没有可用的通行密钥"
    );
    expect(passkeyErrorMessage(new DOMException("x", "SecurityError"), "兜底")).toBe(
      "当前页面域名与通行密钥域名不一致，请用网页版或更新后的客户端再试"
    );
  });

  it("注册失败按已知线索拆开：域名未关联 / 无系统验证器 / 取消或不可用", () => {
    const security = new DOMException("x", "SecurityError");
    const notAllowed = new DOMException("x", "NotAllowedError");
    expect(passkeyRegistrationErrorMessage(security, "platform", true, "兜底")).toBe(
      "当前页面域名与通行密钥域名不一致，请用网页版或更新后的客户端再试"
    );
    expect(passkeyRegistrationErrorMessage(notAllowed, "platform", false, "兜底")).toBe(
      "本设备没有可用的系统验证器，请改用「密码管理器或安全密钥」"
    );
    expect(passkeyRegistrationErrorMessage(notAllowed, "cross-platform", undefined, "兜底")).toBe(
      "已取消通行密钥验证，或所选验证器不可用"
    );
    expect(
      passkeyRegistrationErrorMessage(new DOMException("x", "AbortError"), "platform", true, "兜底")
    ).toBe("已取消通行密钥验证");
  });

  it("服务端中文原因原样透出，其余错误只给兜底文案", () => {
    expect(
      passkeyErrorMessage(
        new AuthRequestError("SESSION_NOT_FRESH", "这次登录已超过一天", 403),
        "兜底"
      )
    ).toBe("这次登录已超过一天");
    expect(passkeyErrorMessage(new Error("boom"), "通行密钥添加失败，请稍后重试")).toBe(
      "通行密钥添加失败，请稍后重试"
    );
  });
});
