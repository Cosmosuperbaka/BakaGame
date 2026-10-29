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
import {
  httpError,
  rateLimitHeaders,
  rpcError,
  traceIdOf,
  type HttpErrorBody,
  type RpcErrorBody,
} from "../HttpErrorEnvelope";
import { ACCOUNT_AVATAR_PATH, AUTH_BASE_PATH } from "../../shared/Account";
import { apiContract } from "../../shared/ApiContract";
import { TelemetryRateLimiter } from "./System";

export const RPC_BASE_PATH = "/api/rpc";

/**
 * RPC 的写请求只接受 `application/json`。
 *
 * 生产 Cookie 是 `SameSite=None`，跨站 CSRF 只能靠「非简单请求必须先过 CORS 预检」兜住；
 * 但 oRPC 的 fetch 适配器还会解码 `multipart/form-data`（取 `data` 字段的 JSON），缺省
 * content-type 时又按 JSON 解析——前者是一张跨站 HTML 表单，后者是一个不带类型的 Blob，
 * 两者都是简单请求、不触发预检，会带着受害者的 Cookie 直接执行写过程（含后台改角色）。
 * 本站客户端只发 JSON，契约里也没有文件入参，因此在入口把其余形态一律挡掉。
 */
const isJsonRpcRequest = (request: Request): boolean =>
  request.method === "GET" ||
  request.method === "HEAD" ||
  request.method === "OPTIONS" ||
  (request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");

/** 账号系统运行时依赖：只有配置了数据库才装配。 */
export interface AccountDependencies {
  auth: Auth;
  service: AccountService;
  userData: UserDataService;
  admin: AdminService;
  visits: SiteStatsService;
  /** 数据库连通性检查通过后才对外服务账号请求。 */
  ready: Promise<void>;
}

interface RpcContext {
  headers: Headers;
  /** 边缘写入的真实客户端地址：昵称查询这类免发信接口按它分桶计配额。 */
  clientIp: string;
}

/** 业务错误码 → HTTP 状态（HTTP 全局错误钩子与 oRPC 共用）；未列出的业务错误按 400。 */
const STATUS_BY_CODE: Record<string, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  ACCOUNT_BANNED: 403,
  FORBIDDEN_ORIGIN: 403,
  AGENTS_DISABLED: 403,
  AGENTS_NOT_ALLOWED: 403,
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
  STATUS_EVENTS_DISABLED: 503,
};

export const statusOfAppError = (code: string): number => STATUS_BY_CODE[code] ?? 400;

