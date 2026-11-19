import { cors } from "@elysiajs/cors";
import { Elysia, ValidationError } from "elysia";

import type { AppEnv } from "../config/Env";
import { AppError, isAppError } from "../domain/Errors";
import { describeError, type EventLogger, sanitizeLogText } from "../infrastructure/EventLogger";
import { countServerMetric } from "../infrastructure/Sentry";
import { resolveClientIp } from "./ClientIp";
import { httpError, traceIdOf } from "./HttpErrorEnvelope";
import {
  compileRouteTemplates,
  httpOperationAction,
  UNROUTED_HTTP_ACTION,
  type RouteTemplate,
} from "./HttpOperation";
import { isAllowedOrigin } from "./Origin";
import { createOpenapiPlugin } from "./Openapi";
import { resolveRequestTraceId } from "./RequestTraceId";
import { statusOfAppError } from "./routes/Account";
import { shutdownRejection } from "./routes/System";
import { securityHeaders } from "./SecurityHeaders";
import { isValidHandshakeHeaders } from "./ws/Handshake";

export interface GlobalMiddlewareOptions {
  env: AppEnv;
  logger: EventLogger;
  isShuttingDown?: () => boolean;
  /** 最终实例的路由表：操作日志的模板索引要等全部路由挂完才能编译，所以经取值函数惰性读取。 */
  getRoutes: () => readonly { method: string; path: string }[];
}

/**
 * 全局中间件链：追踪号与安全头、WebSocket 升级闸门、跨域、文档页、操作日志、错误信封、响应头补齐。
 *
 * 框架的插件内钩子默认只作用于插件自身，挂在这里的每一个钩子必须显式声明全局作用域
 * （末尾的 `.as("global")`），否则中间件会悄悄对别的路由失效；`test/TransportMiddleware.test.ts`
 * 按路由类别逐格守着这一点。
 */
