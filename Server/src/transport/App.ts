import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";

import { RoomService } from "../application/RoomService";
import { SonGuessrService } from "../application/SonGuessrService";
import type { AppEnv } from "../config/Env";
import { isAppError } from "../domain/Errors";
import { describeError, EventLogger } from "../infrastructure/EventLogger";
import { NeteaseMusicProvider } from "../infrastructure/NeteaseMusicProvider";
import { LRUCache } from "lru-cache";

import { createSwaggerPlugin } from "./Openapi";
import { createAck, createErrorPacket } from "./Packets";
import { parseWhoIsFakerMessage } from "./WhoIsFakerProtocol";
import { parseSonGuessrMessage } from "./SonGuessrProtocol";
import { createStateSyncSender } from "./StateSync";
import { systemRoutes } from "./routes/System";

export interface AppDependencies {
  env: AppEnv;
  whoIsFakerService: RoomService;
  logger: EventLogger;
  sonGuessrService?: SonGuessrService;
  isShuttingDown?: () => boolean;
}

const messageAckCache = new LRUCache<string, object>({
  max: 2048,
  ttl: 15_000,
});
type InFlightOutcome =
  | { success: true; payload: unknown }
  | { success: false; error: unknown };

const inFlightOperations = new Map<string, Promise<InFlightOutcome>>();

const sendPacket = (
  ws: { send: (data: string) => unknown },
  payload: unknown,
) => {
  ws.send(JSON.stringify(payload));
};

const executeWithDeduplication = async ({
  ws,
  connectionId,
  parsed,
  startTime,
  logger,
  execute,
  serviceName,
}: {
  ws: { send: (data: string) => unknown };
  connectionId: string;
  parsed: { id: string; type: string; traceId?: string };
  startTime: number;
  logger: EventLogger;
  execute: () => Promise<unknown>;
  serviceName?: string;
}) => {
  const parsedId = parsed.id;
  const parsedType = parsed.type;
  const traceId = parsed.traceId;
  const dedupKey = `${connectionId}:${parsedId}`;

  // 1. 已有完成缓存：直接回放 ACK
  if (messageAckCache.has(dedupKey)) {
    sendPacket(ws, createAck(parsed, messageAckCache.get(dedupKey)));
    return;
  }

  // 2. 正在飞行中：等待其结果并回放响应，避免网络重传被静默丢弃
  const inFlight = inFlightOperations.get(dedupKey);
  if (inFlight) {
    const outcome = await inFlight;
    const durationMs = performance.now() - startTime;
    if (outcome.success) {
      logger.logOperation({
        status: 200,
        durationMs,
        identifier: connectionId,
        action: `WS ${parsedType} (replay)`,
      });
      sendPacket(ws, createAck(parsed, outcome.payload));
    } else if (isAppError(outcome.error)) {
      logger.logOperation({
        status: 400,
        durationMs,
        identifier: connectionId,
        action: `WS ${parsedType} (replay)`,
        level: "WARN",
      });
      sendPacket(
        ws,
        createErrorPacket(parsedId, outcome.error.code, outcome.error.message, outcome.error.details, traceId),
      );
    } else {
      logger.logOperation({
        status: 500,
        durationMs,
        identifier: connectionId,
        action: `WS ${parsedType} (replay)`,
        level: "ERROR",
      });
      sendPacket(
        ws,
        createErrorPacket(parsedId, "INTERNAL_ERROR", "服务器内部错误", undefined, traceId),
      );
    }
    return;
  }

  // 3. 首次执行：启动执行并缓存 Promise
  const executePromise = (async (): Promise<InFlightOutcome> => {
    try {
      const payload = await execute();
      return { success: true, payload };
    } catch (error) {
      return { success: false, error };
    }
  })();

  inFlightOperations.set(dedupKey, executePromise);
  let outcome: InFlightOutcome;
  try {
    outcome = await executePromise;
  } finally {
    inFlightOperations.delete(dedupKey);
  }

  const durationMs = performance.now() - startTime;
  if (outcome.success) {
    messageAckCache.set(dedupKey, (outcome.payload as object) ?? {});
    logger.logOperation({
      status: 200,
      durationMs,
      identifier: connectionId,
      action: `WS ${parsedType}`,
    });
    sendPacket(ws, createAck(parsed, outcome.payload));
  } else {
    const error = outcome.error;
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

    const logPrefix = serviceName ? `${serviceName} ` : "";
    logger.error(`${logPrefix}WS 内部异常 [${parsedType}]`, {
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
};

const isPrivateLanHost = (hostname: string): boolean => {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  return false;
};

const isAllowedOrigin = (
  origin: string | null | undefined,
  clientUrl?: string,
): boolean => {
  if (!origin) return true;
  if (!clientUrl) return true;
  try {
    const originUrl = new URL(origin);
    const allowedUrls = clientUrl
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    for (const rawAllowed of allowedUrls) {
      try {
        const allowedUrl = new URL(rawAllowed);
        if (originUrl.origin === allowedUrl.origin) return true;
        if (
          isPrivateLanHost(originUrl.hostname) &&
          isPrivateLanHost(allowedUrl.hostname)
        ) {
          return true;
        }
      } catch {
        // 忽略单项解析异常
      }
    }
  } catch {
    return false;
  }
  return false;
};

export const createApp = ({
  env,
  whoIsFakerService,
  logger,
  sonGuessrService,
  isShuttingDown,
}: AppDependencies) => {
  const decoder = new TextDecoder();
  const fakerService = whoIsFakerService;
  if (!fakerService) {
    throw new Error("WhoIsFakerService dependency is required");
  }
  const songService =
    sonGuessrService ??
    new SonGuessrService({
      eventLogger: logger,
      musicProvider: new NeteaseMusicProvider({ logger }),
    });

  const app = new Elysia({
    websocket: {
      // 部分 iOS WebKit 版本会在 permessage-deflate 协商后立即断开连接。
      // Bun 的协商配置是服务器级别，无法按 UA 稳定切换，因此全局关闭压缩。
      perMessageDeflate: false,
      // 限制单帧最大载荷 256KB，防止恶意外溢 OOM
      maxPayloadLength: 256 * 1024,
    },
  })
    // ==================== 原生插件与全局中间件 ====================
    .use(
      cors({
        origin: (req: Request) =>
          isAllowedOrigin(req?.headers?.get("origin"), env.clientUrl),
        allowedHeaders: ["content-type", "x-trace-id"],
        methods: ["GET", "POST", "OPTIONS"],
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
      } else if (String(code) === "VALIDATION") {
        status = 422;
        set.status = 422;
        errCode = "VALIDATION_ERROR";
        errMsg = (error as { message?: string })?.message ?? "请求载荷格式错误";
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
        whoIsFakerService: fakerService,
        sonGuessrService: songService,
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

          await executeWithDeduplication({
            ws,
            connectionId,
            parsed,
            startTime,
            logger,
            execute: () => fakerService.execute(connectionId, parsed),
          });
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
          const parsed = parseSonGuessrMessage(raw);
          parsedId = parsed.id;
          parsedType = parsed.type;
          traceId = parsed.traceId;

          await executeWithDeduplication({
            ws,
            connectionId,
            parsed,
            startTime: startedAt,
            logger,
            execute: () => songService.execute(connectionId, parsed),
            serviceName: "SonGuessr",
          });
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
    whoIsFakerService: fakerService,
    sonGuessrService: songService,
  };
};
