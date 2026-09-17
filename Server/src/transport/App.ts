import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";

import { WhoIsFakerService } from "../application/WhoIsFakerService";
import { SonGuessrService } from "../application/SonGuessrService";
import { CCBService } from "../application/CCBService";
import { CCBCharacterRepository } from "../infrastructure/CCBCharacterRepository";
import type { AppEnv } from "../config/Env";
import { AppError, isAppError } from "../domain/Errors";
import type { ConnectionRecord } from "../domain/Model";
import { describeError, EventLogger } from "../infrastructure/EventLogger";
import { NeteaseMusicProvider } from "../infrastructure/NeteaseMusicProvider";
import { BangumiWorkerProvider } from "../infrastructure/BangumiWorkerProvider";
import { BangumiProvider } from "../infrastructure/BangumiProvider";
import { FallbackBangumiProvider } from "../infrastructure/FallbackBangumiProvider";
import { LRUCache } from "lru-cache";

import { createSwaggerPlugin } from "./Openapi";
import { createAck, createErrorPacket } from "./Packets";
import { parseWhoIsFakerMessage } from "./WhoIsFakerProtocol";
import { parseSonGuessrMessage } from "./SonGuessrProtocol";
import { parseCCBMessage } from "./CCBProtocol";
import { createStateSyncSender } from "./StateSync";
import { isPrivateLanHost, systemRoutes } from "./routes/System";
import { sentryTunnelRoutes } from "./routes/SentryTunnel";

export interface AppDependencies {
  env: AppEnv;
  whoIsFakerService: WhoIsFakerService;
  logger: EventLogger;
  sonGuessrService?: SonGuessrService;
  ccbService?: CCBService;
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
  send: (data: string) => unknown;
  close: (code?: number, reason?: string) => unknown;
}

interface GameSocketHandlers<TMessage extends { id: string; type: string; traceId?: string }> {
  /** 只用于错误日志前缀，便于把异常定位到具体游戏。 */
  serviceName: string;
  parse: (raw: unknown) => TMessage;
  execute: (connectionId: string, message: TMessage) => Promise<unknown>;
}

const connectionIdOf = (ws: GameSocketLike): string | undefined =>
  (ws.data as { connectionId?: string }).connectionId;

/** Origin 白名单校验：三个游戏入口完全一致，不通过即拒绝升级。 */
const rejectDisallowedOrigin = (
  headers: unknown,
  request: Request | undefined,
  clientUrl?: string,
): { status: 403 } | undefined => {
  const origin =
    request?.headers?.get("origin") ??
    (headers as Record<string, string> | undefined)?.["origin"];
  return isAllowedOrigin(origin, clientUrl) ? undefined : { status: 403 };
};

