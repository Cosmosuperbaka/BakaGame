import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";

import { RoomService } from "../application/RoomService";
import { SonGuessrService, type SongGuessrService } from "../application/SonGuessrService";
import type { AppEnv } from "../config/Env";
import { isAppError } from "../domain/Errors";
import { describeError, EventLogger } from "../infrastructure/EventLogger";
import { NeteaseMusicProvider } from "../infrastructure/NeteaseMusicProvider";
import { LRUCache } from "lru-cache";

import { createSwaggerPlugin } from "./Openapi";
import { createAck, createErrorPacket, parseClientMessage } from "./Protocol";
import { parseSonGuessrMessage, parseSongGuessrMessage } from "./SonGuessrProtocol";
import { createStateSyncSender } from "./StateSync";
import { systemRoutes } from "./routes/System";

export interface AppDependencies {
  env: AppEnv;
  roomService: RoomService;
  logger: EventLogger;
  songGuessrService?: SonGuessrService | SongGuessrService;
  sonGuessrService?: SonGuessrService;
}

const messageAckCache = new LRUCache<string, object>({
  max: 2048,
  ttl: 15_000,
});
const inFlightMessages = new Set<string>();

const sendPacket = (
  ws: { send: (data: string) => unknown },
  payload: unknown,
) => {
  ws.send(JSON.stringify(payload));
};

