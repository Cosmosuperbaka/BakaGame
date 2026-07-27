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
    // ==================== 全局错误生命周期处理 ====================
    .onError(({ code, error, set, path }) => {
      if (isAppError(error)) {
        logger.warn("HTTP 请求发生业务异常", {
          path,
          code: error.code,
          errorMessage: error.message,
        });
        set.status = 400;
        return {
          error: {
            code: error.code,
            message: error.message,
            details: error.details,
          },
        };
      }

      if (code === "NOT_FOUND") {
        set.status = 404;
        return {
          error: {
            code: "NOT_FOUND",
            message: "请求资源不存在",
          },
        };
      }

      logger.error("HTTP 请求发生未捕获异常", {
        path,
        ...describeError(error),
      });
      set.status = 500;
      return {
        error: {
          code: "INTERNAL_ERROR",
          message: "服务器内部错误",
        },
      };
    })
    // ==================== 系统 HTTP 业务模块 ====================
    .use(systemRoutes({ roomService, versionInfo }))
    // ==================== WebSocket 入口 ====================
    .ws("/ws", {
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

        let parsedId = "unknown";

        try {
          const parsed = parseClientMessage(raw);
          parsedId = parsed.id;
          const payload = await roomService.execute(connectionId, parsed);
          ws.send(JSON.stringify(createAck(parsed, payload)));
        } catch (error) {
          if (isAppError(error)) {
            logger.warn("WebSocket 请求返回业务错误", {
              connectionId,
              requestId: parsedId,
              code: error.code,
              errorMessage: error.message,
            });
            ws.send(
              JSON.stringify(
                createErrorPacket(parsedId, error.code, error.message, error.details),
              ),
            );
            return;
          }

          logger.error("WebSocket 请求发生未捕获异常", {
            connectionId,
            requestId: parsedId,
            ...describeError(error),
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
