import { ORPCError, createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { AUTH_BASE_PATH, type ApiContract } from "@bakagame/shared";
import { resolveServerUrl } from "@/lib/ServerEndpoint";

/**
 * 账号 HTTP API 的客户端（oRPC，`/api/rpc`）。
 *
 * 契约只取类型：调用签名由 `ApiContract` 推导，运行时不打包 zod 契约。
 * 会话靠 HttpOnly Cookie：生产同源；本地开发前后端同为 localhost（同站），带上凭据即可。
 */
export type ApiClient = ContractRouterClient<ApiContract>;

const absolute = (path: string) => new URL(resolveServerUrl(path), window.location.href);

export const createApiClient = (): ApiClient =>
  createORPCClient(
    new RPCLink({
      url: () => absolute("/api/rpc"),
      fetch: (request, init) => fetch(request, { ...init, credentials: "include" }),
    })
  );

export const api: ApiClient = createApiClient();

/** 站内头像地址（`/api/account/avatar/...`）按后端基址补全；外链（登录弹窗按 QQ 号取的 qlogo）原样使用。 */
export const avatarSrc = (image: string): string =>
  image.startsWith("/") ? resolveServerUrl(image) : image;

/** 服务端未配置数据库时账号接口统一回 `ACCOUNT_DISABLED`：前端隐藏全部账号入口，游客照常游玩。 */
export const isAccountDisabled = (error: unknown): boolean =>
  error instanceof ORPCError && error.code === "ACCOUNT_DISABLED";

const CJK = /[一-鿿]/;

/**
 * 可直接展示的错误文案。服务端业务错误的 `message` 本身是中文；
 * 校验失败、网络中断与网关错误给不出中文时，统一用 `fallback`。
 */
export const apiErrorMessage = (error: unknown, fallback = "请求失败，请稍后重试"): string => {
  if (error instanceof ORPCError) {
    if (
      error.code === "BAD_REQUEST" &&
      Array.isArray((error.data as { issues?: unknown } | undefined)?.issues)
    ) {
      const issue = (error.data as { issues: Array<{ message?: unknown }> }).issues[0];
      if (typeof issue?.message === "string" && CJK.test(issue.message)) return issue.message;
    }
    if (CJK.test(error.message)) return error.message;
  }
  return fallback;
};

/** Better Auth 端点的错误：只开放登录、读会话与退出三个端点（见 Agents/Account.md §2）。 */
export class AuthRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "AuthRequestError";
    this.code = code;
    this.status = status;
  }
}

const AUTH_MESSAGES: Record<string, string> = {
  INVALID_OTP: "验证码不正确",
  OTP_EXPIRED: "验证码已过期，请重新获取",
  TOO_MANY_ATTEMPTS: "尝试次数过多，请重新获取验证码",
  BANNED_USER: "账号已被封禁",
};

const postAuth = async (path: string, body: Record<string, unknown>): Promise<void> => {
  let response: Response;
  try {
    response = await fetch(absolute(`${AUTH_BASE_PATH}${path}`), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AuthRequestError("NETWORK_ERROR", "网络异常，请稍后重试", 0);
  }
  if (response.ok) return;
  const payload = (await response.json().catch(() => null)) as {
    code?: unknown;
    message?: unknown;
    error?: { code?: unknown; message?: unknown };
  } | null;
  const source = payload?.error ?? payload ?? {};
  const code = typeof source.code === "string" ? source.code : `HTTP_${response.status}`;
  const message =
    AUTH_MESSAGES[code] ??
    (typeof source.message === "string" && CJK.test(source.message)
      ? source.message
      : "登录失败，请稍后重试");
  throw new AuthRequestError(code, message, response.status);
};

/** 邮箱验证码登录；首次登录即注册，账号昵称由服务端强制取自 QQ 昵称，客户端不必也不可自报。 */
export const signInWithCode = (input: { email: string; otp: string }) =>
  postAuth("/sign-in/email-otp", input);

export const signOut = () => postAuth("/sign-out", {});
