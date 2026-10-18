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

/** 给当前登录的账号添加一把密钥；要求会话既在登录状态、又足够新鲜。 */
export const addPasskey = async (): Promise<void> => {
  const optionsJSON = await authGet<PublicKeyCredentialCreationOptionsJSON>(
    "/passkey/generate-register-options"
  );
  const response = await startRegistration({ optionsJSON });
  await authPost("/passkey/verify-registration", { response });
};

export const listPasskeys = () => authGet<PasskeyEntry[]>("/passkey/list-user-passkeys");

export const removePasskey = (id: string) => authPost("/passkey/delete-passkey", { id });
