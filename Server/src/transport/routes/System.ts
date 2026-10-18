import { Elysia, t } from "elysia";
import { safeEqualToken } from "../../domain/Rules";

import type { WhoIsFakerService } from "../../application/WhoIsFakerService";
import type { SonGuessrService } from "../../application/SonGuessrService";
import type { CEEService } from "../../application/CEEService";
import { redactData, sanitizeLogText, type EventLogger } from "../../infrastructure/EventLogger";
import { ThreeTierRateLimiter } from "../../infrastructure/RateLimiter";
import { httpError, rateLimitHeaders, traceIdOf } from "../HttpErrorEnvelope";
import { resolveClientIp } from "../ClientIp";

/**
 * 打点上报的三层桶（单客户端 / 回源 peer / 全局）就是通用口径本身，
 * 保留这个名字给账号入口与握手配额引用。
 */
export const TelemetryRateLimiter = ThreeTierRateLimiter;
export type TelemetryRateLimiter = ThreeTierRateLimiter;

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

const TELEMETRY_LOG_LEVELS: Record<"ERROR" | "WARN" | "INFO", "error" | "warn" | "info"> = {
  ERROR: "error",
  WARN: "warn",
  INFO: "info",
};

type TelemetryLevel = keyof typeof TELEMETRY_LOG_LEVELS;
type TelemetryMetadata = Record<string, unknown> | undefined;

// 白名单隔离：丢弃外部试图伪造系统连接/房间/玩家标识的字段
const FORBIDDEN_TELEMETRY_KEYS = new Set([
  "connectionid",
  "roomid",
  "playerid",
  "ip",
  "identifier",
]);

const resolveTelemetryLevel = (level?: string): TelemetryLevel => {
  const lowered = level?.toLowerCase();
  if (lowered === "error") return "ERROR";
  if (lowered === "warn") return "WARN";
  return "INFO";
};

const resolveTelemetryTraceId = (
  payloadTraceId?: string,
  traceHeader?: unknown
): string | undefined => {
  const rawTrace = payloadTraceId ?? (typeof traceHeader === "string" ? traceHeader : undefined);
  return rawTrace ? sanitizeLogText(rawTrace, 64) : undefined;
};

const sanitizeTelemetryMetadata = (metadata: TelemetryMetadata): Record<string, unknown> => {
  const safeMetadata: Record<string, unknown> = {};
  if (metadata && typeof metadata === "object") {
    for (const [key, value] of Object.entries(metadata)) {
      if (FORBIDDEN_TELEMETRY_KEYS.has(key.toLowerCase())) continue;
      safeMetadata[key] = typeof value === "string" ? sanitizeLogText(value, 256) : value;
    }
  }
  return redactData(safeMetadata) as Record<string, unknown>;
};

const shouldRecordTelemetry = (level: TelemetryLevel, sampleRate: number): boolean =>
  level === "ERROR" || sampleRate >= 1.0 || Math.random() < sampleRate;

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

const writeClientTelemetryLog = (input: {
  logger: EventLogger;
  level: TelemetryLevel;
  message: string;
  logContext: Record<string, unknown>;
}): void => {
  const headline = `[CLIENT] ${input.message}`;
  input.logger[TELEMETRY_LOG_LEVELS[input.level]](headline, input.logContext);
};

const sanitizeTelemetryMessage = (message?: string): string =>
  sanitizeLogText(message || "前端上报遥测事件", 500);

export interface SystemRoutesDependencies {
  whoIsFakerService?: WhoIsFakerService;
  sonGuessrService?: SonGuessrService;
  ceeService?: CEEService;
  logger?: EventLogger;
  maintenanceToken?: string;
  isShuttingDown?: () => boolean;
  onTriggerShutdown?: () => Promise<void> | void;
  rateLimiter?: TelemetryRateLimiter;
  /** 状态查询额度：独立于打点桶，避免前端批量上报把运维探活挤掉。测试可注入。 */
  probeRateLimiter?: TelemetryRateLimiter;
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
  probeRateLimiter,
  maintenanceToken,
  sampleRate = 1.0,
}: SystemRoutesDependencies) => {
  const fakerService = whoIsFakerService;
  const songService = sonGuessrService;
  const limiter = rateLimiter ?? new TelemetryRateLimiter();
  const probeLimiter =
    probeRateLimiter ??
    new TelemetryRateLimiter({
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
    .post(
      "/api/monitoring/telemetry",
      async ({ body, headers, set, request, server }) => {
        // 客户端身份取 ESA 托管转换写入的真实 IP 标头；缺失或非 IP 字面量时退回 peer，
        // peer 桶单独封顶，避免标头被伪造成无限个新桶。
        const peerIp = server?.requestIP(request)?.address ?? "unknown";
        const clientIp = resolveClientIp(request.headers, peerIp);

        const verdict = limiter.consume(clientIp, peerIp);
        Object.assign(set.headers, rateLimitHeaders(verdict));
        if (!verdict.allowed) {
          set.status = 429;
          return httpError("RATE_LIMITED", "打点上报过于频繁，请稍后重试", traceIdOf(set.headers));
        }

        const payload = body;
        const level = resolveTelemetryLevel(payload.level);
        const traceId = resolveTelemetryTraceId(payload.traceId, headers["x-trace-id"]);
        const message = sanitizeTelemetryMessage(payload.message);
        const sanitizedMeta = sanitizeTelemetryMetadata(payload.metadata);

        if (logger && shouldRecordTelemetry(level, sampleRate)) {
          writeClientTelemetryLog({
            logger,
            level,
            message,
            logContext: {
              source: "client_telemetry",
              traceId,
              ...sanitizedMeta,
            },
          });
        }

        return { ok: true };
      },
      {
        detail: {
          tags: ["System"],
          summary: "前端可观测性遥测打点代理",
          description:
            "接收前端报错与监控数据，服务端统一脱敏并中转至观测平台，保障安全与国内免翻直连。",
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
              ])
            ),
            message: t.Optional(t.String({ maxLength: 500 })),
            metadata: t.Optional(
              t.Record(
                t.String({ maxLength: 32, pattern: "^[a-zA-Z0-9_.-]+$" }),
                t.Union([t.String({ maxLength: 256 }), t.Number(), t.Boolean(), t.Null()]),
                { maxProperties: 16 }
              )
            ),
          },
          { additionalProperties: false }
        ),
        response: {
          200: t.Object({ ok: t.Boolean() }),
          429: errorSchema,
        },
      }
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
            "检测进程停机标志，停机中返回 503 触发摘流。数据库只承载账号与后台数据，不参与就绪判定：游客游玩不依赖它。",
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
            "返回运行状况、房间数量、连接数与在线玩家数（聚合所有游戏模式）。匿名调用只拿到一位有效数字的量级，携带维护凭据才回精确值；按来源地址限流。",
        },
        response: {
          200: t.Object({
            status: t.Literal("ok"),
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
