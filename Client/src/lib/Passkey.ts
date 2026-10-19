import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

import { AuthRequestError, authGet, authPost } from "./Api";

/**
 * 通行密钥（WebAuthn）的浏览器侧流程。
 *
 * 四个步骤都直连 Better Auth，不经 oRPC：挑战值存在签名 Cookie 与 `verification` 行里，
 * 换一层转发就丢 Cookie，验证必然卡在 `CHALLENGE_NOT_FOUND`。
 * 密钥由系统（iCloud 钥匙串 / Google 密码管理器 / 安全密钥）保管，站点拿不到任何可导出的私钥材料。
 */

/** 库里的一把密钥：`createdAt` 是服务端序列化的 ISO 时刻。 */
export interface PasskeyEntry {
  id: string;
  name: string | null;
  createdAt: string;
}

/** 输入框与请求里统一的密钥名上限：库列是 255 字符，列表一行也放不下更长的那串。 */
export const PASSKEY_NAME_MAX = 40;

/** 交给 `describeDevice` 的浏览器线索；做成参数是为了能在测试里喂假 UA。 */
export interface DeviceHints {
  platform?: string;
  brands?: readonly { brand: string }[];
  userAgent?: string;
}

/** UA-Client-Hints 的品牌清单里，内核名与「Not:A-Brand」这类占位都不是浏览器的名字。 */
const isMeaningfulBrand = (brand: string): boolean =>
  brand !== "Chromium" && !brand.startsWith("Not");

// 顺序即优先级：Android 的 UA 里也带 Linux，iOS 的也带 Mac OS。
const PLATFORM_BY_UA: readonly (readonly [RegExp, string])[] = [
  [/Windows NT/, "Windows"],
  [/(iPhone|iPad|iPod)/, "iOS"],
  [/Android/, "Android"],
  [/Mac OS X/, "macOS"],
  [/CrOS/, "ChromeOS"],
  [/Linux/, "Linux"],
];

// 顺序即优先级：Edge / Opera 的 UA 里也带 Chrome，微信、Safari 与所有 Chromium 内核都带 Safari 字样，
// 所以 Safari 只能垫在最后，靠前面的规则先把它挡掉。
const BROWSER_BY_UA: readonly (readonly [RegExp, string])[] = [
  [/Edg\//, "Edge"],
  [/OPR\//, "Opera"],
  [/Firefox\//, "Firefox"],
  [/MicroMessenger/, "微信"],
  [/Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];

/**
 * 设备名：优先读 UA-Client-Hints（只有 Chromium 系给得出品牌清单），认不出再退到 UA 字符串。
 * 两段都认不出就是空串，由调用方兜底，不编一个「未知设备」占位。
 */
export const describeDevice = (hints: DeviceHints): string => {
  const ua = hints.userAgent ?? "";
  const platform =
    hints.platform ?? PLATFORM_BY_UA.find(([pattern]) => pattern.test(ua))?.[1] ?? "";
  const brand =
    hints.brands
      ?.filter((item) => isMeaningfulBrand(item.brand))
      .at(-1)
      ?.brand.replace(/^Google /, "") ??
    BROWSER_BY_UA.find(([pattern]) => pattern.test(ua))?.[1] ??
    "";
  return [platform, brand].filter(Boolean).join(" · ");
};

const hintsOf = (): DeviceHints => {
  const data = (
    navigator as { userAgentData?: { platform?: string; brands?: readonly { brand: string }[] } }
  ).userAgentData;
  return { platform: data?.platform, brands: data?.brands, userAgent: navigator.userAgent };
};

/**
 * 保管方的线索只有 Ceremony 当场给得出：`platform` 是本机（钥匙串、Windows Hello、生物识别），
 * `cross-platform` 是随身的安全密钥或密码管理器。同一个人手里两把密钥就靠它分开。
 */
const attachmentSuffix = (attachment?: string): string =>
  attachment === "cross-platform" ? "跨设备密钥" : attachment === "platform" ? "本机解锁" : "";

const autoPasskeyName = (attachment?: string): string => {
  const device = describeDevice(hintsOf());
  const suffix = attachmentSuffix(attachment);
  if (!device) return suffix || "本设备";
  return suffix ? `${device}（${suffix}）` : device;
};

/** 浏览器是否支持 WebAuthn：不支持时整段入口都不该出现，而不是摆一个必然失败的按钮。 */
export const passkeySupported = (): boolean => browserSupportsWebAuthn();

/** 用户在系统弹窗里取消、或本设备没有可用密钥：`DOMException.name` 是唯一可辨的信号。 */
const isCancelled = (error: unknown): boolean =>
  error instanceof DOMException &&
  (error.name === "NotAllowedError" || error.name === "AbortError");

/** 通行密钥流程的错误文案：服务端错误码已在 `Api.ts` 换成中文，取消与未知情况用调用方给的兜底。 */
export const passkeyErrorMessage = (error: unknown, fallback: string): string => {
  if (isCancelled(error)) return "已取消通行密钥验证";
  if (error instanceof AuthRequestError) return error.message;
  return fallback;
};

/** 用通行密钥登录：不填 QQ 号，由系统挑出属于本站的密钥（可发现凭据）。 */
export const signInWithPasskey = async (): Promise<void> => {
  const optionsJSON = await authGet<PublicKeyCredentialRequestOptionsJSON>(
    "/passkey/generate-authenticate-options"
  );
  const response = await startAuthentication({ optionsJSON });
  await authPost("/passkey/verify-authentication", { response });
};

/**
 * 给当前登录的账号添加一把密钥；要求会话既在登录状态、又足够新鲜。
 * 名字自动取（设备 + 保管方）：插件不会替站点取名，不传就会存成空名，
 * 列表里全是「未命名通行密钥」。这里不弹输入框，先记下再让玩家在列表里改。
 */
export const addPasskey = async (): Promise<void> => {
  const optionsJSON = await authGet<PublicKeyCredentialCreationOptionsJSON>(
    "/passkey/generate-register-options"
  );
  const response = await startRegistration({ optionsJSON });
  await authPost("/passkey/verify-registration", {
    response,
    name: autoPasskeyName(response.authenticatorAttachment),
  });
};

export const listPasskeys = () => authGet<PasskeyEntry[]>("/passkey/list-user-passkeys");

/** 改名只动库里那一行的 `name`：凭据本身不变，登录行为不受影响，属主校验在服务端。 */
export const renamePasskey = (id: string, name: string) =>
  authPost("/passkey/update-passkey", { id, name: name.trim().slice(0, PASSKEY_NAME_MAX) });

export const removePasskey = (id: string) => authPost("/passkey/delete-passkey", { id });
