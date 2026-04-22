import { Elysia } from "elysia";

import { RoomService } from "../application/room-service";
import type { AppEnv } from "../config/env";
import type { VersionInfo } from "../config/version";
import { isAppError } from "../domain/errors";
import { describeError, EventLogger } from "../infrastructure/event-logger";
import { buildOpenApiDocument, renderOpenApiHtml } from "./openapi";
import { createAck, createErrorPacket, parseClientMessage } from "./protocol";

export interface AppDependencies {
  env: AppEnv;
  roomService: RoomService;
  versionInfo: VersionInfo;
  logger: EventLogger;
}

export const createApp = ({ env, roomService, versionInfo, logger }: AppDependencies) => {
  // ==================== HTTP / WebSocket 入口 ====================

  const openApiDocument = buildOpenApiDocument({
    serverUrl: env.serverUrl,
    versionInfo,
  });
  const decoder = new TextDecoder();

  const app = new Elysia()
    .onAfterHandle(({ set }) => {
      set.headers["access-control-allow-origin"] = env.clientUrl;
      set.headers["access-control-allow-headers"] = "content-type";
      set.headers["access-control-allow-methods"] = "GET,OPTIONS";
      set.headers["access-control-allow-credentials"] = "true";
    })
    .options("/openapi", () => new Response(null, { status: 204 }))
    .options("/openapi/json", () => new Response(null, { status: 204 }))
    .get("/health", () => ({
      status: "ok",
      ...roomService.getHealthSnapshot(),
    }))
    .get("/version", () => versionInfo)
    .get("/openapi/json", () => openApiDocument)
    .get(
      "/openapi",
      () =>
        new Response(renderOpenApiHtml(openApiDocument), {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
        }),
    )
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
    openApiDocument,
  };
};
