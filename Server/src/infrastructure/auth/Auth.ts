import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { admin, emailOTP } from "better-auth/plugins";
import type { BetterAuthOptions } from "better-auth";

import {
  AUTH_BASE_PATH,
  LOGIN_CODE_LENGTH,
  LOGIN_CODE_TTL_SECONDS,
  qqNumberOfEmail,
} from "../../shared/Account";
import type { Mailer } from "./Mailer";

export interface AuthOptions {
  /** Better Auth 适配器：生产为 drizzle（TiDB），测试为内存适配器。 */
  database: BetterAuthOptions["database"];
  secret: string;
  /** 后端公开基址，用于 Cookie 与来源判定。 */
  baseURL: string;
  /** 与 HTTP / WebSocket 共用的来源白名单判定。 */
  isTrustedOrigin: (origin: string) => boolean;
  /** 部署在 HTTPS 之后：强制 Secure Cookie（源站本身可能只监听 HTTP）。 */
  secureCookies: boolean;
  adminQqNumbers: readonly string[];
  mailer: Mailer;
  /**
   * 建号时解析账号昵称（即该 QQ 号的 QQ 昵称）；返回 `null` 时拒绝建号。
   * 昵称查询接口不可用时停用注册（见 Agents/Account.md §4）。
   */
  resolveNickname: (qqNumber: string) => Promise<string | null>;
}

/**
 * 账号认证实例。
 *
 * - 身份锚点是 QQ 号：登录邮箱只接受 `QQ号@qq.com`，`qqNumber` 由建号钩子从邮箱派生，客户端无法自报。
 * - 只开放验证码登录：发码走 oRPC（`AccountService.requestLoginCode`，可见投递失败），
 *   Better Auth 自带的发码端点把投递异常吞进后台日志，不对外暴露（见 `AUTH_HTTP_PATHS`）。
 * - 账号昵称强制使用 QQ 昵称（建号钩子经 `resolveNickname` 解析，客户端无法自报，查询不可用时拒绝建号）；
 *   头像由服务端从 qlogo 同步；其余资料与管理操作都走服务端 API，HTTP 侧不开放 `update-user` 与 admin 端点。
 */
export const createAuth = (options: AuthOptions) => {
  const admins = new Set(options.adminQqNumbers);
  return betterAuth({
    appName: "BakaGame",
    basePath: AUTH_BASE_PATH,
    baseURL: options.baseURL,
    secret: options.secret,
    database: options.database,
    trustedOrigins: (request) => {
      const origin = request?.headers.get("origin");
      return origin && options.isTrustedOrigin(origin) ? [origin] : [];
    },
    user: {
      additionalFields: {
        qqNumber: { type: "string", required: false, input: false },
        showQq: { type: "boolean", required: false, defaultValue: false, input: false },
        avatarHash: { type: "string", required: false, input: false, returned: false },
        avatarCheckedAt: { type: "date", required: false, input: false, returned: false },
        qqName: { type: "string", required: false, input: false, returned: false },
        qqNameCheckedAt: { type: "date", required: false, input: false, returned: false },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: 300 },
    },
    // 自有限流在 AccountService：代理后所有客户端共享同一 peer，按 IP 限流会误伤全站。
    rateLimit: { enabled: false },
    advanced: {
      cookiePrefix: "bakagame",
      useSecureCookies: options.secureCookies,
      ipAddress: { disableIpTracking: true },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const qqNumber = qqNumberOfEmail(user.email);
            if (!qqNumber) throw APIError.from("BAD_REQUEST", { code: "INVALID_QQ_EMAIL", message: "只支持 QQ 邮箱登录" });
            // 账号昵称强制取自 QQ 昵称，客户端自报的 name 一律忽略；查询不到时拒绝建号。
            const name = await options.resolveNickname(qqNumber);
            if (!name) {
              throw APIError.from("SERVICE_UNAVAILABLE", { code: "QQ_NICKNAME_UNAVAILABLE", message: "暂时无法获取你的 QQ 昵称，请重新获取验证码后再试" });
            }
            // 头像只由服务端从 qlogo 抓取后写入站内代理地址，不接受客户端提供的 URL。
            return { data: { ...user, name, image: null, qqNumber, showQq: false, role: admins.has(qqNumber) ? "admin" : "user" } };
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/email-otp") return;
        const body = (ctx.body ?? {}) as { email?: unknown; image?: unknown };
        if (typeof body.email !== "string" || !qqNumberOfEmail(body.email)) {
          throw APIError.from("BAD_REQUEST", { code: "INVALID_QQ_EMAIL", message: "只支持 QQ 邮箱登录" });
        }
        if (body.image !== undefined) throw APIError.from("BAD_REQUEST", { code: "FIELD_NOT_ALLOWED", message: "头像由 QQ 自动同步" });
      }),
    },
    plugins: [
      emailOTP({
        otpLength: LOGIN_CODE_LENGTH,
        expiresIn: LOGIN_CODE_TTL_SECONDS,
        allowedAttempts: 3,
        storeOTP: "hashed",
        // 插件要求的投递回调；HTTP 发码端点不开放，正常发码由 AccountService 生成验证码后直接投递。
        sendVerificationOTP: async ({ email, otp, type }) => {
          if (type !== "sign-in") throw new Error(`不支持的验证码类型: ${type}`);
          await options.mailer.sendLoginCode({ to: email, code: otp });
        },
      }),
      admin({ defaultRole: "user", adminRoles: ["admin"], bannedUserMessage: "账号已被封禁" }),
    ],
  });
};

export type Auth = ReturnType<typeof createAuth>;

/**
 * 对浏览器开放的 Better Auth 端点白名单（相对 `AUTH_BASE_PATH`）。
 * 其余端点（注册、改资料、管理接口、自带发码……）一律 404，只能经服务端 API 调用。
 */
export const AUTH_HTTP_PATHS: ReadonlySet<string> = new Set([
  "/sign-in/email-otp",
  "/get-session",
  "/sign-out",
]);
