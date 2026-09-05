import { Elysia, t } from "elysia";

import type { RoomService } from "../../application/RoomService";
import type { SonGuessrService } from "../../application/SonGuessrService";
import { redactData, sanitizeLogText, type EventLogger } from "../../infrastructure/EventLogger";

export interface SystemRoutesDependencies {
  roomService?: RoomService;
  whoIsFakerService?: RoomService;
  sonGuessrService?: SonGuessrService;
  songGuessrService?: SonGuessrService;
  logger?: EventLogger;
  isShuttingDown?: () => boolean;
}

export const systemRoutes = ({
  roomService,
  whoIsFakerService,
  sonGuessrService,
  songGuessrService,
  logger,
  isShuttingDown,
}: SystemRoutesDependencies) => {
  const fakerService = whoIsFakerService ?? roomService;
  const songService = sonGuessrService ?? songGuessrService;
  return new Elysia({ name: "system" })
    .post(
      "/api/monitoring/telemetry",
      async ({ body, headers }) => {
        const payload = (body ?? {}) as {
          traceId?: string;
          level?: "info" | "warn" | "error" | "INFO" | "WARN" | "ERROR";
          message?: string;
          metadata?: Record<string, string | number | boolean | null>;
        };

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

        if (logger) {
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
        response: t.Object({
          ok: t.Boolean(),
        }),
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
      async ({ set }) => {
        if (isShuttingDown?.()) {
          set.status = 503;
          return {
            status: "shutting_down" as const,
            ready: false,
          };
        }

        const storageOk = fakerService ? await fakerService.checkStorageReadiness() : true;
        if (!storageOk) {
          set.status = 503;
          return {
            status: "storage_degraded" as const,
            ready: false,
          };
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

        return {
          status: "ok" as const,
          roomCount: fakerHealth.roomCount + sonHealth.roomCount,
          connectionCount: fakerHealth.connectionCount + sonHealth.connectionCount,
          onlinePlayerCount: fakerHealth.onlinePlayerCount + sonHealth.onlinePlayerCount,
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
    );
};
