import { Elysia, t } from "elysia";
import { safeEqualToken } from "../../domain/Rules";

import type { WhoIsFakerService } from "../../application/WhoIsFakerService";
import type { SonGuessrService } from "../../application/SonGuessrService";
import type { CCBService } from "../../application/CCBService";
import { redactData, sanitizeLogText, type EventLogger } from "../../infrastructure/EventLogger";
import { SlidingWindowRateLimiter } from "../../infrastructure/RateLimiter";

export class TelemetryRateLimiter {
  private readonly ipLimiter: SlidingWindowRateLimiter;
  private readonly globalLimiter: SlidingWindowRateLimiter;

  constructor(options: {
    ipMaxRequests?: number;
    globalMaxRequests?: number;
    windowMs?: number;
  } = {}) {
    this.ipLimiter = new SlidingWindowRateLimiter({
      windowMs: options.windowMs ?? 60_000,
      maxRequests: options.ipMaxRequests ?? 60,
    });
    this.globalLimiter = new SlidingWindowRateLimiter({
      windowMs: options.windowMs ?? 60_000,
      maxRequests: options.globalMaxRequests ?? 1000,
    });
  }

  public allow(ip: string, now = Date.now()): boolean {
    if (!this.globalLimiter.allow("__global__", now)) {
      return false;
    }
    return this.ipLimiter.allow(ip, now);
  }

  public reset(): void {
    this.ipLimiter.reset();
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
  ccbService?: CCBService;
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
  ccbService,
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
        // 真实 peer 是来源预算的唯一身份；自报 XFF/X-Real-IP 只可作非授权展示。
        const clientIp = server?.requestIP(request)?.address ?? "unknown";

        if (!limiter.allow(clientIp)) {
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
      async ({ status }) => {
        if (isShuttingDown?.()) {
          return status(503, {
            status: "shutting_down" as const,
            ready: false,
          });
        }

        const storageOk = fakerService ? await fakerService.checkStorageReadiness() : true;
        if (!storageOk) {
          return status(503, {
            status: "storage_degraded" as const,
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
          description: "检测持久化依赖就绪度与进程停机标志，未就绪或停机中返回 503 触发摘流。",
        },
        response: {
          200: t.Object({ status: t.Literal("ok"), ready: t.Literal(true) }),
          503: t.Object({ status: t.Union([t.Literal("shutting_down"), t.Literal("storage_degraded")]), ready: t.Literal(false) }),
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

        const ccbHealth = ccbService?.getHealthSnapshot() ?? { roomCount: 0, connectionCount: 0, onlinePlayerCount: 0 };
        return {
          status: "ok" as const,
          roomCount: fakerHealth.roomCount + sonHealth.roomCount + ccbHealth.roomCount,
          connectionCount:
            fakerHealth.connectionCount + sonHealth.connectionCount + ccbHealth.connectionCount,
          onlinePlayerCount:
            fakerHealth.onlinePlayerCount + sonHealth.onlinePlayerCount + ccbHealth.onlinePlayerCount,
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
        ccbService?.notifyShutdown();

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
