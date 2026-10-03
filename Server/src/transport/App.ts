import { cors } from "@elysiajs/cors";
import { Elysia, ValidationError } from "elysia";

import { WhoIsFakerService } from "../application/WhoIsFakerService";
import { SonGuessrService } from "../application/SonGuessrService";
import { CCBService } from "../application/CCBService";
import type { AppEnv } from "../config/Env";
import { AppError, isAppError } from "../domain/Errors";
import type { ConnectionRecord } from "../domain/Model";
import { describeError, EventLogger, sanitizeLogText } from "../infrastructure/EventLogger";
import { LRUCache } from "lru-cache";

import { createSwaggerPlugin } from "./Openapi";
import { createAck, createErrorPacket } from "./Packets";
import { parseWhoIsFakerMessage, WhoIsFakerClientMessageSchema } from "./WhoIsFakerProtocol";
import { parseSonGuessrMessage, SonGuessrClientMessageSchema } from "./SonGuessrProtocol";
import { parseCCBMessage, CCBClientMessageSchema } from "./CCBProtocol";
import { normalizeCCBEnvelope } from "../shared/CCB";
import { ServerMessageSchema } from "../shared/PacketSchemas";
import type { ServerMessage } from "../shared/Protocol";
import { createStateSyncSender } from "./StateSync";
import { isPrivateLanHost, systemRoutes } from "./routes/System";
import { sentryTunnelRoutes } from "./routes/SentryTunnel";

export interface AppDependencies {
  env: AppEnv;
  whoIsFakerService: WhoIsFakerService;
  logger: EventLogger;
  sonGuessrService: SonGuessrService;
  ccbService: CCBService;
  disposeResources?: () => Promise<void>;
  isShuttingDown?: () => boolean;
  onTriggerShutdown?: () => Promise<void> | void;
}

const messageAckCache = new LRUCache<string, object>({
  max: 2048,
  ttl: 15_000,
});
type InFlightOutcome =
  | { success: true; payload: unknown }
  | { success: false; error: unknown };

/**
 * 飞行中请求的去重表，按 `${connectionId}:${messageId}` 记。
 *
 * 必须封顶：大量连接持续发新 ID 时，无上限的 Map 会一直堆积，
 * 挤占正常条目所属的堆内存，也让"还在飞"的判定失去意义。
 * 超过上限时丢弃最旧的条目——它要么已完成（早已被 delete），
 * 要么属于长时间卡住的连接，此时不再为其提供去重反而是更安全的行为。
 */
const MAX_IN_FLIGHT_OPERATIONS = 4096;
const inFlightOperations = new Map<string, Promise<InFlightOutcome>>();

const rememberInFlight = (key: string, promise: Promise<InFlightOutcome>) => {
  if (inFlightOperations.size >= MAX_IN_FLIGHT_OPERATIONS) {
    const oldest = inFlightOperations.keys().next().value;
    if (oldest !== undefined) inFlightOperations.delete(oldest);
  }
  inFlightOperations.set(key, promise);
};

const sendPacket = (
  ws: { send: (data: ServerMessage) => unknown },
  payload: ServerMessage,
) => {
  ws.send(payload);
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
  ws: { send: (data: ServerMessage) => unknown };
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
        traceId,
      });
      sendPacket(ws, createAck(parsed, outcome.payload));
    } else if (isAppError(outcome.error)) {
      logger.logOperation({
        status: 400,
        durationMs,
        identifier: connectionId,
        action: `WS ${parsedType} (replay)`,
        level: "WARN",
        traceId,
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
        traceId,
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

  rememberInFlight(dedupKey, executePromise);
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
      traceId,
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
        traceId,
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
      traceId,
    });
    sendPacket(
      ws,
      createErrorPacket(parsedId, "INTERNAL_ERROR", "服务器内部错误", undefined, traceId),
    );
  }
};

