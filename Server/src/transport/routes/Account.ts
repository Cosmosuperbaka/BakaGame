import { ORPCError, implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { Elysia } from "elysia";

import type { AccountService } from "../../application/AccountService";
import type { AdminService } from "../../application/AdminService";
import type { SiteStatsService } from "../../application/SiteStatsService";
import type { UserDataService } from "../../application/UserDataService";
import { isAppError } from "../../domain/Errors";
import { describeError, type EventLogger } from "../../infrastructure/EventLogger";
import { AUTH_HTTP_PATHS, type Auth } from "../../infrastructure/auth/Auth";
import { resolveClientIp } from "../ClientIp";
import { ACCOUNT_AVATAR_PATH, AUTH_BASE_PATH } from "../../shared/Account";
import { apiContract } from "../../shared/ApiContract";
import { TelemetryRateLimiter } from "./System";

export const RPC_BASE_PATH = "/api/rpc";

/** 账号系统运行时依赖：只有配置了数据库才装配。 */
export interface AccountDependencies {
  auth: Auth;
  service: AccountService;
  userData: UserDataService;
  admin: AdminService;
  visits: SiteStatsService;
  /** 数据库迁移完成后才对外服务账号请求。 */
  ready: Promise<void>;
}

interface RpcContext {
  headers: Headers;
}

/** 业务错误码 → HTTP 状态（HTTP 全局错误钩子与 oRPC 共用）；未列出的业务错误按 400。 */
const STATUS_BY_CODE: Record<string, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  ACCOUNT_BANNED: 403,
  FORBIDDEN_ORIGIN: 403,
  NOT_FOUND: 404,
  ROOM_NOT_FOUND: 404,
  PLAYER_NOT_FOUND: 404,
  RATE_LIMITED: 429,
  MAIL_UNAVAILABLE: 503,
  AVATAR_UNAVAILABLE: 503,
  QQ_LOGIN_UNAVAILABLE: 503,
  QQ_LOOKUP_DISABLED: 503,
  QQ_NICKNAME_UNAVAILABLE: 503,
  ACCOUNT_DISABLED: 503,
};

export const statusOfAppError = (code: string): number => STATUS_BY_CODE[code] ?? 400;