export const globalMiddleware = ({
  env,
  logger,
  isShuttingDown,
  getRoutes,
}: GlobalMiddlewareOptions) => {
  const requests = new WeakMap<Request, { traceId: string; startedAt: number; clientIp: string }>();
  // 路由表在应用装配完成时定形，模板索引到首个请求才惰性编译一次。
  let routeTemplates: readonly RouteTemplate[] | undefined;
  return (
    new Elysia({ name: "global-middleware" })
      .onRequest(({ request, set, server }) => {
        const traceId = sanitizeLogText(resolveRequestTraceId(request.headers), 128);
        // 边缘反代后 socket peer 恒为边缘节点地址：日志里的来源身份必须取真实 IP 标头，
        // 否则每条 HTTP 操作日志都记成同一个节点地址，按来源排查就失效了。
        const clientIp = resolveClientIp(request.headers, server?.requestIP(request)?.address);
        requests.set(request, { traceId, startedAt: performance.now(), clientIp });
        Object.assign(set.headers, securityHeaders(request));
        set.headers["x-trace-id"] = traceId;
      })
      // ==================== WebSocket 升级的 Origin 白名单（防跨站 WebSocket 劫持） ====================
      // 必须拦在 HTTP 层：`.ws()` 的 `upgrade` 钩子**返回值会被 Elysia 忽略**
      // （1.4.29 / 1.4.30 实测：返回 `{ status: 403 }` 或 `new Response(403)` 都拦不住，
      // 任意 Origin 照样 101 完成握手）。WebSocket 不受浏览器同源策略约束，
      // 这道闸门是唯一防线 —— 改动前请跑 App.test.ts 里「按 Origin 白名单拦截」那条用例。
      .onRequest(({ request, set }) => {
        if (request.headers.get("upgrade") !== "websocket") return;
        const { pathname } = new URL(request.url);
        if (!pathname.endsWith("/ws")) return;
        // 停机中直接拒新握手：摘流只挡住「新流量分配」，进程内照样会 101，排空窗口等不到「没有新连接」。
        // 判在 Origin 与握手配额之前：拒绝不消耗配额桶，也不给来源探测留可分辨的差异。
        const rejection = shutdownRejection(isShuttingDown, traceIdOf(set.headers));
        if (rejection) return rejection;
        const origin = request.headers.get("origin");
        // 不带 Origin 的只可能是非浏览器客户端（MCP 进程、本地工具）：Origin 防的是浏览器被第三方页面
        // 借用，而浏览器的跨站升级一定带 Origin，非浏览器客户端本来就能随意伪造它，所以空值放行。
        // 计数留作证据：哪天要收紧，先看这条指标有多少合法流量。
        if (!origin) countServerMetric("bakagame.ws.origin_missing", 1);
        else if (!isAllowedOrigin(origin, env.clientUrl))
          throw new AppError("FORBIDDEN_ORIGIN", "来源不被允许");
        // 缺握手必需头的升级运行时一定会拒，但它会先进入 upgrade 钩子：在这里直接回 400，不进钩子。
        if (!isValidHandshakeHeaders(request.headers))
          return new Response(
            JSON.stringify(
              httpError("INVALID_HANDSHAKE", "WebSocket 握手头不合法", traceIdOf(set.headers))
            ),
            { status: 400, headers: { "content-type": "application/json" } }
          );
      })
      // ==================== 原生插件与全局中间件 ====================
      .use(
        cors({
          origin: (req: Request) => isAllowedOrigin(req?.headers?.get("origin"), env.clientUrl),
          allowedHeaders: [
            "content-type",
            "x-trace-id",
            "accept",
            "authorization",
            "mcp-session-id",
            "mcp-protocol-version",
            "mcp-method",
            "mcp-name",
          ],
          exposeHeaders: [
            "mcp-session-id",
            "mcp-protocol-version",
            "x-trace-id",
            "retry-after",
            "ratelimit-limit",
            "ratelimit-remaining",
            "ratelimit-reset",
          ],
          methods: ["GET", "POST", "DELETE", "OPTIONS"],
          credentials: true,
        })
      )
      .use(
        createOpenapiPlugin({
          serverUrl: env.serverUrl,
          enabled: env.openapiEnabled,
          onUnavailable: (error) =>
            logger.warn("接口文档插件加载失败，文档页未挂载", describeError(error)),
        })
      )
      // ==================== 操作日志 ====================
      .onAfterResponse(({ request, response, set }) => {
        const context = requests.get(request);
        if (!context) return;
        const statusCode =
          response instanceof Response ? response.status : Number(set.status ?? 200);
        const action = httpOperationAction(
          (routeTemplates ??= compileRouteTemplates(getRoutes())),
          request.method,
          new URL(request.url).pathname
        );
        logger.logOperation({
          status: statusCode,
          durationMs: performance.now() - context.startedAt,
          identifier: context.clientIp,
          action,
          traceId: context.traceId,
          // 级别由状态码口径决定；互联网扫描命中的未注册路径是背景噪音，只留指标计数。
          ...(action === UNROUTED_HTTP_ACTION && statusCode === 404
            ? { level: "DEBUG" as const }
            : {}),
        });
      })
      .onError(({ code, error, set, path, request }) => {
        const traceId = requests.get(request)?.traceId ?? crypto.randomUUID();
        set.headers["x-trace-id"] = traceId;
        let statusCode = 500;
        let errorCode = "INTERNAL_ERROR";
        let message = "服务器内部错误";
        if (isAppError(error)) {
          statusCode = statusOfAppError(error.code);
          errorCode = error.code;
          message = error.message;
        } else if (code === "PARSE") {
          statusCode = 400;
          errorCode = "INVALID_JSON";
          message = "请求必须为合法 JSON";
        } else if (
          String(code) === "VALIDATION" &&
          (!(error instanceof ValidationError) || error.type !== "response")
        ) {
          statusCode = 422;
          errorCode = "VALIDATION_ERROR";
          message = "请求载荷格式错误";
        } else if (code === "NOT_FOUND") {
          statusCode = 404;
          errorCode = "NOT_FOUND";
          message = "请求资源不存在";
        }
        set.status = statusCode;
        if (statusCode >= 500)
          logger.error(`HTTP 500 异常 [${path}]`, { ...describeError(error), traceId });
        return { error: { code: errorCode, message, traceId } };
      })
      // 自建 `Response` 与第三方 handler 的响应（Better Auth、oRPC、头像代理）不经过 `set.headers` 这一层，
      // 追踪号会在出口丢失：日志里有 traceId，客户端却拿不到，报障时无法对上同一次请求。
      // 这里按缺失补齐已有响应头，不改状态码与 body。
      // Elysia 1.4.30 把 mapResponse 的 `undefined` 产出当成「响应就是这个 undefined」，
      // 而全局 `onError` 的信封恰好经过本钩子：返回 undefined 等于把 4xx/5xx 的响应体抹成空串，
      // 状态码还在、错误形状却没了。所以每个分支都必须显式把原值返回。
      .mapResponse(({ set, responseValue }) => {
        if (!(responseValue instanceof Response)) return responseValue as Response;
        const missing: [string, string][] = [];
        for (const [key, value] of Object.entries(set.headers)) {
          if (value !== undefined && !responseValue.headers.has(key))
            missing.push([key, String(value)]);
        }
        if (missing.length === 0) return responseValue;
        // `fetch` 透传的响应头是只读的，原地 set 会抛，所以连同原头一起复制一份再补。
        const headers = new Headers(responseValue.headers);
        for (const [key, value] of missing) headers.set(key, value);
        return new Response(responseValue.body, {
          status: responseValue.status,
          statusText: responseValue.statusText,
          headers,
        });
      })
      .as("global")
  );
};