const isAllowedOrigin = (
  origin: string | null | undefined,
  clientUrl?: string,
): boolean => {
  if (!origin) return true;
  // 没有配置白名单时不能「放行一切」——那是 CSWSH 的入口。
  // 此时退化为「只允许同属私网/本机的来源」，公网浏览器页面一律拒绝。
  if (!clientUrl) {
    try {
      return isPrivateLanHost(new URL(origin).hostname);
    } catch {
      return false;
    }
  }
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

/** 传输层只需要 WebSocket 的这几个能力，避免依赖 Elysia 的内部类型。 */
interface GameSocketLike {
  data: unknown;
  send: (data: ServerMessage) => unknown;
  close: (code?: number, reason?: string) => unknown;
}

interface GameSocketHandlers<TMessage extends { id: string; type: string; traceId?: string }> {
  /** 只用于错误日志前缀，便于把异常定位到具体游戏。 */
  serviceName: string;
  execute: (connectionId: string, message: TMessage) => Promise<unknown>;
}

const connectionIdOf = (ws: GameSocketLike): string | undefined =>
  (ws.data as { connectionId?: string }).connectionId;

/**
 * Origin 白名单校验：三个游戏入口完全一致，不通过即拒绝升级。
 *
 * 必须是 **throw** 而不是 return：Elysia 的 `.ws()` `upgrade` 钩子返回值会被忽略
 * （实测 1.4.29 / 1.4.30 均如此，返回 `{ status: 403 }` 与 `new Response(403)` 都拦不住，
 * 任意 Origin 照样 101 完成握手），只有抛出异常才会被转成响应。这个差别曾经让
 * 整道跨站 WebSocket 防护形同虚设，改动前请先跑 App.test.ts 里对应的用例。
 */
const rejectDisallowedOrigin = (
  headers: unknown,
  request: Request | undefined,
  clientUrl?: string,
): void => {
  const origin =
    request?.headers?.get("origin") ??
    (headers as Record<string, string> | undefined)?.["origin"];
  if (isAllowedOrigin(origin, clientUrl)) return;
  throw new AppError("FORBIDDEN_ORIGIN", "来源不被允许");
};

/** 建立连接上下文，后续所有命令都靠它定位会话。 */
const openGameConnection = (
  ws: GameSocketLike,
  register: (connection: ConnectionRecord) => void,
): void => {
  const connectionId = crypto.randomUUID();
  (ws.data as { connectionId?: string }).connectionId = connectionId;
  const stateSync = createStateSyncSender((payload) => {
    sendPacket(ws, payload as ServerMessage);
  });
  register({
    id: connectionId,
    lobbySubscribed: false,
    send: stateSync.send,
    resetStateSync: stateSync.reset,
    sendStateSyncCalibration: stateSync.calibrate,
    sendPacket: (payload: unknown) => sendPacket(ws, payload as ServerMessage),
    close: (code?: number, reason?: string) => ws.close(code, reason),
  });
};

/**
 * 解析阶段失败的诊断摘要。
 *
 * 解析失败时 `parsedType` / `parsedId` 都还是初值，日志只剩 `WS raw`，事后无从判断是哪个命令、
 * 哪条字段不合法——而这类故障恰好只会「静默」发生（客户端拿不到可匹配的 ack/error 包，
 * 请求因 `timeout: 0` 永不超时，页面只表现为卡住）。因此这里在解析失败路径上补一份
 * 类型与大小信息，让日志可定位输入边界。
 *
 * 只保留类型、长度与键数；任意键名同样可能承载秘密，不记录名称或截断样本。
 */
const describeRawMessage = (raw: unknown): Record<string, unknown> => {
  if (typeof raw === "string") {
    return { rawKind: "string", length: raw.length, sample: "[原始消息已省略]" };
  }
  if (raw === null || typeof raw !== "object") return { rawKind: typeof raw };
  if (raw instanceof ArrayBuffer) return { rawKind: "ArrayBuffer", byteLength: raw.byteLength };
  if (ArrayBuffer.isView(raw)) return { rawKind: raw.constructor.name, byteLength: raw.byteLength };
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  return {
    rawKind: "object",
    keyCount: keys.length,
  };
};

/**
 * 从**校验失败**的原始载荷里抢救出信封身份字段（三个游戏共用）。
 *
 * 这不是为了放行非法消息，而是为了让失败可诊断、可回显：解析失败时若拿不到 `id`，
 * 网关只能用占位的 `"unknown"` 回错误包，客户端在 `pendingRequests` 里匹配不到该 id
 * 就会**静默丢弃**——请求因 `timeout: 0` 永不超时，页面只表现为一直卡住、前端无任何提示。
 * 抢救出 `id` 后，客户端至少能收到一条可归因的错误提示而不是无限等待。
 *
 * 返回值仅供错误回包与日志使用，绝不参与业务执行。
 */
const salvageMessageIdentity = (input: unknown): { id: string; type?: string; traceId?: string } | undefined => {
  let candidate = input;
  if (typeof candidate === "string") {
    try { candidate = JSON.parse(candidate); } catch { return undefined; }
  }
  if (!candidate || typeof candidate !== "object") return undefined;
  const record = candidate as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== "string" || !id.length) return undefined;
  const type = typeof record.type === "string" ? record.type.slice(0, 64) : undefined;
  const traceId = typeof record.traceId === "string" ? record.traceId.slice(0, 128) : undefined;
  return { id: id.slice(0, 128), ...(type ? { type } : {}), ...(traceId ? { traceId } : {}) };
};

