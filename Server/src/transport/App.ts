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
import { createAck, createErrorPacket } from "./Packets";
import { parseWhoIsFakerMessage, parseClientMessage } from "./WhoIsFakerProtocol";
import { parseSonGuessrMessage, parseSongGuessrMessage } from "./SonGuessrProtocol";
import { createStateSyncSender } from "./StateSync";
import { systemRoutes } from "./routes/System";

export interface AppDependencies {
  env: AppEnv;
  roomService?: RoomService;
  whoIsFakerService?: RoomService;
  logger: EventLogger;
  songGuessrService?: SonGuessrService | SongGuessrService;
  sonGuessrService?: SonGuessrService;
  isShuttingDown?: () => boolean;
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

export const createApp = ({
  env,
  roomService,
  whoIsFakerService,
  logger,
  songGuessrService,
  sonGuessrService,
  isShuttingDown,
}: AppDependencies) => {
  const decoder = new TextDecoder();
  const fakerService = whoIsFakerService ?? roomService;
  if (!fakerService) {
    throw new Error("WhoIsFakerService (or roomService) dependency is required");
  }
  const songService =
    sonGuessrService ??
    songGuessrService ??
    new SonGuessrService({
      eventLogger: logger,
      musicProvider: new NeteaseMusicProvider({ logger }),
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
    // ==================== 原生耗时与链路追踪派生 ====================
    .derive(({ request }) => {
      const traceId =
        request?.headers?.get("x-trace-id") ??
        request?.headers?.get("x-request-id") ??
        crypto.randomUUID();
      return {
        traceId,
        startedAt: performance.now(),
      };
    })
    .onAfterHandle(({ request, path, set, startedAt, traceId }) => {
      if (set.headers) {
        set.headers["x-trace-id"] = traceId;
      }
      const durationMs = performance.now() - startedAt;
      logger.logOperation({
        status: set.status ? Number(set.status) : 200,
        durationMs,
        identifier: request.headers.get("x-forwarded-for") ?? "127.0.0.1",
        action: `HTTP ${request.method} ${path}`,
      });
    })
    // ==================== 全局错误生命周期处理 ====================
    .onError(({ code, error, set, path, request, startedAt, traceId }) => {
      if (set.headers && traceId) {
        set.headers["x-trace-id"] = traceId;
      }
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

      if (status >= 500) {
        logger.error(`HTTP 500 异常 [${path}]`, describeError(error));
      }

      return {
        error: {
          code: errCode,
          message: errMsg,
          traceId,
        },
      };
    })
    // ==================== 系统 HTTP 业务模块 ====================
    .use(
      systemRoutes({
        roomService: fakerService,
        whoIsFakerService: fakerService,
        sonGuessrService: songService,
        songGuessrService: songService,
        logger,
        isShuttingDown,
      }),
    )
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
        fakerService.registerConnection({
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
        let traceId: string | undefined;

        try {
          const parsed = parseWhoIsFakerMessage(raw);
          parsedId = parsed.id;
          parsedType = parsed.type;
          traceId = parsed.traceId;
          const dedupKey = `${connectionId}:${parsedId}`;

          if (messageAckCache.has(dedupKey)) {
            sendPacket(ws, createAck(parsed, messageAckCache.get(dedupKey)));
            return;
          }
          if (inFlightMessages.has(dedupKey)) {
            return;
          }
          inFlightMessages.add(dedupKey);

          let payload: unknown;
          try {
            payload = await fakerService.execute(connectionId, parsed);
          } finally {
            inFlightMessages.delete(dedupKey);
          }

          messageAckCache.set(dedupKey, (payload as object) ?? {});
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
              createErrorPacket(parsedId, error.code, error.message, error.details, traceId),
            );
            return;
          }

          logger.error(`WS 内部异常 [${parsedType}]`, {
            ...describeError(error),
            connectionId,
            traceId,
            parsedId,
          });

          logger.logOperation({
            status: 500,
            durationMs,
            identifier: connectionId,
            action: `WS ${parsedType}`,
            level: "ERROR",
          });
          sendPacket(
            ws,
            createErrorPacket(parsedId, "INTERNAL_ERROR", "服务器内部错误", undefined, traceId),
          );
        }
      },
      async close(ws) {
        const connectionId = (ws.data as { connectionId?: string }).connectionId;

        if (connectionId) {
          await fakerService.unregisterConnection(connectionId);
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
        let traceId: string | undefined;
        try {
          const parsed = parseSongGuessrMessage(raw);
          parsedId = parsed.id;
          parsedType = parsed.type;
          traceId = parsed.traceId;
          const dedupKey = `${connectionId}:${parsedId}`;

          if (messageAckCache.has(dedupKey)) {
            sendPacket(ws, createAck(parsed, messageAckCache.get(dedupKey)));
            return;
          }
          if (inFlightMessages.has(dedupKey)) {
            return;
          }
          inFlightMessages.add(dedupKey);

          let payload: unknown;
          try {
            payload = await songService.execute(connectionId, parsed);
          } finally {
            inFlightMessages.delete(dedupKey);
          }

          messageAckCache.set(dedupKey, (payload as object) ?? {});
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
              createErrorPacket(parsedId, error.code, error.message, error.details, traceId),
            );
            return;
          }

          logger.error(`SonGuessr WS 内部异常 [${parsedType}]`, {
            ...describeError(error),
            connectionId,
            traceId,
            parsedId,
          });

          logger.logOperation({
            status: 500,
            durationMs: performance.now() - startedAt,
            identifier: connectionId,
            action: `WS ${parsedType}`,
            level: "ERROR",
          });
          sendPacket(
            ws,
            createErrorPacket(parsedId, "INTERNAL_ERROR", "服务器内部错误", undefined, traceId),
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
    roomService: fakerService,
    whoIsFakerService: fakerService,
    songGuessrService: songService,
    sonGuessrService: songService,
  };
};