/** 建立连接上下文，后续所有命令都靠它定位会话。 */
const openGameConnection = (
  ws: GameSocketLike,
  register: (connection: ConnectionRecord) => void,
): void => {
  const connectionId = crypto.randomUUID();
  (ws.data as { connectionId?: string }).connectionId = connectionId;
  const stateSync = createStateSyncSender((payload) => {
    sendPacket(ws, payload);
  });
  register({
    id: connectionId,
    lobbySubscribed: false,
    send: stateSync.send,
    resetStateSync: stateSync.reset,
    sendStateSyncCalibration: stateSync.calibrate,
    sendPacket: (payload: unknown) => sendPacket(ws, payload),
    close: (code?: number, reason?: string) => ws.close(code, reason),
  });
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
const handleGameMessage = async <TMessage extends { id: string; type: string; traceId?: string }>(
  ws: GameSocketLike,
  incoming: unknown,
  decoder: TextDecoder,
  logger: EventLogger,
  { serviceName, parse, execute }: GameSocketHandlers<TMessage>,
): Promise<void> => {
  const connectionId = connectionIdOf(ws);
  if (!connectionId) return;

  const startedAt = performance.now();
  let parsedId = "unknown";
  let parsedType = "raw";
  let traceId: string | undefined;
  try {
    const parsed = parse(decodeIncoming(incoming, decoder));
    parsedId = parsed.id;
    parsedType = parsed.type;
    traceId = parsed.traceId;

    await executeWithDeduplication({
      ws,
      connectionId,
      parsed,
      startTime: startedAt,
      logger,
      execute: () => execute(connectionId, parsed),
      serviceName,
    });
  } catch (error) {
    if (isAppError(error)) {
      logger.logOperation({
        status: 400,
        durationMs: performance.now() - startedAt,
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

    logger.error(`${serviceName} WS 内部异常 [${parsedType}]`, {
      ...describeError(error),
      error: error instanceof Error ? error : new Error(String(error)),
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
      traceId,
    });
    sendPacket(
      ws,
      createErrorPacket(parsedId, "INTERNAL_ERROR", "服务器内部错误", undefined, traceId),
    );
  }
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
      musicProvider: new NeteaseMusicProvider({
        logger,
        enableGeneralUnblock: env.enableGeneralUnblock,
      }),
      bangumiProvider: new FallbackBangumiProvider(
        new BangumiWorkerProvider({
          songPath: env.bangumiSongDbPath!,
          characterPath: env.bangumiCharacterDbPath!,
          enrichmentPath: env.bangumiEnrichmentPath,
          imageBase: env.bangumiImageUrl,
          apiBase: env.bangumiApiUrl,
        }),
        new BangumiProvider({ apiUrl: env.bangumiApiUrl, imageUrl: env.bangumiImageUrl }),
      ),
    });

  // CCB 的出题与反馈全部读本地只读数据集。数据集是 LFS 产物，本地未拉取时文件不存在，
  // 此时**只关掉对局能力**、保留房间骨架，而不是让整个服务起不来；首次用到才构造连接。
  let ccbRepository: CCBCharacterRepository | undefined;
  let ccbRepositoryFailed = false;
  const requireCCBRepository = (): CCBCharacterRepository => {
    if (ccbRepository) return ccbRepository;
    if (ccbRepositoryFailed) {
      throw new AppError("CCB_DATA_UNAVAILABLE", "角色数据集不可用");
    }
    try {
      ccbRepository = new CCBCharacterRepository({
        characterDbPath: env.bangumiCharacterDbPath!,
      });
      return ccbRepository;
    } catch (error) {
      ccbRepositoryFailed = true;
      console.warn("[CCB] 角色数据集打不开，对局指令将不可用:", describeError(error));
      throw new AppError(
        "CCB_DATA_UNAVAILABLE",
        "角色数据集不可用，请先构建 bangumi-character.sqlite",
      );
    }
  };

  // 立绘回源复用猜歌那条镜像链路，但**单独持有实例并延迟构造**：注入了 sonGuessrService
  // 的测试不该平白多起一个 Worker。
  let ccbBangumi: FallbackBangumiProvider | undefined;
  const resolveCCBCharacterImage = async (characterId: number) => {
    ccbBangumi ??= new FallbackBangumiProvider(
      new BangumiWorkerProvider({
        songPath: env.bangumiSongDbPath!,
        characterPath: env.bangumiCharacterDbPath!,
        enrichmentPath: env.bangumiEnrichmentPath,
        imageBase: env.bangumiImageUrl,
        apiBase: env.bangumiApiUrl,
      }),
      new BangumiProvider({ apiUrl: env.bangumiApiUrl, imageUrl: env.bangumiImageUrl }),
    );
    return ccbBangumi.resolveCharacterImage(characterId);
  };

  const ccbSvc =
    ccbService ??
    new CCBService({
      eventLogger: logger,
      characters: {
        pickRandomSubject: (settings) => requireCCBRepository().pickRandomSubject(settings),
        pickRandomCharacter: (subjectId, settings) =>
          requireCCBRepository().pickRandomCharacter(subjectId, settings),
        buildCharacterView: (characterId, settings) =>
          requireCCBRepository().buildCharacterView(characterId, settings),
        searchCharacters: (keyword, limit) => requireCCBRepository().searchCharacters(keyword, limit),
      },
      resolveCharacterImage: resolveCCBCharacterImage,
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
        traceId,
      });
    })
    // ==================== 全局错误生命周期处理 ====================
    .onError(({ code, error, set, path, request, startedAt, traceId }) => {
      const activeTraceId =
        traceId ??
        request?.headers?.get("x-trace-id") ??
        request?.headers?.get("x-request-id") ??
        crypto.randomUUID();

      if (set.headers && activeTraceId) {
        set.headers["x-trace-id"] = activeTraceId;
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
        traceId: activeTraceId,
      });

      if (status >= 500) {
        logger.error(`HTTP 500 异常 [${path}]`, {
          ...describeError(error),
          error: error instanceof Error ? error : new Error(String(error)),
          traceId: activeTraceId,
        });
      }

      return {
        error: {
          code: errCode,
          message: errMsg,
          traceId: activeTraceId,
        },
      };
    })
    // ==================== 系统 HTTP 业务模块 ====================
    .use(
      systemRoutes({
        whoIsFakerService: fakerService,
        sonGuessrService: songService,
        ccbService: ccbSvc,
        logger,
        isShuttingDown,
        onTriggerShutdown,
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
      upgrade: ({ headers, request }) => rejectDisallowedOrigin(headers, request, env.clientUrl),
      open: (ws) => openGameConnection(ws, (connection) => fakerService.registerConnection(connection)),
      message: (ws, incoming) =>
        handleGameMessage(ws, incoming, decoder, logger, {
          serviceName: "WhoIsFaker",
          parse: parseWhoIsFakerMessage,
          execute: (connectionId, message) => fakerService.execute(connectionId, message),
        }),
      close: (ws) =>
        closeGameConnection(ws, (connectionId) => fakerService.unregisterConnection(connectionId)),
    })
    .ws("/api/songuessr/ws", {
      upgrade: ({ headers, request }) => rejectDisallowedOrigin(headers, request, env.clientUrl),
      open: (ws) => openGameConnection(ws, (connection) => songService.registerConnection(connection)),
      message: (ws, incoming) =>
        handleGameMessage(ws, incoming, decoder, logger, {
          serviceName: "SonGuessr",
          parse: parseSonGuessrMessage,
          execute: (connectionId, message) => songService.execute(connectionId, message),
        }),
      close: (ws) =>
        closeGameConnection(ws, (connectionId) => songService.unregisterConnection(connectionId)),
    })
    .ws("/api/ccb/ws", {
      upgrade: ({ headers, request }) => rejectDisallowedOrigin(headers, request, env.clientUrl),
      open: (ws) => openGameConnection(ws, (connection) => ccbSvc.registerConnection(connection)),
      message: (ws, incoming) =>
        handleGameMessage(ws, incoming, decoder, logger, {
          serviceName: "CCB",
          parse: parseCCBMessage,
          execute: (connectionId, message) => ccbSvc.execute(connectionId, message),
        }),
      close: (ws) =>
        closeGameConnection(ws, (connectionId) => ccbSvc.unregisterConnection(connectionId)),
    });

  return {
    app,
    whoIsFakerService: fakerService,
    sonGuessrService: songService,
    ccbService: ccbSvc,
  };
};