/** Bun/Elysia 可能给字符串、二进制或已解析对象，这里统一归一化。 */
const decodeIncoming = (incoming: unknown, decoder: TextDecoder): unknown =>
  typeof incoming === "string"
    ? incoming
    : incoming instanceof ArrayBuffer
      ? decoder.decode(new Uint8Array(incoming))
      : ArrayBuffer.isView(incoming)
        ? decoder.decode(new Uint8Array(incoming.buffer, incoming.byteOffset, incoming.byteLength))
        : incoming;

/**
 * 三个游戏共用的消息处理：解析 → 幂等执行 → ACK/错误封包。
 *
 * 只在「解析器、服务、日志前缀」上不同（`Spec.md §11.2` 要求网关对称消费各游戏解析器），
 * 其余部分单点实现，避免三份拷贝在后续改动中各自漂移。
 */
/** 成功帧已通过 Elysia body 校验，业务层不重复枚举 Value.Errors。 */
const handleGameMessage = async <TMessage extends { id: string; type: string; traceId?: string }>(
  ws: GameSocketLike, parsed: TMessage, logger: EventLogger,
  { serviceName, execute }: GameSocketHandlers<TMessage>,
): Promise<void> => {
  const connectionId = connectionIdOf(ws);
  if (!connectionId) return;
  await executeWithDeduplication({
    ws, connectionId, parsed, startTime: performance.now(), logger,
    execute: () => execute(connectionId, parsed), serviceName,
  });
};

// Elysia 已解码普通 JSON；该补充只统一带空白 JSON / 二进制帧，校验仍归框架。
const decodeGameFrame = (_ws: unknown, incoming: unknown): ReturnType<typeof JSON.parse> => {
  const text = typeof incoming === "string" ? incoming : incoming instanceof Uint8Array ? new TextDecoder().decode(incoming) : undefined;
  if (text === undefined) return undefined;
  // JSON.parse 的非可信返回值只存在于解码边界；其后仍由原生 body validator 校验。
  try { return JSON.parse(text); } catch { return undefined; }
};

/** route-local error 在 HTTP 全局错误钩子之前保持原有 WS 错误/关联契约。 */
const gameSocketError = (logger: EventLogger, serviceName: string, parse: (raw: unknown) => unknown) =>
  ({ error }: { error: unknown }): ServerMessage => {
    const input = error instanceof ValidationError ? error.value : undefined;
    const identity = salvageMessageIdentity(input);
    let failure: unknown = error;
    if (error instanceof ValidationError) {
      try { parse(input); } catch (diagnostic) { failure = diagnostic; }
      // 仅记录类型与大小；键名及任意信封字段也可能承载秘密，不复制到日志。
      logger.warn(`${serviceName} WS 消息解析失败`, {
        ...describeRawMessage(input),
      });
    }
    if (isAppError(failure)) return createErrorPacket(identity?.id ?? "unknown", failure.code, failure.message, undefined, identity?.traceId);
    logger.error(`${serviceName} WS 内部异常`, describeError(failure));
    return createErrorPacket(identity?.id ?? "unknown", "INTERNAL_ERROR", "服务器内部错误", undefined, identity?.traceId);
  };