const isAllowedOrigin = (
  origin: string | null | undefined,
  clientUrl?: string,
): boolean => {
  if (!origin) return true;
  if (!clientUrl) return true;
  try {
    const originUrl = new URL(origin);
    const allowedUrl = new URL(clientUrl);
    if (originUrl.origin === allowedUrl.origin) return true;
    if (
      (originUrl.hostname === "localhost" || originUrl.hostname === "127.0.0.1") &&
      (allowedUrl.hostname === "localhost" || allowedUrl.hostname === "127.0.0.1")
    ) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
};

export const createApp = ({ env, roomService, logger, songGuessrService, sonGuessrService }: AppDependencies) => {
  const decoder = new TextDecoder();
  const songService =
    sonGuessrService ??
    songGuessrService ??
    new SonGuessrService({
      eventLogger: logger,
      musicProvider: new NeteaseMusicProvider(),
    });

  const app = new Elysia({
    websocket: {
      // 部分 iOS WebKit 版本会在 permessage-deflate 协商后立即断开连接。
      // Bun 的协商配置是服务器级别，无法按 UA 稳定切换，因此全局关闭压缩。
      perMessageDeflate: false,
    },
  })
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
    .use(systemRoutes({ roomService, sonGuessrService: songService }))
    // ==================== WebSocket 入口 ====================
    .ws("/api/whoisfaker/ws", {
      upgrade({ headers, request }) {
        const origin =
          request?.headers?.get("origin") ??
          (headers as Record<string, string> | undefined)?.["origin"];
        if (!isAllowedOrigin(origin, env.clientUrl)) {
          return { status: 403 };
        }
      },
      open(ws) {
        // 为每个连接建立独立的连接上下文，后续所有命令都靠它定位会话。
        const connectionId = crypto.randomUUID();
        (ws.data as { connectionId?: string }).connectionId = connectionId;
        const stateSync = createStateSyncSender((payload) => {
          sendPacket(ws, payload);
        });
        roomService.registerConnection({
          id: connectionId,
          lobbySubscribed: false,
          send: stateSync.send,
          resetStateSync: stateSync.reset,
          sendStateSyncCalibration: stateSync.calibrate,
          sendPacket: (payload) => sendPacket(ws, payload),
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

          if (messageAckCache.has(parsedId)) {
            sendPacket(ws, createAck(parsed, messageAckCache.get(parsedId)));
            return;
          }
          if (inFlightMessages.has(parsedId)) {
            return;
          }
          inFlightMessages.add(parsedId);

          let payload: unknown;
          try {
            payload = await roomService.execute(connectionId, parsed);
          } finally {
            inFlightMessages.delete(parsedId);
          }

          messageAckCache.set(parsedId, (payload as object) ?? {});
          const durationMs = performance.now() - startTime;
          logger.logOperation({
            status: 200,
            durationMs,
            identifier: connectionId,
            action: `WS ${parsedType}`,
          });
          sendPacket(ws, createAck(parsed, payload));
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
            sendPacket(
              ws,
              createErrorPacket(parsedId, error.code, error.message, error.details),
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
          sendPacket(
            ws,
            createErrorPacket(parsedId, "INTERNAL_ERROR", "服务器内部错误"),
          );
        }
      },
      async close(ws) {
        const connectionId = (ws.data as { connectionId?: string }).connectionId;

        if (connectionId) {
          await roomService.unregisterConnection(connectionId);
        }
      },
    })
    // Songuessr 与 Who is Faker 共用相同封包、错误与会话约定，但状态机彼此隔离。
    .ws("/api/songuessr/ws", {
      upgrade({ headers, request }) {
        const origin =
          request?.headers?.get("origin") ??
          (headers as Record<string, string> | undefined)?.["origin"];
        if (!isAllowedOrigin(origin, env.clientUrl)) {
          return { status: 403 };
        }
      },
      open(ws) {
        const connectionId = crypto.randomUUID();
        (ws.data as { connectionId?: string }).connectionId = connectionId;
        const stateSync = createStateSyncSender((payload) => {
          sendPacket(ws, payload);
        });
        songService.registerConnection({
          id: connectionId,
          lobbySubscribed: false,
          send: stateSync.send,
          resetStateSync: stateSync.reset,
          sendStateSyncCalibration: stateSync.calibrate,
          sendPacket: (payload: unknown) => sendPacket(ws, payload),
          close: (code?: number, reason?: string) => ws.close(code, reason),
        });
      },
      async message(ws, incoming) {
        const connectionId = (ws.data as { connectionId?: string }).connectionId;
        if (!connectionId) return;

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

        const startedAt = performance.now();
        let parsedId = "unknown";
        let parsedType = "raw";
        try {
          const parsed = parseSongGuessrMessage(raw);
          parsedId = parsed.id;
          parsedType = parsed.type;

          if (messageAckCache.has(parsedId)) {
            sendPacket(ws, createAck(parsed, messageAckCache.get(parsedId)));
            return;
          }
          if (inFlightMessages.has(parsedId)) {
            return;
          }
          inFlightMessages.add(parsedId);

          let payload: unknown;
          try {
            payload = await songService.execute(connectionId, parsed);
          } finally {
            inFlightMessages.delete(parsedId);
          }

          messageAckCache.set(parsedId, (payload as object) ?? {});
          logger.logOperation({
            status: 200,
            durationMs: performance.now() - startedAt,
            identifier: connectionId,
            action: `WS ${parsedType}`,
          });
          sendPacket(ws, createAck(parsed, payload));
        } catch (error) {
          if (isAppError(error)) {
            logger.logOperation({
              status: 400,
              durationMs: performance.now() - startedAt,
              identifier: connectionId,
              action: `WS ${parsedType}`,
              level: "WARN",
            });
            sendPacket(
              ws,
              createErrorPacket(parsedId, error.code, error.message, error.details),
            );
            return;
          }
          logger.logOperation({
            status: 500,
            durationMs: performance.now() - startedAt,
            identifier: connectionId,
            action: `WS ${parsedType}`,
            level: "ERROR",
          });
          sendPacket(
            ws,
            createErrorPacket(parsedId, "INTERNAL_ERROR", "服务器内部错误"),
          );
        }
      },
      async close(ws) {
        const connectionId = (ws.data as { connectionId?: string }).connectionId;
        if (connectionId) await songService.unregisterConnection(connectionId);
      },
    });

  return {
    app,
    songGuessrService: songService,
    sonGuessrService: songService,
  };
};
