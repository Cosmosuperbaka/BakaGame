import { Elysia, t } from "elysia";
import { safeEqualToken } from "../../domain/Rules";

import type { WhoIsFakerService } from "../../application/WhoIsFakerService";
import type { SonGuessrService } from "../../application/SonGuessrService";
import type { CEEService } from "../../application/CEEService";
import { redactData, sanitizeLogText, type EventLogger } from "../../infrastructure/EventLogger";
import { SlidingWindowRateLimiter } from "../../infrastructure/RateLimiter";
import { resolveClientIp } from "../ClientIp";

/**
 * 打点上报的三层桶，口径与 Sentry 隧道一致：单客户端 / 回源 peer / 全局。
 * peer 桶只封顶伪造标头自造新桶的滥用路径，额度是单客户端的十倍。
 */
export class TelemetryRateLimiter {
  private readonly ipLimiter: SlidingWindowRateLimiter;
  private readonly peerLimiter: SlidingWindowRateLimiter;
  private readonly globalLimiter: SlidingWindowRateLimiter;

  constructor(options: {
    ipMaxRequests?: number;
    peerMaxRequests?: number;
    globalMaxRequests?: number;
    windowMs?: number;
  } = {}) {
    const windowMs = options.windowMs ?? 60_000;
    const ipMaxRequests = options.ipMaxRequests ?? 60;
    this.ipLimiter = new SlidingWindowRateLimiter({ windowMs, maxRequests: ipMaxRequests });
    this.peerLimiter = new SlidingWindowRateLimiter({
      windowMs,
      maxRequests: options.peerMaxRequests ?? ipMaxRequests * 10,
    });
    this.globalLimiter = new SlidingWindowRateLimiter({
      windowMs,
      maxRequests: options.globalMaxRequests ?? 1000,
    });
  }

  public allow(ip: string, peerIp = ip, now = Date.now()): boolean {
    if (!this.globalLimiter.allow("__global__", now)) {
      return false;
    }
    if (!this.peerLimiter.allow(peerIp, now)) {
      return false;
    }
    return this.ipLimiter.allow(ip, now);
  }

  public reset(): void {
    this.ipLimiter.reset();
    this.peerLimiter.reset();
    this.globalLimiter.reset();
  }
}

export const isPrivateLanHost = (rawHost: string): boolean => {
  const host = rawHost.replace(/^\[|\]$/g, "").replace(/:\d+$/, "").trim();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
};

export interface SystemRoutesDependencies {
  whoIsFakerService?: WhoIsFakerService;
  sonGuessrService?: SonGuessrService;
  ceeService?: CEEService;
  logger?: EventLogger;
  maintenanceToken?: string;
  isShuttingDown?: () => boolean;
  onTriggerShutdown?: () => Promise<void> | void;
  rateLimiter?: TelemetryRateLimiter;
  sampleRate?: number;
}

