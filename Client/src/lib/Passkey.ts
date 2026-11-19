import {
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
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

/** 交给 `describeDevice` 的浏览器线索（UA-Client-Hints）；做成参数是为了能在测试里喂假数据。 */
export interface DeviceHints {
  platform?: string;
  brands?: readonly { brand: string }[];
}

/** 品牌清单里，内核名与「Not:A-Brand」这类占位都不是浏览器的名字。 */
const isMeaningfulBrand = (brand: string): boolean =>
  brand !== "Chromium" && !brand.startsWith("Not");

/**
 * 设备名只读 UA-Client-Hints（Chromium 系才给得出系统与品牌清单），不嗅探 UA 字符串。
 * 认不出的部分就是空串，由调用方兜底，不编一个「未知设备」占位。
 */
export const describeDevice = (hints: DeviceHints): string => {
  const brand = hints.brands
    ?.filter((item) => isMeaningfulBrand(item.brand))
    .at(-1)
    ?.brand.replace(/^Google /, "");
  return [hints.platform, brand].filter(Boolean).join(" · ");
};

const hintsOf = (): DeviceHints => {
  const data = (
    navigator as { userAgentData?: { platform?: string; brands?: readonly { brand: string }[] } }
  ).userAgentData;
  return { platform: data?.platform, brands: data?.brands };
};

/**
 * 保管方的线索只有 Ceremony 当场给得出：`platform` 是本机（钥匙串、Windows Hello、生物识别），
 * `cross-platform` 是随身的安全密钥或密码管理器。同一个人手里两把密钥就靠它分开。
 */
const attachmentSuffix = (attachment?: string): string =>
  attachment === "cross-platform" ? "跨设备密钥" : attachment === "platform" ? "本机解锁" : "";

/** 导出仅供单测：浏览器线索由参数注入，但命名文案本身是产品行为。 */
export const autoPasskeyName = (attachment?: string): string => {
  const device = describeDevice(hintsOf());
  const suffix = attachmentSuffix(attachment);
  if (!device) return suffix || "本设备";
  return suffix ? `${device}（${suffix}）` : device;
};

/** 注册时要求浏览器只呈现哪一类验证器；登录不限制，由系统挑出已有凭据。 */
export type PasskeyAttachment = "platform" | "cross-platform";

/** 浏览器是否支持 WebAuthn：不支持时整段入口都不该出现，而不是摆一个必然失败的按钮。 */
export const passkeySupported = (): boolean => browserSupportsWebAuthn();

/**
 * 本机是否有系统验证器（Windows Hello、指纹、面容）。
 * 返回 `undefined` 表示浏览器没给答案，调用方不应据此禁用入口。
 */
export const platformAuthenticatorAvailable = async (): Promise<boolean | undefined> => {
  if (!passkeySupported()) return undefined;
  try {
    return await platformAuthenticatorIsAvailable();
  } catch {
    return undefined;
  }
};

const errorName = (error: unknown): string => (error instanceof DOMException ? error.name : "");

/** 页面 origin 与 rpID 不同域（Android 壳未对齐、或 DNS 换了域）时的唯一可辨信号是 `SecurityError`。 */
const DOMAIN_MISMATCH_MESSAGE = "当前页面域名与通行密钥域名不一致，请用网页版或更新后的客户端再试";

const CANCELLED_MESSAGE = "已取消通行密钥验证";

/**
 * 注册时的已知线索：玩家明确选了「本机解锁」、而能力探测说本机没有系统验证器时，
 * 可以直接告诉他换另一条路。
 */
export interface PasskeyRegistrationContext {
  attachment?: PasskeyAttachment;
  platformAuthenticator?: boolean;
}

const notAllowedMessage = (registration?: PasskeyRegistrationContext): string => {
  if (!registration) return "已取消通行密钥验证，或本设备没有可用的通行密钥";
  if (registration.attachment === "platform" && registration.platformAuthenticator === false) {
    return "本设备没有可用的系统验证器，请改用「密码管理器或安全密钥」";
  }
  return "已取消通行密钥验证，或所选验证器不可用";
};

/**
 * 通行密钥流程的错误文案（登录与注册共用，注册传 `registration`）：服务端错误码已在 `Api.ts` 换成中文。
 *
 * WebAuthn 把「用户取消」「超时」「没有可用验证器」都压成 `NotAllowedError`，
 * 只能给出包含两种可能的文案；域名未关联是独立的 `SecurityError`，可以单独说清。
 */
export const passkeyErrorMessage = (
  error: unknown,
  fallback: string,
  registration?: PasskeyRegistrationContext
): string => {
  const name = errorName(error);
  if (name === "SecurityError") return DOMAIN_MISMATCH_MESSAGE;
  if (name === "AbortError") return CANCELLED_MESSAGE;
  if (name === "NotAllowedError") return notAllowedMessage(registration);
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
 * 把玩家选的验证器类型写进服务端给的选项：`authenticatorSelection` 的其余字段
 * （`residentKey`、`userVerification`）原样保留，安全要求不在这里放宽或收紧。
 */
const withAttachment = (
  optionsJSON: PublicKeyCredentialCreationOptionsJSON,
  attachment: PasskeyAttachment
): PublicKeyCredentialCreationOptionsJSON => ({
  ...optionsJSON,
  authenticatorSelection: {
    ...optionsJSON.authenticatorSelection,
    authenticatorAttachment: attachment,
  },
});

/**
 * 给当前登录的账号添加一把密钥；要求会话既在登录状态、又足够新鲜。
 *
 * `attachment` 必传时由浏览器只呈现对应类型：
 * - `platform`：系统验证器（Windows Hello、指纹、面容），只在明确要求时使用；
 * - `cross-platform`：密码管理器或安全密钥（Bitwarden、YubiKey），不再被 Windows Hello 截胡。
 * 不传则沿用服务端的默认选择。
 *
 * 名字自动取（设备 + 保管方）：插件不会替站点取名，不传就会存成空名，
 * 列表里全是「未命名通行密钥」。这里不弹输入框，先记下再让玩家在列表里改。
 */
export const addPasskey = async (attachment?: PasskeyAttachment): Promise<void> => {
  const optionsJSON = await authGet<PublicKeyCredentialCreationOptionsJSON>(
    "/passkey/generate-register-options"
  );
  const response = await startRegistration({
    optionsJSON: attachment ? withAttachment(optionsJSON, attachment) : optionsJSON,
  });
  // 浏览器的回执最准；个别实现回 null，就退回玩家选的那一类，名字仍能说清来路。
  await authPost("/passkey/verify-registration", {
    response,
    name: autoPasskeyName(response.authenticatorAttachment ?? attachment),
  });
};

export const listPasskeys = () => authGet<PasskeyEntry[]>("/passkey/list-user-passkeys");

/** 改名只动库里那一行的 `name`：凭据本身不变，登录行为不受影响，属主校验在服务端。 */
export const renamePasskey = (id: string, name: string) =>
  authPost("/passkey/update-passkey", { id, name: name.trim().slice(0, PASSKEY_NAME_MAX) });

export const removePasskey = (id: string) => authPost("/passkey/delete-passkey", { id });