const createRpcRouter = (
  { service, userData, admin, visits }: AccountDependencies,
  logger: EventLogger
) => {
  const base = implement(apiContract)
    .$context<RpcContext>()
    .use(async ({ next, path }) => {
      try {
        return await next();
      } catch (error) {
        if (error instanceof ORPCError) throw error;
        if (isAppError(error)) {
          throw new ORPCError(error.code, {
            status: statusOfAppError(error.code),
            message: error.message,
          });
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
      requestLoginCode: base.account.requestLoginCode.handler(({ input }) =>
        service.requestLoginCode(input.qqNumber)
      ),
      qqName: base.account.qqName.handler(({ input, context }) =>
        service.qqNickname(input.qqNumber, context.clientIp)
      ),
      me: base.account.me.handler(async ({ context }) => {
        const userId = await service.currentUserId(context.headers);
        return userId ? service.me(userId) : null;
      }),
      updateProfile: signedIn.account.updateProfile.handler(({ context, input }) =>
        service.updateProfile(context.userId, input)
      ),
      equipBadge: signedIn.account.equipBadge.handler(({ context, input }) =>
        service.updateEquippedBadge(context.userId, input.badge)
      ),
      publicProfile: base.account.publicProfile.handler(({ input }) =>
        service.publicProfile(input.userId)
      ),
    },
    settings: {
      get: signedIn.settings.get.handler(({ context }) => userData.settings(context.userId)),
      savePreferences: signedIn.settings.savePreferences.handler(({ context, input }) =>
        userData.savePreferences(context.userId, input.value)
      ),
      saveMusicSession: signedIn.settings.saveMusicSession.handler(({ context, input }) =>
        userData.saveMusicSession(context.userId, input.platform, input.session)
      ),
    },
    feedback: {
      create: base.feedback.create.handler(async ({ context, input }) => {
        const userId = await service.currentUserId(context.headers);
        return userData.createFeedback(
          userId,
          { ...input, userAgent: context.headers.get("user-agent") },
          context.clientIp
        );
      }),
      listMine: signedIn.feedback.listMine.handler(({ context }) =>
        userData.listMyFeedback(context.userId)
      ),
      get: signedIn.feedback.get.handler(({ context, input }) =>
        userData.myFeedback(context.userId, input.id)
      ),
    },
    admin: {
      users: {
        list: adminOnly.admin.users.list.handler(({ input }) => admin.listUsers(input)),
        get: adminOnly.admin.users.get.handler(({ input }) => admin.getUser(input.userId)),
        ban: adminOnly.admin.users.ban.handler(({ context, input }) =>
          admin.banUser(context.userId, input)
        ),
        unban: adminOnly.admin.users.unban.handler(({ context, input }) =>
          admin.unbanUser(context.userId, input.userId)
        ),
        setRole: adminOnly.admin.users.setRole.handler(({ context, input }) =>
          admin.setRole(context.userId, input)
        ),
        revokeSessions: adminOnly.admin.users.revokeSessions.handler(({ context, input }) =>
          admin.revokeSessions(context.userId, input.userId)
        ),
        grantBadge: adminOnly.admin.users.grantBadge.handler(({ context, input }) =>
          admin.grantBadge(context.userId, input)
        ),
        revokeBadge: adminOnly.admin.users.revokeBadge.handler(({ context, input }) =>
          admin.revokeBadge(context.userId, input)
        ),
      },
      settings: {
        list: adminOnly.admin.settings.list.handler(async () => ({
          items: await admin.listRuntimeSettings(),
        })),
        set: adminOnly.admin.settings.set.handler(async ({ context, input }) => ({
          items: await admin.updateRuntimeSetting(context.userId, input),
        })),
      },
      statusEvents: {
        list: adminOnly.admin.statusEvents.list.handler(({ input }) =>
          admin.listStatusEvents(input)
        ),
        create: adminOnly.admin.statusEvents.create.handler(({ context, input }) =>
          admin.createStatusEvent(context.userId, input)
        ),
        update: adminOnly.admin.statusEvents.update.handler(({ context, input }) =>
          admin.updateStatusEvent(context.userId, input)
        ),
        remove: adminOnly.admin.statusEvents.remove.handler(({ context, input }) =>
          admin.deleteStatusEvent(context.userId, input.id)
        ),
      },
      rooms: {
        list: adminOnly.admin.rooms.list.handler(({ input }) => admin.listRooms(input.game)),
        close: adminOnly.admin.rooms.close.handler(({ context, input }) =>
          admin.closeRoom(context.userId, input)
        ),
        kick: adminOnly.admin.rooms.kick.handler(({ context, input }) =>
          admin.kickPlayer(context.userId, input)
        ),
      },
      feedback: {
        list: adminOnly.admin.feedback.list.handler(({ input }) => admin.listFeedback(input)),
        get: adminOnly.admin.feedback.get.handler(({ input }) => admin.getFeedback(input.id)),
        reply: adminOnly.admin.feedback.reply.handler(({ context, input }) =>
          admin.replyFeedback(context.userId, input)
        ),
        setStatus: adminOnly.admin.feedback.setStatus.handler(({ context, input }) =>
          admin.setFeedbackStatus(context.userId, input)
        ),
      },
      antiCheat: {
        list: adminOnly.admin.antiCheat.list.handler(({ input }) =>
          admin.listAntiCheatReviews(input)
        ),
        history: adminOnly.admin.antiCheat.history.handler(({ input }) =>
          admin.antiCheatReviewHistory(input)
        ),
        setStatus: adminOnly.admin.antiCheat.setStatus.handler(({ context, input }) =>
          admin.setAntiCheatReviewStatus(context.userId, input)
        ),
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
        refreshNames: adminOnly.admin.qq.refreshNames.handler(({ context }) =>
          admin.qqRefreshNames(context.userId)
        ),
      },
      stats: {
        overview: adminOnly.admin.stats.overview.handler(({ input }) => admin.overview(input.days)),
        sentry: adminOnly.admin.stats.sentry.handler(() => admin.sentryOverview()),
      },
    },
  });
};

/**
 * 这一层的路由返回的是第三方产出（Better Auth handler、oRPC handler、头像流），只能用 `Response`，
 * 所以本文件内自建响应统一走这里：状态码、`content-type` 与限流头一次写清，追踪号由全局
 * `mapResponse` 补到响应头上，体里的 `traceId` 由调用方从 `set.headers` 取。
 */
const json = (
  status: number,
  body: HttpErrorBody | RpcErrorBody,
  headers?: Record<string, string>
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const accountDisabled = (traceId?: string): Response =>
  json(503, httpError("ACCOUNT_DISABLED", "账号系统未启用", traceId));

/** RPC 前缀按 oRPC 错误编码回停用：客户端据 `code` 识别，不与网关自身的 503 混淆。 */
const rpcAccountDisabled = (): Response =>
  json(503, rpcError("ACCOUNT_DISABLED", 503, "账号系统未启用"));

const AVATAR_SIZES = { "100": 100, "640": 640 } as const;

/**
 * 账号路由（Better Auth + oRPC）的额度，口径与打点、Sentry 隧道一致：单客户端 / 回源 peer / 全局。
 * 取打点的五倍：一次进房会连着打多个 RPC，后台列表页还会轮询未读，按单请求计数会误伤正常玩家。
 */
const ACCOUNT_IP_MAX_REQUESTS = 300;
const ACCOUNT_GLOBAL_MAX_REQUESTS = 12_000;
const ACCOUNT_WINDOW_MS = 60_000;

/**
 * 头像单独一份额度，不与登录/RPC 共桶：一屏房间列表就是十几个 `<img>`，
 * 和 RPC 共桶会让正常的头像加载把玩家的登录请求挤成 429。
 * 这份额度同时也是用户枚举的闸门——`avatar/:userId` 是按 ID 直取的资源，
 * 没有额度时可以任意脚本逐个 ID 探测「这个账号存在吗」。
 */
const AVATAR_IP_MAX_REQUESTS = 900;
const AVATAR_GLOBAL_MAX_REQUESTS = 30_000;

/**
 * 账号 HTTP 入口：Better Auth 白名单端点、oRPC、站内头像代理。
 *
 * 未配置数据库时三类路由都回 503 `ACCOUNT_DISABLED`：前端保留入口并提示不可用，游客游玩不受影响。
 */
export const accountRoutes = (account: AccountDependencies | undefined, logger: EventLogger) => {
  const rpc = account ? new RPCHandler(createRpcRouter(account, logger)) : undefined;
  const limiter = new TelemetryRateLimiter({
    windowMs: ACCOUNT_WINDOW_MS,
    ipMaxRequests: ACCOUNT_IP_MAX_REQUESTS,
    globalMaxRequests: ACCOUNT_GLOBAL_MAX_REQUESTS,
  });
  const avatarLimiter = new TelemetryRateLimiter({
    windowMs: ACCOUNT_WINDOW_MS,
    ipMaxRequests: AVATAR_IP_MAX_REQUESTS,
    globalMaxRequests: AVATAR_GLOBAL_MAX_REQUESTS,
  });
  // Better Auth 自带的按 IP 限流是关的（它只认 socket peer，反代后全站共享同一个 peer）。
  // 这一层改按边缘层写入的真实 IP 标头分桶，peer 桶只封顶伪造标头自造新桶的路径。
  const rejectOverQuota = (
    clientIp: string,
    peerIp: string | undefined,
    viaRpc: boolean,
    traceId?: string
  ): Response | undefined => {
    const verdict = limiter.consume(clientIp, peerIp ?? clientIp);
    if (verdict.allowed) return undefined;
    return json(
      429,
      viaRpc
        ? rpcError("RATE_LIMITED", 429, "请求过于频繁，请稍后重试")
        : httpError("RATE_LIMITED", "请求过于频繁，请稍后重试", traceId),
      rateLimitHeaders(verdict)
    );
  };
  return new Elysia({ name: "account-routes" })
    .all(
      `${AUTH_BASE_PATH}/*`,
      async ({ request, server, set }) => {
        const peerIp = server?.requestIP(request)?.address;
        const overQuota = rejectOverQuota(
          resolveClientIp(request.headers, peerIp),
          peerIp,
          false,
          traceIdOf(set.headers)
        );
        if (overQuota) return overQuota;
        if (!account) return accountDisabled(traceIdOf(set.headers));
        const path = new URL(request.url).pathname.slice(AUTH_BASE_PATH.length);
        if (!AUTH_HTTP_PATHS.has(path)) {
          return json(404, httpError("NOT_FOUND", "请求资源不存在", traceIdOf(set.headers)));
        }
        await account.ready;
        return account.auth.handler(request);
      },
      { parse: "none", detail: { hide: true } }
    )
    .all(
      `${RPC_BASE_PATH}/*`,
      async ({ request, server, set }) => {
        const peerIp = server?.requestIP(request)?.address;
        const clientIp = resolveClientIp(request.headers, peerIp);
        const overQuota = rejectOverQuota(clientIp, peerIp, true, traceIdOf(set.headers));
        if (overQuota) return overQuota;
        if (!account || !rpc) return rpcAccountDisabled();
        if (!isJsonRpcRequest(request)) {
          return json(
            415,
            rpcError("UNSUPPORTED_MEDIA_TYPE", 415, "请求体必须是 application/json")
          );
        }
        await account.ready;
        const { matched, response } = await rpc.handle(request, {
          prefix: RPC_BASE_PATH,
          context: { headers: request.headers, clientIp },
        });
        return matched
          ? response
          : json(404, httpError("NOT_FOUND", "请求资源不存在", traceIdOf(set.headers)));
      },
      { parse: "none", detail: { hide: true } }
    )
    .get(
      `${ACCOUNT_AVATAR_PATH}/:userId`,
      async ({ params, query, request, server, set }) => {
        const clientIp = resolveClientIp(request.headers, server?.requestIP(request)?.address);
        const verdict = avatarLimiter.consume(
          clientIp,
          server?.requestIP(request)?.address ?? clientIp
        );
        Object.assign(set.headers, rateLimitHeaders(verdict));
        if (!verdict.allowed) {
          set.status = 429;
          return httpError("RATE_LIMITED", "头像请求过于频繁，请稍后重试", traceIdOf(set.headers));
        }
        if (!account) return accountDisabled(traceIdOf(set.headers));
        await account.ready;
        const size = AVATAR_SIZES[(query.size ?? "640") as keyof typeof AVATAR_SIZES] ?? 640;
        const { image, current } = await account.service.avatar(params.userId, size, query.v);
        return new Response(image.bytes, {
          headers: {
            "content-type": image.contentType,
            // 版本号与当前摘要一致时 URL 内容永不变化；否则（旧链接、未带版本）只短缓存。
            "cache-control": current
              ? "public, max-age=31536000, immutable"
              : "public, max-age=300",
            "x-content-type-options": "nosniff",
          },
        });
      },
      { detail: { hide: true } }
    );
};