export const systemRoutes = ({
  whoIsFakerService,
  sonGuessrService,
  ceeService,
  logger,
  isShuttingDown,
  onTriggerShutdown,
  rateLimiter,
  maintenanceToken,
  sampleRate = 1.0,
}: SystemRoutesDependencies) => {
  const fakerService = whoIsFakerService;
  const songService = sonGuessrService;
  const limiter = rateLimiter ?? new TelemetryRateLimiter();

  const errorSchema = t.Object({ error: t.Object({ code: t.String(), message: t.String(), traceId: t.String() }) });
  return new Elysia({ name: "system", normalize: false })
    .guard({ response: { 400: errorSchema, 404: errorSchema, 422: errorSchema, 500: errorSchema } })
    .post(
      "/api/monitoring/telemetry",
      async ({ body, headers, set, request, server }) => {
        // 客户端身份取 ESA 托管转换写入的真实 IP 标头；缺失或非 IP 字面量时退回 peer，
        // peer 桶单独封顶，避免标头被伪造成无限个新桶。
        const peerIp = server?.requestIP(request)?.address ?? "unknown";
        const clientIp = resolveClientIp(request.headers, peerIp);

        if (!limiter.allow(clientIp, peerIp)) {
          set.status = 429;
          return { error: "Too Many Requests" };
        }

        const payload = body;

        const rawTrace =
          payload.traceId ??
          (typeof headers["x-trace-id"] === "string" ? headers["x-trace-id"] : undefined);
        const traceId = rawTrace ? sanitizeLogText(rawTrace, 64) : undefined;
        const level =
          payload.level?.toLowerCase() === "error"
            ? "ERROR"
            : payload.level?.toLowerCase() === "warn"
              ? "WARN"
              : "INFO";
        const message = sanitizeLogText(payload.message || "前端上报遥测事件", 500);

        // 白名单隔离：丢弃外部试图伪造系统连接/房间/玩家标识的字段
        const FORBIDDEN_KEYS = new Set(["connectionid", "roomid", "playerid", "ip", "identifier"]);
        const safeMetadata: Record<string, unknown> = {};
        if (payload.metadata && typeof payload.metadata === "object") {
          for (const [key, value] of Object.entries(payload.metadata)) {
            if (!FORBIDDEN_KEYS.has(key.toLowerCase())) {
              safeMetadata[key] = typeof value === "string" ? sanitizeLogText(value, 256) : value;
            }
          }
        }
        const sanitizedMeta = redactData(safeMetadata) as Record<string, unknown>;

        const isError = level === "ERROR";
        const shouldSample = isError || sampleRate >= 1.0 || Math.random() < sampleRate;

        if (logger && shouldSample) {
          const logContext = {
            source: "client_telemetry",
            traceId,
            ...sanitizedMeta,
          };
          if (level === "ERROR") {
            logger.error(`[CLIENT] ${message}`, logContext);
          } else if (level === "WARN") {
            logger.warn(`[CLIENT] ${message}`, logContext);
          } else {
            logger.info(`[CLIENT] ${message}`, logContext);
          }
        }

        return { ok: true };
      },
      {
        detail: {
          tags: ["System"],
          summary: "前端可观测性遥测打点代理",
          description: "接收前端报错与监控数据，服务端统一脱敏并中转至观测平台，保障安全与国内免翻直连。",
        },
        body: t.Object(
          {
            traceId: t.Optional(t.String({ maxLength: 64, pattern: "^[a-zA-Z0-9_.-]+$" })),
            level: t.Optional(
              t.Union([
                t.Literal("info"),
                t.Literal("warn"),
                t.Literal("error"),
                t.Literal("INFO"),
                t.Literal("WARN"),
                t.Literal("ERROR"),
              ]),
            ),
            message: t.Optional(t.String({ maxLength: 500 })),
            metadata: t.Optional(
              t.Record(
                t.String({ maxLength: 32, pattern: "^[a-zA-Z0-9_.-]+$" }),
                t.Union([
                  t.String({ maxLength: 256 }),
                  t.Number(),
                  t.Boolean(),
                  t.Null(),
                ]),
                { maxProperties: 16 },
              ),
            ),
          },
          { additionalProperties: false },
        ),
        response: {
          200: t.Object({ ok: t.Boolean() }),
          429: t.Object({ error: t.String() }),
        },
      },
    )
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
      },
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
          description: "检测进程停机标志，停机中返回 503 触发摘流。数据库只承载账号与后台数据，不参与就绪判定：游客游玩不依赖它。",
        },
        response: {
          200: t.Object({ status: t.Literal("ok"), ready: t.Literal(true) }),
          503: t.Object({ status: t.Literal("shutting_down"), ready: t.Literal(false) }),
        },
      },
    )
    .get(
      "/health",
      () => {
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

        const ceeHealth = ceeService?.getHealthSnapshot() ?? { roomCount: 0, connectionCount: 0, onlinePlayerCount: 0 };
        return {
          status: "ok" as const,
          roomCount: fakerHealth.roomCount + sonHealth.roomCount + ceeHealth.roomCount,
          connectionCount:
            fakerHealth.connectionCount + sonHealth.connectionCount + ceeHealth.connectionCount,
          onlinePlayerCount:
            fakerHealth.onlinePlayerCount + sonHealth.onlinePlayerCount + ceeHealth.onlinePlayerCount,
        };
      },
      {
        detail: {
          tags: ["System"],
          summary: "获取服务健康状态",
          description: "返回当前运行状况、房间数量、连接数和在线玩家数（聚合所有游戏模式）。",
        },
        response: t.Object({
          status: t.Literal("ok"),
          roomCount: t.Number({ description: "活跃房间总数" }),
          connectionCount: t.Number({ description: "当前连接总数" }),
          onlinePlayerCount: t.Number({ description: "在线玩家总数" }),
        }),
      },
    )
    .post(
      "/api/system/notify-shutdown",
      async ({ headers, set }) => {
        // 来源头不构成授权：反代和任意客户端均能提供它们。
        const bearer = headers.authorization?.startsWith("Bearer ") ? headers.authorization.slice(7) : undefined;
        if (!maintenanceToken || !bearer || !safeEqualToken(bearer, maintenanceToken)) {
          set.status = 403;
          return { error: "Forbidden: 运维接口需要维护凭据" };
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
          description: "向所有在线对局房间广播停机通知并摘除就绪状态，需要独立维护令牌授权，不信任客户端来源头。",
        },
        response: {
          200: t.Object({
            ok: t.Boolean(),
            message: t.String(),
          }),
          403: t.Object({
            error: t.String(),
          }),
        },
      },
    );
};