const createRpcRouter = ({ service, userData, admin, visits }: AccountDependencies, logger: EventLogger) => {
  const base = implement(apiContract).$context<RpcContext>().use(async ({ next, path }) => {
    try {
      return await next();
    } catch (error) {
      if (error instanceof ORPCError) throw error;
      if (isAppError(error)) {
        throw new ORPCError(error.code, { status: statusOfAppError(error.code), message: error.message });
      }
      logger.error(`RPC 内部异常 [${path.join(".")}]`, describeError(error));
      throw new ORPCError("INTERNAL_ERROR", { status: 500, message: "服务器内部错误" });
    }
  });
  const signedIn = base.use(async ({ context, next }) => {
    const userId = await service.currentUserId(context.headers);
    if (!userId) throw new ORPCError("UNAUTHORIZED", { status: 401, message: "请先登录" });
    return next({ context: { userId } });
  });
  const adminOnly = signedIn.use(async ({ context, next }) => {
    await admin.requireAdmin(context.userId);
    return next();
  });

  return base.router({
    site: {
      visit: base.site.visit.handler(async ({ context, input }) => {
        visits.record({ ...input, userId: await service.currentUserId(context.headers) });
        return { ok: true as const };
      }),
    },
    account: {
      requestLoginCode: base.account.requestLoginCode.handler(({ input }) => service.requestLoginCode(input.qqNumber)),
      me: base.account.me.handler(async ({ context }) => {
        const userId = await service.currentUserId(context.headers);
        return userId ? service.me(userId) : null;
      }),
      updateProfile: signedIn.account.updateProfile.handler(({ context, input }) => service.updateProfile(context.userId, input)),
      publicProfile: base.account.publicProfile.handler(({ input }) => service.publicProfile(input.userId)),
    },
    settings: {
      get: signedIn.settings.get.handler(({ context }) => userData.settings(context.userId)),
      savePreferences: signedIn.settings.savePreferences.handler(({ context, input }) =>
        userData.savePreferences(context.userId, input.value)),
      saveMusicSession: signedIn.settings.saveMusicSession.handler(({ context, input }) =>
        userData.saveMusicSession(context.userId, input.platform, input.session)),
    },
    feedback: {
      create: signedIn.feedback.create.handler(({ context, input }) =>
        userData.createFeedback(context.userId, { ...input, userAgent: context.headers.get("user-agent") })),
      listMine: signedIn.feedback.listMine.handler(({ context }) => userData.listMyFeedback(context.userId)),
      get: signedIn.feedback.get.handler(({ context, input }) => userData.myFeedback(context.userId, input.id)),
    },
    admin: {
      users: {
        list: adminOnly.admin.users.list.handler(({ input }) => admin.listUsers(input)),
        get: adminOnly.admin.users.get.handler(({ input }) => admin.getUser(input.userId)),
        ban: adminOnly.admin.users.ban.handler(({ context, input }) => admin.banUser(context.userId, input)),
        unban: adminOnly.admin.users.unban.handler(({ context, input }) => admin.unbanUser(context.userId, input.userId)),
        setRole: adminOnly.admin.users.setRole.handler(({ context, input }) => admin.setRole(context.userId, input)),
        revokeSessions: adminOnly.admin.users.revokeSessions.handler(({ context, input }) => admin.revokeSessions(context.userId, input.userId)),
      },
      rooms: {
        list: adminOnly.admin.rooms.list.handler(({ input }) => admin.listRooms(input.game)),
        close: adminOnly.admin.rooms.close.handler(({ context, input }) => admin.closeRoom(context.userId, input)),
        kick: adminOnly.admin.rooms.kick.handler(({ context, input }) => admin.kickPlayer(context.userId, input)),
      },
      feedback: {
        list: adminOnly.admin.feedback.list.handler(({ input }) => admin.listFeedback(input)),
        get: adminOnly.admin.feedback.get.handler(({ input }) => admin.getFeedback(input.id)),
        reply: adminOnly.admin.feedback.reply.handler(({ context, input }) => admin.replyFeedback(context.userId, input)),
        setStatus: adminOnly.admin.feedback.setStatus.handler(({ context, input }) => admin.setFeedbackStatus(context.userId, input)),
      },
      games: {
        list: adminOnly.admin.games.list.handler(({ input }) => admin.listGames(input)),
        get: adminOnly.admin.games.get.handler(({ input }) => admin.getGame(input.id)),
      },
      audit: {
        list: adminOnly.admin.audit.list.handler(({ input }) => admin.listAudit(input)),
      },
      qq: {
        status: adminOnly.admin.qq.status.handler(() => admin.qqStatus()),
        refreshNames: adminOnly.admin.qq.refreshNames.handler(({ context }) => admin.qqRefreshNames(context.userId)),
      },
      stats: {
        overview: adminOnly.admin.stats.overview.handler(({ input }) => admin.overview(input.days)),
        sentry: adminOnly.admin.stats.sentry.handler(() => admin.sentryOverview()),
      },
    },
  });
};

const accountDisabled = () => new Response(
  JSON.stringify({ error: { code: "ACCOUNT_DISABLED", message: "账号系统未启用" } }),
  { status: 503, headers: { "content-type": "application/json" } },
);

/** RPC 前缀按 oRPC 错误编码回停用：客户端据 `code` 识别，不与网关自身的 503 混淆。 */
const rpcAccountDisabled = () => new Response(
  JSON.stringify({ json: { defined: false, code: "ACCOUNT_DISABLED", status: 503, message: "账号系统未启用" } }),
  { status: 503, headers: { "content-type": "application/json" } },
);

const AVATAR_SIZES = { "100": 100, "640": 640 } as const;

/**
 * 账号路由（Better Auth + oRPC）的额度，口径与打点、Sentry 隧道一致：单客户端 / 回源 peer / 全局。
 * 取打点的五倍：一次进房会连着打多个 RPC，后台列表页还会轮询未读，按单请求计数会误伤正常玩家。
 */