const closeGameConnection = async (
  ws: GameSocketLike,
  unregister: (connectionId: string) => Promise<void>,
): Promise<void> => {
  const connectionId = connectionIdOf(ws);
  if (connectionId) await unregister(connectionId);
};

export const createApp = ({
  env,
  whoIsFakerService,
  logger,
  sonGuessrService,
  ccbService,
  isShuttingDown,
  onTriggerShutdown,
  disposeResources,
}: AppDependencies) => {
  const fakerService = whoIsFakerService;
  if (!fakerService) {
    throw new Error("WhoIsFakerService dependency is required");
  }
  const songService = sonGuessrService;
  const characterService = ccbService;
  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> => disposal ??= disposeResources ? disposeResources() : characterService.close();
  const requests = new WeakMap<Request, { traceId: string; startedAt: number }>();
  const app = new Elysia({
    normalize: false,
    websocket: {
      // 部分 iOS WebKit 版本会在 permessage-deflate 协商后立即断开连接。
      // Bun 的协商配置是服务器级别，无法按 UA 稳定切换，因此全局关闭压缩。
      perMessageDeflate: false,
      // 限制单帧最大载荷 256KB，防止恶意外溢 OOM
      maxPayloadLength: 256 * 1024,
    },
  })
    .onStop(() => { void dispose().catch((error: unknown) => logger.error("服务资源释放失败", describeError(error))); })
    .onRequest(({ request, set }) => {
      const traceId = sanitizeLogText(request.headers.get("x-trace-id") ?? request.headers.get("x-request-id") ?? crypto.randomUUID(), 128);
      requests.set(request, { traceId, startedAt: performance.now() });
      set.headers["x-trace-id"] = traceId;
    })
    // ==================== WebSocket 升级的 Origin 白名单（防跨站 WebSocket 劫持） ====================
    // 必须拦在 HTTP 层：`.ws()` 的 `upgrade` 钩子**返回值会被 Elysia 忽略**
    // （1.4.29 / 1.4.30 实测：返回 `{ status: 403 }` 或 `new Response(403)` 都拦不住，
    // 任意 Origin 照样 101 完成握手）。WebSocket 不受浏览器同源策略约束，
    // 这道闸门是唯一防线 —— 改动前请跑 App.test.ts 里「按 Origin 白名单拦截」那条用例。
    .onRequest(({ request }) => {
      if (request.headers.get("upgrade") !== "websocket") return;
      const { pathname } = new URL(request.url);
      if (!pathname.endsWith("/ws")) return;
      if (isAllowedOrigin(request.headers.get("origin"), env.clientUrl)) return;
      throw new AppError("FORBIDDEN_ORIGIN", "来源不被允许");
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
    .derive(({ request }) => requests.get(request)!)
    .onAfterResponse(({ request, response, set }) => {
      const context = requests.get(request);
      if (!context) return;
      const statusCode = response instanceof Response ? response.status : Number(set.status ?? 200);
      logger.logOperation({
        status: statusCode,
        durationMs: performance.now() - context.startedAt,
        identifier: request.headers.get("x-forwarded-for") ?? "127.0.0.1",
        action: `HTTP ${request.method} ${new URL(request.url).pathname}`,
        traceId: context.traceId,
        level: statusCode >= 500 ? "ERROR" : statusCode >= 400 ? "WARN" : "INFO",
      });
    })
    .onError(({ code, error, set, path, request }) => {
      const traceId = requests.get(request)?.traceId ?? crypto.randomUUID();
      set.headers["x-trace-id"] = traceId;
      let statusCode = 500;
      let errorCode = "INTERNAL_ERROR";
      let message = "服务器内部错误";
      if (isAppError(error)) {
        statusCode = error.code === "FORBIDDEN_ORIGIN" ? 403 : 400; errorCode = error.code; message = error.message;
      } else if (code === "PARSE") {
        statusCode = 400; errorCode = "INVALID_JSON"; message = "请求必须为合法 JSON";
      } else if (String(code) === "VALIDATION" && (!(error instanceof ValidationError) || error.type !== "response")) {
        statusCode = 422; errorCode = "VALIDATION_ERROR"; message = "请求载荷格式错误";
      } else if (code === "NOT_FOUND") {
        statusCode = 404; errorCode = "NOT_FOUND"; message = "请求资源不存在";
      }
      set.status = statusCode;
      if (statusCode >= 500) logger.error(`HTTP 500 异常 [${path}]`, { ...describeError(error), traceId });
      return { error: { code: errorCode, message, traceId } };
    })
    // ==================== 系统 HTTP 业务模块 ====================
    .use(
      systemRoutes({
        whoIsFakerService: fakerService,
        sonGuessrService: songService,
        ccbService: characterService,
        logger,
        isShuttingDown,
        onTriggerShutdown,
        maintenanceToken: env.maintenanceToken,
      }),
    )
    .use(
      sentryTunnelRoutes({
        allowedProjectIds: env.sentryAllowedProjectIds,
        sentryDsn: env.sentryDsn,
        logger,
      }),
    )
    // ==================== WebSocket 入口 ====================
    .ws("/api/whoisfaker/ws", {
      body: WhoIsFakerClientMessageSchema, response: ServerMessageSchema, parse: decodeGameFrame,
      error: gameSocketError(logger, "WhoIsFaker", parseWhoIsFakerMessage),
      upgrade: ({ headers, request }) => rejectDisallowedOrigin(headers, request, env.clientUrl),
      open: (ws) => openGameConnection(ws, (connection) => fakerService.registerConnection(connection)),
      message: (ws, incoming) =>
        handleGameMessage(ws, incoming, logger, {
          serviceName: "WhoIsFaker",
          execute: (connectionId, message) => fakerService.execute(connectionId, message),
        }),
      close: (ws) =>
        closeGameConnection(ws, (connectionId) => fakerService.unregisterConnection(connectionId)),
    })
    .ws("/api/ccb/ws", {
      body: CCBClientMessageSchema, response: ServerMessageSchema, parse: decodeGameFrame,
      error: gameSocketError(logger, "CCB", parseCCBMessage),
      upgrade: ({ headers, request }) => rejectDisallowedOrigin(headers, request, env.clientUrl),
      open: (ws) => openGameConnection(ws, (connection) => characterService.registerConnection(connection)),
      message: (ws, incoming) => handleGameMessage(ws, normalizeCCBEnvelope(incoming), logger, {
        serviceName: 'CCB',
        execute: (connectionId, message) => characterService.execute(connectionId, message),
      }),
      close: (ws) => closeGameConnection(ws, (connectionId) => characterService.unregisterConnection(connectionId)),
    })
    .ws("/api/songuessr/ws", {
      body: SonGuessrClientMessageSchema, response: ServerMessageSchema, parse: decodeGameFrame,
      error: gameSocketError(logger, "SonGuessr", parseSonGuessrMessage),
      upgrade: ({ headers, request }) => rejectDisallowedOrigin(headers, request, env.clientUrl),
      open: (ws) => openGameConnection(ws, (connection) => songService.registerConnection(connection)),
      message: (ws, incoming) =>
        handleGameMessage(ws, incoming, logger, {
          serviceName: "SonGuessr",
          execute: (connectionId, message) => songService.execute(connectionId, message),
        }),
      close: (ws) =>
        closeGameConnection(ws, (connectionId) => songService.unregisterConnection(connectionId)),
    });

  return {
    app,
    dispose,
    whoIsFakerService: fakerService,
    sonGuessrService: songService,
    ccbService: characterService,
  };
};
