import { ORPCError, createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { AUTH_BASE_PATH } from "@bakagame/shared/values";
import type { ApiContract } from "@bakagame/shared";
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

/** 服务端未配置数据库时账号接口统一回 `ACCOUNT_DISABLED`：前端保留入口并提示不可用，游客照常游玩。 */
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

/**
 * Better Auth 端点的错误。开放面是登录、读会话、退出与通行密钥那几个端点（见 Server/docs/Account.md §2）；
 * 服务端给的 `message` 多为英文，按 `code` 换成中文，未列出的码交给调用方兜底。
 */
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
  UNAUTHORIZED: "请先登录",
  // 添加密钥要求「新鲜」登录（默认 24 小时内）：这是防会话盗用的门槛，不是 bug。
  SESSION_NOT_FRESH: "这次登录已超过一天，请重新登录后再添加通行密钥",
  SESSION_REQUIRED: "请先登录后再添加通行密钥",
  CHALLENGE_NOT_FOUND: "验证已超时，请重新尝试",
  PASSKEY_NOT_FOUND: "这个通行密钥已不属于任何账号，请改用验证码登录",
  AUTHENTICATION_FAILED: "通行密钥校验失败，请改用验证码登录",
  FAILED_TO_VERIFY_REGISTRATION: "通行密钥添加失败，请重试",
  YOU_ARE_NOT_ALLOWED_TO_REGISTER_THIS_PASSKEY: "这个通行密钥不属于当前账号",
  PREVIOUSLY_REGISTERED: "这台设备已有通行密钥，无需重复添加",
};

/**
 * 调用 Better Auth 端点：返回体按 `T` 取，不做结构校验（可打的端点由服务端白名单固定）。
 * GET 用于取 WebAuthn 挑战，POST 用于提交响应；两者都靠 Cookie 带会话与挑战值。
 */
const authRequest = async <T>(
  path: string,
  init: { method: "GET" } | { method: "POST"; body: Record<string, unknown> }
): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(absolute(`${AUTH_BASE_PATH}${path}`), {
      method: init.method,
      credentials: "include",
      ...(init.method === "POST"
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(init.body),
          }
        : {}),
    });
  } catch {
    throw new AuthRequestError("NETWORK_ERROR", "网络异常，请稍后重试", 0);
  }
  if (response.ok) return (await response.json()) as T;
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

/** 供通行密钥流程直连 Better Auth 端点（挑战值写在签名 Cookie 里，必须带凭据、不经 oRPC）。 */
export const authGet = <T>(path: string) => authRequest<T>(path, { method: "GET" });
export const authPost = <T = void>(path: string, body: Record<string, unknown>) =>
  authRequest<T>(path, { method: "POST", body });

/** 邮箱验证码登录；首次登录即注册，账号昵称由服务端强制取自 QQ 昵称，客户端不必也不可自报。 */
export const signInWithCode = (input: { email: string; otp: string }) =>
  authPost("/sign-in/email-otp", input);

export const signOut = () => authPost("/sign-out", {});