const ACCOUNT_IP_MAX_REQUESTS = 300;
const ACCOUNT_GLOBAL_MAX_REQUESTS = 12_000;
const ACCOUNT_WINDOW_MS = 60_000;

/**
 * 账号 HTTP 入口：Better Auth 白名单端点、oRPC、站内头像代理。
 *
 * 未配置数据库时三类路由都回 503 `ACCOUNT_DISABLED`：前端据此隐藏登录入口，游客游玩不受影响。
 */
export const accountRoutes = (account: AccountDependencies | undefined, logger: EventLogger) => {
  const rpc = account ? new RPCHandler(createRpcRouter(account, logger)) : undefined;
  const limiter = new TelemetryRateLimiter({
    windowMs: ACCOUNT_WINDOW_MS,
    ipMaxRequests: ACCOUNT_IP_MAX_REQUESTS,
    globalMaxRequests: ACCOUNT_GLOBAL_MAX_REQUESTS,
  });
  // Better Auth 自带的按 IP 限流是关的（它只认 socket peer，反代后全站共享同一个 peer）。
  // 这一层改按 ESA 写入的真实 IP 标头分桶，peer 桶只封顶伪造标头自造新桶的路径。
  const rejectOverQuota = (request: Request, peerIp: string | undefined, viaRpc: boolean): Response | undefined => {
    const clientIp = resolveClientIp(request.headers, peerIp);
    if (limiter.allow(clientIp, peerIp ?? clientIp)) return undefined;
    const body = viaRpc
      ? { json: { defined: false, code: "RATE_LIMITED", status: 429, message: "请求过于频繁，请稍后重试" } }
      : { error: { code: "RATE_LIMITED", message: "请求过于频繁，请稍后重试" } };
    return new Response(JSON.stringify(body), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": String(Math.ceil(ACCOUNT_WINDOW_MS / 1000)) },
    });
  };
  return new Elysia({ name: "account-routes" })
    .all(`${AUTH_BASE_PATH}/*`, async ({ request, server }) => {
      const overQuota = rejectOverQuota(request, server?.requestIP(request)?.address, false);
      if (overQuota) return overQuota;
      if (!account) return accountDisabled();
      const path = new URL(request.url).pathname.slice(AUTH_BASE_PATH.length);
      if (!AUTH_HTTP_PATHS.has(path)) {
        return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "请求资源不存在" } }), {
          status: 404, headers: { "content-type": "application/json" },
        });
      }
      await account.ready;
      return account.auth.handler(request);
    }, { parse: "none", detail: { hide: true } })
    .all(`${RPC_BASE_PATH}/*`, async ({ request, server }) => {
      const overQuota = rejectOverQuota(request, server?.requestIP(request)?.address, true);
      if (overQuota) return overQuota;
      if (!account || !rpc) return rpcAccountDisabled();
      await account.ready;
      const { matched, response } = await rpc.handle(request, { prefix: RPC_BASE_PATH, context: { headers: request.headers } });
      return matched ? response : new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "请求资源不存在" } }), {
        status: 404, headers: { "content-type": "application/json" },
      });
    }, { parse: "none", detail: { hide: true } })
    .get(`${ACCOUNT_AVATAR_PATH}/:userId`, async ({ params, query }) => {
      if (!account) return accountDisabled();
      await account.ready;
      const size = AVATAR_SIZES[(query.size ?? "640") as keyof typeof AVATAR_SIZES] ?? 640;
      const { image, current } = await account.service.avatar(params.userId, size, query.v);
      return new Response(image.bytes, {
        headers: {
          "content-type": image.contentType,
          // 版本号与当前摘要一致时 URL 内容永不变化；否则（旧链接、未带版本）只短缓存。
          "cache-control": current ? "public, max-age=31536000, immutable" : "public, max-age=300",
          "x-content-type-options": "nosniff",
        },
      });
    }, { detail: { hide: true } });
};
