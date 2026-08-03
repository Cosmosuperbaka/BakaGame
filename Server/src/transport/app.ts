import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";

import { RoomService } from "../application/room-service";
import type { AppEnv } from "../config/env";
import type { VersionInfo } from "../config/version";
import { isAppError } from "../domain/errors";
import { describeError, EventLogger } from "../infrastructure/event-logger";
import { createSwaggerPlugin } from "./openapi";
import { createAck, createErrorPacket, parseClientMessage } from "./protocol";
import { systemRoutes } from "./routes/system";

export interface AppDependencies {
  env: AppEnv;
  roomService: RoomService;
  versionInfo: VersionInfo;
  logger: EventLogger;
}

export const createApp = ({ env, roomService, versionInfo, logger }: AppDependencies) => {
  const decoder = new TextDecoder();

  const app = new Elysia()
    // ==================== 原生插件与全局中间件 ====================
    .use(
      cors({
        origin: env.clientUrl,
        allowedHeaders: ["content-type"],
        methods: ["GET", "OPTIONS"],
        credentials: true,
      }),
    )
    .use(
      createSwaggerPlugin({
        serverUrl: env.serverUrl,
        versionInfo,
      }),
    )
    // ==================== 原生耗时记录派生 ====================
    .derive(() => ({
      startedAt: performance.now(),
    }))
    .onAfterHandle(({ request, path, set, startedAt }) => {
      const durationMs = performance.now() - startedAt;
      logger.logOperation({
        status: set.status ? Number(set.status) : 200,
        durationMs,
        identifier: request.headers.get("x-forwarded-for") ?? "127.0.0.1",
        action: `HTTP ${request.method} ${path}`,
      });
    })
    // ==================== 全局错误生命周期处理 ====================
    .onError(({ code, error, set, path, request, startedAt }) => {
      const durationMs = startedAt ? performance.now() - startedAt : 0;
      let status = 500;
      let errCode = "INTERNAL_ERROR";
      let errMsg = "服务器内部错误";

      if (isAppError(error)) {
        status = 400;
        set.status = 400;
        errCode = error.code;
        errMsg = error.message;
      } else if (code === "NOT_FOUND") {
        status = 404;
        set.status = 404;
        errCode = "NOT_FOUND";
        errMsg = "请求资源不存在";
      } else {
        set.status = 500;
      }

      logger.logOperation({
        status,
        durationMs,
        identifier: request?.headers?.get("x-forwarded-for") ?? "127.0.0.1",
        action: `HTTP ${request?.method ?? "GET"} ${path}`,
        level: status >= 500 ? "ERROR" : "WARN",
      });

      return {
        error: {
          code: errCode,
          message: errMsg,
        },
      };
    })
    // ==================== 系统 HTTP 业务模块 ====================
    .use(systemRoutes({ roomService, versionInfo }))
    // ==================== WebSocket 入口 ====================
    .ws("/api/whoisfaker/ws", {
      open(ws) {
        // 为每个连接建立独立的连接上下文，后续所有命令都靠它定位会话。
        const connectionId = crypto.randomUUID();
        (ws.data as { connectionId?: string }).connectionId = connectionId;
        roomService.registerConnection({
          id: connectionId,
          lobbySubscribed: false,
          send: (payload) => {
            ws.send(JSON.stringify(payload));
          },
          close: (code?: number, reason?: string) => {
            ws.close(code, reason);
          },
        });
      },
      async message(ws, incoming) {
        const connectionId = (ws.data as { connectionId?: string }).connectionId;

        if (!connectionId) {
          return;
        }

        // Bun/Elysia 可能给字符串、二进制或已解析对象，这里统一归一化。
        const raw =
          typeof incoming === "string"
            ? incoming
            : incoming instanceof ArrayBuffer
              ? decoder.decode(new Uint8Array(incoming))
              : ArrayBuffer.isView(incoming)
                ? decoder.decode(
                    new Uint8Array(
                      incoming.buffer,
                      incoming.byteOffset,
                      incoming.byteLength,
                    ),
                  )
                : incoming;

        const startTime = performance.now();
        let parsedId = "unknown";
        let parsedType = "raw";

        try {
          const parsed = parseClientMessage(raw);
          parsedId = parsed.id;
          parsedType = parsed.type;
          const payload = await roomService.execute(connectionId, parsed);
          const durationMs = performance.now() - startTime;
          logger.logOperation({
            status: 200,
            durationMs,
            identifier: connectionId,
            action: `WS ${parsedType}`,
          });
          ws.send(JSON.stringify(createAck(parsed, payload)));
        } catch (error) {
          const durationMs = performance.now() - startTime;
          if (isAppError(error)) {
            logger.logOperation({
              status: 400,
              durationMs,
              identifier: connectionId,
              action: `WS ${parsedType}`,
              level: "WARN",
            });
            ws.send(
              JSON.stringify(
                createErrorPacket(parsedId, error.code, error.message, error.details),
              ),
            );
            return;
          }

          logger.logOperation({
            status: 500,
            durationMs,
            identifier: connectionId,
            action: `WS ${parsedType}`,
            level: "ERROR",
          });
          ws.send(
            JSON.stringify(
              createErrorPacket(parsedId, "INTERNAL_ERROR", "服务器内部错误"),
            ),
          );
        }
      },
      async close(ws) {
        const connectionId = (ws.data as { connectionId?: string }).connectionId;

        if (connectionId) {
          await roomService.unregisterConnection(connectionId);
        }
      },
    });

  return {
    app,
  };
};
