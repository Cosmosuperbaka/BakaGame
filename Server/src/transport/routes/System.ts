import { Elysia, t } from "elysia";
import { safeEqualToken } from "../../domain/Rules";

import type { WhoIsFakerService } from "../../application/WhoIsFakerService";
import type { SonGuessrService } from "../../application/SonGuessrService";
import type { CEEService } from "../../application/CEEService";
import { resolveDeploymentEnvironment } from "../../config/env/Observability";
import type { EventLogger } from "../../infrastructure/EventLogger";
import { ThreeTierRateLimiter } from "../../infrastructure/RateLimiter";
import { httpError, rateLimitHeaders, traceIdOf } from "../HttpErrorEnvelope";
import { resolveClientIp } from "../ClientIp";

export const isPrivateLanHost = (rawHost: string): boolean => {
  const host = rawHost
    .replace(/^\[|\]$/g, "")
    .replace(/:\d+$/, "")
    .trim();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
};

/**
 * 一位有效数字的量级：1234 → 1000、42 → 40、7 → 7。
 * 用于把「可无限轮询的精确在线数」降级成趋势可读、计数不可读。
 */
const coarse = (value: number): number => {
  if (value < 10) return value;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.round(value / magnitude) * magnitude;
};

/**
 * `/health` 的额度：三个探针里只有它带业务量级，`/livez` 与 `/readyz` 是负载均衡的契约，
 * 一旦限流就可能被扫爆导致 LB 拿不到就绪状态而摘流，所以那两个不设额度。
 */
const PROBE_WINDOW_MS = 60_000;
const PROBE_IP_MAX_REQUESTS = 120;
const PROBE_GLOBAL_MAX_REQUESTS = 6_000;

/**
 * 停机中新连接的拒绝码与文案：与 `/readyz` 的 503 同一语义，握手闸门与任何「新会话」入口共用，
 * 不在各处各写一份字符串。走 `throw AppError` 的调用方需要在 `statusOfAppError` 里把这个码映射成 503。
 */
export const SHUTDOWN_REJECT_CODE = "SERVICE_UNAVAILABLE";
export const SHUTDOWN_REJECT_MESSAGE = "服务正在停机，暂不接受新连接";

/**
 * 停机闸门：`/readyz` 回 503 只让上游停止分配新流量，进程内的新握手照样会完成升级，
 * 排空窗口因此永远等不到「没有新连接」的那一刻。
 * 这里把同一份停机状态转成可直接返回的响应：命中给 503 + 统一错误信封，未命中给 `undefined`
 * （正常运行与没有注入停机状态的独立挂载都必须放行，否则会把正常流量锁死）。
 */
export const shutdownRejection = (
  isShuttingDown?: () => boolean,
  traceId?: string
): Response | undefined => {
  if (!isShuttingDown?.()) return undefined;
  return new Response(
    JSON.stringify(httpError(SHUTDOWN_REJECT_CODE, SHUTDOWN_REJECT_MESSAGE, traceId)),
    {
      status: 503,
      headers: { "content-type": "application/json" },
    }
  );
};

export interface SystemRoutesDependencies {
  whoIsFakerService?: WhoIsFakerService;
  sonGuessrService?: SonGuessrService;
  ceeService?: CEEService;
  logger?: EventLogger;
  maintenanceToken?: string;
  isShuttingDown?: () => boolean;
  onTriggerShutdown?: () => Promise<void> | void;
  /** `/health` 的查询额度，测试可注入。 */
  probeRateLimiter?: ThreeTierRateLimiter;
}

export const systemRoutes = ({
  whoIsFakerService,
  sonGuessrService,
  ceeService,
  logger,
  isShuttingDown,
  onTriggerShutdown,
  probeRateLimiter,
  maintenanceToken,
}: SystemRoutesDependencies) => {
  const fakerService = whoIsFakerService;
  const songService = sonGuessrService;
  const probeLimiter =
    probeRateLimiter ??
    new ThreeTierRateLimiter({
      windowMs: PROBE_WINDOW_MS,
      ipMaxRequests: PROBE_IP_MAX_REQUESTS,
      globalMaxRequests: PROBE_GLOBAL_MAX_REQUESTS,
    });

  // `traceId` 由全局 `onRequest` 写入响应头，独立挂载本组路由的测试里可以没有，因此声明为可选。
  const errorSchema = t.Object({
    error: t.Object({ code: t.String(), message: t.String(), traceId: t.Optional(t.String()) }),
  });
  // 全组路由的失败响应共用同一份信封：状态码不同、形状相同，客户端不必按路由分支。
  return new Elysia({ name: "system", normalize: false })
    .guard({
      response: {
        400: errorSchema,
        403: errorSchema,
        404: errorSchema,
        422: errorSchema,
        429: errorSchema,
        500: errorSchema,
      },
    })
    .get(
      "/livez",
      () => ({
        status: "ok" as const,
      }),
      {
        detail: {
          tags: ["System"],
          summary: "K8s / 容器存活探针 (Liveness)",
          description: "只要服务进程正在运行且事件循环未死锁即返回 200。",
        },
        response: t.Object({
          status: t.Literal("ok"),
        }),
      }
    )
    .get(
      "/readyz",
      ({ status }) => {
        if (isShuttingDown?.()) {
          return status(503, {
            status: "shutting_down" as const,
            ready: false,
          });
        }

        return {
          status: "ok" as const,
          ready: true,
        };
      },
      {
        detail: {
          tags: ["System"],
          summary: "K8s / 反代就绪探针 (Readiness)",
          description:
            "检测进程停机标志，停机中返回 503 触发摘流；新 WebSocket 握手由同一份停机状态直接拒绝（shutdownRejection）。数据库只承载账号与后台数据，不参与就绪判定：游客游玩不依赖它。",
        },
        response: {
          200: t.Object({ status: t.Literal("ok"), ready: t.Literal(true) }),
          503: t.Object({ status: t.Literal("shutting_down"), ready: t.Literal(false) }),
        },
      }
    )
    .get(
      "/health",
      ({ headers, request, server, set }) => {
        const verdict = probeLimiter.consume(
          resolveClientIp(request.headers, server?.requestIP(request)?.address),
          server?.requestIP(request)?.address ?? "unknown"
        );
        Object.assign(set.headers, rateLimitHeaders(verdict));
        if (!verdict.allowed) {
          set.status = 429;
          return httpError("RATE_LIMITED", "状态查询过于频繁，请稍后重试", traceIdOf(set.headers));
        }

        const fakerHealth = fakerService?.getHealthSnapshot() ?? {
          roomCount: 0,
          connectionCount: 0,
          onlinePlayerCount: 0,
        };
        const sonHealth = songService?.getHealthSnapshot() ?? {
          roomCount: 0,
          connectionCount: 0,
          onlinePlayerCount: 0,
        };

        const ceeHealth = ceeService?.getHealthSnapshot() ?? {
          roomCount: 0,
          connectionCount: 0,
          onlinePlayerCount: 0,
        };
        const roomCount = fakerHealth.roomCount + sonHealth.roomCount + ceeHealth.roomCount;
        const connectionCount =
          fakerHealth.connectionCount + sonHealth.connectionCount + ceeHealth.connectionCount;
        const onlinePlayerCount =
          fakerHealth.onlinePlayerCount + sonHealth.onlinePlayerCount + ceeHealth.onlinePlayerCount;
        // 精确在线数是可被无限轮询的实时经营指标：匿名调用只给一位有效数字的量级，
        // 足够看趋势与「有没有人在玩」，但不构成随时可读的精确计数器。
        // 带维护凭据的调用（运维与探针脚本）拿精确值，口径与 notify-shutdown 一致。
        const exact =
          maintenanceToken !== undefined &&
          headers.authorization?.startsWith("Bearer ") === true &&
          safeEqualToken(headers.authorization.slice(7), maintenanceToken);
        return {
          status: "ok" as const,
          // 部署环境标记进健康快照：部署后（以及漏配排查时）可直接断言它，
          // 不必等到「心跳 missed 却分不清是停机还是没注入标记」才发现。
          environment: resolveDeploymentEnvironment(),
          roomCount: exact ? roomCount : coarse(roomCount),
          connectionCount: exact ? connectionCount : coarse(connectionCount),
          onlinePlayerCount: exact ? onlinePlayerCount : coarse(onlinePlayerCount),
        };
      },
      {
        detail: {
          tags: ["System"],
          summary: "获取服务健康状态",
          description:
            "返回运行状况、部署环境标记、房间数量、连接数与在线玩家数（聚合所有游戏模式）。匿名调用只拿到一位有效数字的量级，携带维护凭据才回精确值；按来源地址限流。",
        },
        response: {
          200: t.Object({
            status: t.Literal("ok"),
            environment: t.String({ description: "部署环境标记，供部署后断言环境变量注入正确" }),
            roomCount: t.Number({ description: "活跃房间总数（匿名为量级近似值）" }),
            connectionCount: t.Number({ description: "当前连接总数（匿名为量级近似值）" }),
            onlinePlayerCount: t.Number({ description: "在线玩家总数（匿名为量级近似值）" }),
          }),
          429: errorSchema,
        },
      }
    )
    .post(
      "/api/system/notify-shutdown",
      async ({ headers, set }) => {
        // 来源头不构成授权：反代和任意客户端均能提供它们。
        const bearer = headers.authorization?.startsWith("Bearer ")
          ? headers.authorization.slice(7)
          : undefined;
        if (!maintenanceToken || !bearer || !safeEqualToken(bearer, maintenanceToken)) {
          set.status = 403;
          return httpError("FORBIDDEN", "运维接口需要维护凭据", traceIdOf(set.headers));
        }

        fakerService?.notifyShutdown();
        songService?.notifyShutdown();
        ceeService?.notifyShutdown();

        if (onTriggerShutdown) {
          await onTriggerShutdown();
        }

        logger?.warn("收到停机维护广播请求，已向所有房间广播通知并标记服务停机");

        return {
          ok: true,
          message: "停机通知已向所有房间广播",
        };
      },
      {
        detail: {
          tags: ["System"],
          summary: "广播停机维护通知",
          description:
            "向所有在线对局房间广播停机通知并摘除就绪状态，需要独立维护令牌授权，不信任客户端来源头。",
        },
        response: {
          200: t.Object({
            ok: t.Boolean(),
            message: t.String(),
          }),
          403: errorSchema,
        },
      }
    );
};
