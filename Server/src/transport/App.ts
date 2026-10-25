import { cors } from "@elysiajs/cors";
import { Elysia, ValidationError } from "elysia";

import { WhoIsFakerService } from "../application/WhoIsFakerService";
import { SonGuessrService } from "../application/SonGuessrService";
import { CEEService } from "../application/CEEService";
import type { AppEnv } from "../config/Env";
import { AppError, isAppError } from "../domain/Errors";
import type { ConnectionRecord, PlayerAccount, ClientChannelProof } from "../shared/Index";
import { describeError, EventLogger, sanitizeLogText } from "../infrastructure/EventLogger";
import { LRUCache } from "lru-cache";

import { createSwaggerPlugin } from "./Openapi";
import { resolveClientIp } from "./ClientIp";
import { securityHeaders } from "./SecurityHeaders";
import { WsHandshakeQuota } from "./WsHandshakeQuota";
import {
  WS_HANDSHAKE_GLOBAL_MAX_NEW_PER_WINDOW,
  WS_HANDSHAKE_IP_MAX_CONNECTIONS,
  WS_HANDSHAKE_IP_MAX_NEW_PER_WINDOW,
  WS_HANDSHAKE_WINDOW_MS,
} from "../config/Constants";
import { createAck, createErrorPacket } from "./Packets";
import { traceIdOf } from "./HttpErrorEnvelope";
import { parseWhoIsFakerMessage, WhoIsFakerClientMessageSchema } from "./WhoIsFakerProtocol";
import { parseSonGuessrMessage, SonGuessrClientMessageSchema } from "./SonGuessrProtocol";
import { parseCEEMessage, CEEClientMessageSchema } from "./CEEProtocol";
import { normalizeCEEEnvelope } from "../shared/CEE";
import { ServerMessageSchema } from "../shared/PacketSchemas";
import type { ServerMessage } from "../shared/Protocol";
import { createStateSyncSender } from "./StateSync";
import { isPrivateLanHost, shutdownRejection, systemRoutes } from "./routes/System";
import { createStatusAggregator, startStatusSampler, statusRoutes } from "./routes/Status";
import { statusWsRoutes } from "./routes/StatusWs";
import { sentryTunnelRoutes } from "./routes/SentryTunnel";
import { bangumiImageRoutes } from "./routes/BangumiImages";
import { accountRoutes, statusOfAppError, type AccountDependencies } from "./routes/Account";
import { clientChannelRoutes } from "./routes/ClientChannelRoutes";
import { mcpDiscoveryRoutes } from "./routes/McpDiscovery";
import { mcpRemoteRoutes } from "./routes/McpRemote";
import { RemoteMcpSessions } from "../mcp/Remote";
import type { ClientArtifacts } from "../infrastructure/ClientArtifacts";
import type { ClientChannel } from "../infrastructure/ClientChannel";
import type { BangumiImageService } from "../infrastructure/BangumiImageService";
import { BetterStackStatusProbe } from "../infrastructure/BetterStackStatusProbe";
import type { StatusHistoryStore } from "../infrastructure/StatusHistoryStore";
import type { StatusSampleStore } from "../infrastructure/StatusSampleStore";
import type { StatusEventRepository } from "../infrastructure/db/StatusEventRepository";
import { PUBLIC_STATUS_SAMPLE_INTERVAL_MS } from "../shared/Status";
import { resolveServerRelease } from "../infrastructure/Release";

export interface AppDependencies {
  env: AppEnv;
  whoIsFakerService: WhoIsFakerService;
  logger: EventLogger;
  sonGuessrService: SonGuessrService;
  ceeService: CEEService;
  disposeResources?: () => Promise<void>;
  isShuttingDown?: () => boolean;
  onTriggerShutdown?: () => Promise<void> | void;
  /** 自建图床读取服务：提供时挂载 `/api/bangumi/*`（未提供时该路由 404）。 */
  bangumiImages?: BangumiImageService;
  /** 状态页历史账本：提供时 `/api/status` 每次真实探测记一笔，并开放 `/api/status/history`。 */
  statusHistory?: StatusHistoryStore;
  /** 实时样本账本：提供时后台采样器按采样间隔记一笔，并开放 `/api/status/realtime`。 */
  statusSamples?: StatusSampleStore;
  /** 状态事件仓储：提供时开放 `/api/status/events`（未配置数据库的实例没有事件）。 */
  statusEvents?: StatusEventRepository;
  /** 账号系统（登录、oRPC、头像代理）：未提供时相关路由回 503 `ACCOUNT_DISABLED`。 */
  account?: AccountDependencies;
  /**
   * 握手配额：默认按常量新建一份。压测目标进程注入放开额度的实例，
   * 否则同一台机器上的几百条连接会被按客户端地址算出的闸门先挡掉。
   */
  handshakeQuota?: WsHandshakeQuota;
  /**
   * 客户端通道证明：提供时挂载 `/api/client/*`，并在 CEE 握手阶段把一次性 ticket
   * 换成 `connection.clientChannel`。未提供时反作弊房谁也进不去（普通房不受影响）。
   */
  clientChannel?: ClientChannel;
  /**
   * 客户端安装包元数据（首页下载弹窗读它来标构建日期与文件大小）。
   * 未提供时 `/api/client/packages` 回空列表，弹窗只剩「尚未发布」。
   */
  clientArtifacts?: ClientArtifacts;
}

const messageAckCache = new LRUCache<string, object>({
  max: 2048,
  ttl: 15_000,
});
type InFlightOutcome = { success: true; payload: unknown } | { success: false; error: unknown };

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

const sendPacket = (ws: { send: (data: ServerMessage) => unknown }, payload: ServerMessage) => {
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
        createErrorPacket(
          parsedId,
          outcome.error.code,
          outcome.error.message,
          outcome.error.details,
          traceId
        )
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
        createErrorPacket(parsedId, "INTERNAL_ERROR", "服务器内部错误", undefined, traceId)
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
        createErrorPacket(parsedId, error.code, error.message, error.details, traceId)
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
      createErrorPacket(parsedId, "INTERNAL_ERROR", "服务器内部错误", undefined, traceId)
    );
  }
};

/**
 * 内嵌壳（安卓 APK）的固定页面来源：壳把前端产物打包进 WebView，总是以
 * `https://localhost` 为 origin 直连公网后端（`Mobile/capacitor.config.ts`）。
 * 恒信理由：https 下的 localhost 页面必须持有本机受信证书，公网攻击者拿不到该 origin
 * （与「未配置白名单时只放行本机来源」口径一致）；且只认 https，`http://localhost:PORT`
 * 任意本机进程都能提供，不在此列。
 */
const EMBEDDED_APP_ORIGINS = new Set(["https://localhost"]);

export const isAllowedOrigin = (origin: string | null | undefined, clientUrl?: string): boolean => {
  if (!origin) return true;
  if (EMBEDDED_APP_ORIGINS.has(origin)) return true;
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
        if (isPrivateLanHost(originUrl.hostname) && isPrivateLanHost(allowedUrl.hostname)) {
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

/**
 * HTTP 操作名的维度来源。**不能**直接拼 inbound pathname：指标序列与 Sentry 事务名共享
 * 这个名字，扫描器与爬虫的随机路径会把基数推到无界，长尾噪声淹没真实慢请求。
 * 维度只取自已注册路由模板；模板匹配不到的请求统一归入固定桶，路径本身不进标签。
 */
export const UNROUTED_HTTP_ACTION = "HTTP * UNROUTED";

/**
 * 允许进入操作名的方法集合。ALL 模板对任意方法都能匹配，而真实路由分发只受理标准方法；
 * 不在表内的方法（`curl -X FOO` 之类）直接落固定桶，方法维度同样有界。
 */
const LOGGED_HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

export interface RouteTemplate {
  method: string;
  path: string;
  segments: string[];
}

const splitPathSegments = (path: string): string[] => path.split("/").filter(Boolean);

/** 按 Elysia 的路由语义逐段匹配：`:param` 吃一个段，`*` 吞掉其余全部。 */
const matchesRouteSegments = (pattern: readonly string[], path: readonly string[]): boolean => {
  for (let index = 0; index < pattern.length; index += 1) {
    const segment = pattern[index];
    if (segment === "*") return true;
    if (index >= path.length) return false;
    if (!segment.startsWith(":") && segment !== path[index]) return false;
  }
  return pattern.length === path.length;
};

const routeMethodMatches = (routeMethod: string, method: string): boolean =>
  routeMethod === "ALL" ||
  routeMethod === method ||
  // Bun 用 GET 处理器同时兜住 HEAD；WS 升级在 HTTP 层就是 GET。
  (routeMethod === "GET" && method === "HEAD") ||
  (routeMethod === "WS" && method === "GET");

export const compileRouteTemplates = (
  routes: readonly { method: string; path: string }[]
): RouteTemplate[] =>
  routes.map((route) => ({
    method: route.method.toUpperCase(),
    path: route.path,
    segments: splitPathSegments(route.path),
  }));

/** 请求路径 → 操作名：命中模板则带上模板（真实参数值不进名字），否则落 `UNROUTED_HTTP_ACTION`。 */
export const httpOperationAction = (
  templates: readonly RouteTemplate[],
  method: string,
  pathname: string
): string => {
  if (!LOGGED_HTTP_METHODS.has(method)) return UNROUTED_HTTP_ACTION;
  const segments = splitPathSegments(pathname);
  for (const template of templates) {
    if (!routeMethodMatches(template.method, method)) continue;
    if (matchesRouteSegments(template.segments, segments)) return `HTTP ${method} ${template.path}`;
  }
  return UNROUTED_HTTP_ACTION;
};

/** 传输层只需要 WebSocket 的这几个能力，避免依赖 Elysia 的内部类型。 */
interface GameSocketLike {
  data: unknown;
  send: (data: ServerMessage) => unknown;
  close: (code?: number, reason?: string) => unknown;
  raw?: unknown;
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
 * 必须是 **throw** 而不是 return：Elysia 的 `.ws()` `upgrade` 钩子返回值会被忽略，
 * 只有抛出异常才会被转成响应。改动前先跑 App.test.ts 里对应的用例。
 */
const rejectDisallowedOrigin = (
  headers: unknown,
  request: Request | undefined,
  clientUrl?: string
): void => {
  const origin =
    request?.headers?.get("origin") ?? (headers as Record<string, string> | undefined)?.["origin"];
  if (isAllowedOrigin(origin, clientUrl)) return;
  throw new AppError("FORBIDDEN_ORIGIN", "来源不被允许");
};

/**
 * 握手阶段解析登录身份，结果挂到升级上下文上（Elysia 会把上下文展开进 `ws.data`）。
 * 账号系统故障只让本次连接以游客身份进入，绝不拦截游戏握手。
 */
const resolveSocketAccount = async (
  context: { request: Request; account?: PlayerAccount },
  account: AccountDependencies | undefined,
  logger: EventLogger
): Promise<void> => {
  if (!account || !context.request.headers.get("cookie")) return;
  try {
    context.account = await account.service.socketAccount(context.request.headers);
  } catch (error) {
    logger.warn("握手时解析登录状态失败，按游客处理", describeError(error));
  }
};

/**
 * 握手配额闸门：Origin 与登录身份都过之后、真正接受连接之前占一个名额。
 *
 * 超限必须 **throw**（理由同 `rejectDisallowedOrigin`：upgrade 钩子的返回值会被 Elysia 忽略）。
 * 抛 `RATE_LIMITED` 由全局错误钩子回 429；占位成功时把桶键写进上下文，
 * Elysia 会把它带进 `ws.data`，close 钩子据此归还名额。
 */
const reserveHandshakeSlot = (
  context: {
    request: Request;
    server?: { requestIP(request: Request): { address?: string } | null } | null;
    handshakeSlot?: string;
    clientIp?: string;
  },
  quota: WsHandshakeQuota
): void => {
  const peerIp = context.server?.requestIP(context.request)?.address;
  const clientIp = resolveClientIp(context.request.headers, peerIp);
  const slot = quota.acquire(clientIp, peerIp ?? clientIp);
  if (!slot) throw new AppError("RATE_LIMITED", "连接过于频繁，请稍后重试");
  context.handshakeSlot = slot;
  // 业务层的按地址配额要用同一个来源身份，不能到 application 层再反查 HTTP 头。
  context.clientIp = clientIp;
};

/**
 * 握手阶段把壳带来的 ticket 换成通道证明。
 *
 * 只有 CEE 入口调用：ticket 是一次性的，三个游戏都去消费会让先到的那个用掉它，
 * 而反作弊房只存在于 CEE。网页没有 ticket，`clientChannel` 即为空。
 */
const resolveSocketChannel = (
  context: { request: Request; clientIp?: string; clientChannel?: ClientChannelProof },
  channel: ClientChannel | undefined
): void => {
  if (!channel) return;
  const ticket = new URL(context.request.url).searchParams.get("ticket") ?? undefined;
  const proof = channel.consume(ticket, context.clientIp ?? "");
  if (proof) context.clientChannel = proof;
};

/**
 * 这条连接攒着没发出去的字节数。Bun 原生 socket 有 `getBufferedAmount`，
 * 但 Elysia 的 `raw` 用的是它自己裁剪过的 `ServerWebSocket` 声明（不含该方法），
 * 所以这里按结构收窄后再调用。读不到（测试里的假 socket）就返回 0，等价于不启用丢弃。
 */
const socketBacklog = (ws: GameSocketLike): number => {
  const raw = ws.raw as { getBufferedAmount?: () => number } | undefined;
  if (!raw?.getBufferedAmount) return 0;
  return raw.getBufferedAmount();
};

/** 建立连接上下文，后续所有命令都靠它定位会话。 */
/**
 * Agent 身份标记：独立的 MCP server 在握手 URL 上带 `agent=1`（或用同名请求头）。
 * 这只是一个自报标记，不能防住人类伪装；它的用途是让房间设置能拒绝 Agent，并让界面明示。
 */
export const resolveAgentIdentity = (
  context: { request: Request; isAgent?: boolean },
  mcpEnabled?: boolean
): void => {
  const requested =
    context.request.headers.get("x-bakagame-agent") === "1" ||
    new URL(context.request.url).searchParams.get("agent") === "1";
  if (!requested) return;
  if (!mcpEnabled) throw new AppError("AGENTS_DISABLED", "Agent 接入未启用");
  context.isAgent = true;
};

const openGameConnection = (
  ws: GameSocketLike,
  register: (connection: ConnectionRecord) => void
): void => {
  const connectionId = crypto.randomUUID();
  const {
    account,
    clientIp,
    clientChannel: proof,
    isAgent,
  } = ws.data as {
    account?: PlayerAccount;
    clientIp?: string;
    clientChannel?: ClientChannelProof;
    isAgent?: boolean;
  };
  (ws.data as { connectionId?: string }).connectionId = connectionId;
  const stateSync = createStateSyncSender(
    (payload) => {
      sendPacket(ws, payload as ServerMessage);
    },
    () => socketBacklog(ws)
  );
  register({
    id: connectionId,
    ...(account ? { account } : {}),
    ...(clientIp ? { clientIp } : {}),
    ...(proof ? { clientChannel: proof } : {}),
    ...(isAgent ? { isAgent: true } : {}),
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
const salvageMessageIdentity = (
  input: unknown
): { id: string; type?: string; traceId?: string } | undefined => {
  let candidate = input;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return undefined;
    }
  }
  if (!candidate || typeof candidate !== "object") return undefined;
  const record = candidate as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== "string" || !id.length) return undefined;
  const type = typeof record.type === "string" ? record.type.slice(0, 64) : undefined;
  const traceId = typeof record.traceId === "string" ? record.traceId.slice(0, 128) : undefined;
  return { id: id.slice(0, 128), ...(type ? { type } : {}), ...(traceId ? { traceId } : {}) };
};

/**
 * 三个游戏共用的消息处理：解析 → 幂等执行 → ACK/错误封包。
 *
 * 只在「解析器、服务、日志前缀」上不同（Agents/Spec.md「平台与多游戏平等架构 · 传输对称」要求
 * 网关对称消费各游戏解析器），其余部分单点实现，避免三份拷贝在后续改动中各自漂移。
 */
/** 成功帧已通过 Elysia body 校验，业务层不重复枚举 Value.Errors。 */
const handleGameMessage = async <TMessage extends { id: string; type: string; traceId?: string }>(
  ws: GameSocketLike,
  parsed: TMessage,
  logger: EventLogger,
  { serviceName, execute }: GameSocketHandlers<TMessage>
): Promise<void> => {
  const connectionId = connectionIdOf(ws);
  if (!connectionId) return;
  await executeWithDeduplication({
    ws,
    connectionId,
    parsed,
    startTime: performance.now(),
    logger,
    execute: () => execute(connectionId, parsed),
    serviceName,
  });
};

// Elysia 已解码普通 JSON；该补充只统一带空白 JSON / 二进制帧，校验仍归框架。
const decodeGameFrame = (_ws: unknown, incoming: unknown): ReturnType<typeof JSON.parse> => {
  const text =
    typeof incoming === "string"
      ? incoming
      : incoming instanceof Uint8Array
        ? new TextDecoder().decode(incoming)
        : undefined;
  if (text === undefined) return undefined;
  // JSON.parse 的非可信返回值只存在于解码边界；其后仍由原生 body validator 校验。
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** route-local error 在 HTTP 全局错误钩子之前保持原有 WS 错误/关联契约。 */
const gameSocketError =
  (logger: EventLogger, serviceName: string, parse: (raw: unknown) => unknown) =>
  ({ error }: { error: unknown }): ServerMessage => {
    const input = error instanceof ValidationError ? error.value : undefined;
    const identity = salvageMessageIdentity(input);
    let failure: unknown = error;
    if (error instanceof ValidationError) {
      try {
        parse(input);
      } catch (diagnostic) {
        failure = diagnostic;
      }
      // 仅记录类型与大小；键名及任意信封字段也可能承载秘密，不复制到日志。
      logger.warn(`${serviceName} WS 消息解析失败`, {
        ...describeRawMessage(input),
      });
    }
    if (isAppError(failure))
      return createErrorPacket(
        identity?.id ?? "unknown",
        failure.code,
        failure.message,
        undefined,
        identity?.traceId
      );
    logger.error(`${serviceName} WS 内部异常`, describeError(failure));
    return createErrorPacket(
      identity?.id ?? "unknown",
      "INTERNAL_ERROR",
      "服务器内部错误",
      undefined,
      identity?.traceId
    );
  };

const closeGameConnection = async (
  ws: GameSocketLike,
  unregister: (connectionId: string) => Promise<void>
): Promise<void> => {
  const connectionId = connectionIdOf(ws);
  if (connectionId) await unregister(connectionId);
};

/** 连接断开必须归还握手名额，否则同一个来源地址的名额会被历史连接吃光。 */
const releaseHandshakeSlot = (ws: GameSocketLike, quota: WsHandshakeQuota): void => {
  quota.release((ws.data as { handshakeSlot?: string }).handshakeSlot);
};

/** 三款游戏 ws 握手上下文的公共形状；Elysia 会把这里的字段展开进 `ws.data`。 */
type GameUpgradeContext = {
  request: Request;
  headers: unknown;
  server?: { requestIP(request: Request): { address?: string } | null } | null;
  account?: PlayerAccount;
  isAgent?: boolean;
  handshakeSlot?: string;
  clientIp?: string;
  clientChannel?: ClientChannelProof;
};

interface GameSocketHandlersOptions<
  TMessage extends { id: string; type: string; traceId?: string },
> {
  serviceName: string;
  env: AppEnv;
  logger: EventLogger;
  account: AccountDependencies | undefined;
  handshakeQuota: WsHandshakeQuota;
  /** 仅 CEE：握手时把壳带来的 ticket 换成通道证明。 */
  clientChannel?: ClientChannel;
  /** 仅 CEE：上游信封归一。 */
  normalizeMessage?: (incoming: TMessage) => TMessage;
  service: {
    registerConnection(connection: ConnectionRecord): void;
    unregisterConnection(connectionId: string): Promise<void>;
    execute(connectionId: string, message: TMessage): Promise<unknown>;
  };
}

/**
 * 三款游戏 ws 路由共用的四件套 handler（upgrade/open/message/close）。
 * 握手闸门顺序（Origin → 登录身份 → Agent 标记 → 配额，CEE 额外换通道证明）是安全语义，
 * 工厂化是为了不再出现三份手抄副本各自漂移；body/response/parse/error 与 schema 强相关，
 * 留在各路由字面量里交给 Elysia 推断。
 */
const gameSocketHandlers = <TMessage extends { id: string; type: string; traceId?: string }>({
  serviceName,
  env,
  logger,
  account,
  handshakeQuota,
  clientChannel,
  normalizeMessage,
  service,
}: GameSocketHandlersOptions<TMessage>) => ({
  upgrade: async (context: GameUpgradeContext) => {
    rejectDisallowedOrigin(context.headers, context.request, env.clientUrl);
    await resolveSocketAccount(context, account, logger);
    resolveAgentIdentity(context, env.mcpEnabled);
    reserveHandshakeSlot(context, handshakeQuota);
    if (clientChannel) resolveSocketChannel(context, clientChannel);
  },
  open: (ws: GameSocketLike) =>
    openGameConnection(ws, (connection) => service.registerConnection(connection)),
  message: (ws: GameSocketLike, incoming: TMessage) =>
    handleGameMessage(ws, normalizeMessage ? normalizeMessage(incoming) : incoming, logger, {
      serviceName,
      execute: (connectionId, message) => service.execute(connectionId, message),
    }),
  close: (ws: GameSocketLike) => {
    releaseHandshakeSlot(ws, handshakeQuota);
    return closeGameConnection(ws, (connectionId) => service.unregisterConnection(connectionId));
  },
});

export const createApp = ({
  env,
  whoIsFakerService,
  logger,
  sonGuessrService,
  ceeService,
  isShuttingDown,
  onTriggerShutdown,
  disposeResources,
  bangumiImages,
  statusHistory,
  statusSamples,
  statusEvents,
  account,
  handshakeQuota: handshakeQuotaOverride,
  clientChannel,
  clientArtifacts,
}: AppDependencies) => {
  const fakerService = whoIsFakerService;
  if (!fakerService) {
    throw new Error("WhoIsFakerService dependency is required");
  }
  const songService = sonGuessrService;
  const characterService = ceeService;
  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> =>
    (disposal ??= disposeResources ? disposeResources() : characterService.close());
  const remoteMcpSessions = new RemoteMcpSessions(logger);
  const requests = new WeakMap<Request, { traceId: string; startedAt: number; clientIp: string }>();
  // 路由表在 createApp 装配完成时定形，模板索引到首个请求才惰性编译一次。
  let routeTemplates: readonly RouteTemplate[] | undefined;
  // 三个游戏入口共用一份握手配额：一个客户端地址换着连三款游戏也只有一份额度。
  const handshakeQuota =
    handshakeQuotaOverride ??
    new WsHandshakeQuota({
      windowMs: WS_HANDSHAKE_WINDOW_MS,
      ipMaxRequests: WS_HANDSHAKE_IP_MAX_NEW_PER_WINDOW,
      globalMaxRequests: WS_HANDSHAKE_GLOBAL_MAX_NEW_PER_WINDOW,
      ipMaxConnections: WS_HANDSHAKE_IP_MAX_CONNECTIONS,
    });
  // 状态聚合器只建一份：HTTP 快照、历史接口与 WS 实时通道读同一份缓存、记同一本账，
  // 各建一套会让页面在轮询与推送之间看到两种口径。
  const statusAggregator = createStatusAggregator({
    isServiceAvailable: () => !isShuttingDown?.(),
    meilisearchUrl: env.meilisearchUrl,
    datasetPath: env.bangumiDbPath,
    imageCache: bangumiImages ? { available: bangumiImages.available } : undefined,
    frontendUrl: env.statusFrontendUrl,
    roomHealth: () => ({
      roomCount:
        fakerService.getHealthSnapshot().roomCount +
        (songService?.getHealthSnapshot().roomCount ?? 0) +
        (characterService?.getHealthSnapshot().roomCount ?? 0),
      connectionCount:
        fakerService.getHealthSnapshot().connectionCount +
        (songService?.getHealthSnapshot().connectionCount ?? 0) +
        (characterService?.getHealthSnapshot().connectionCount ?? 0),
    }),
    version: () => resolveServerRelease() ?? "unknown",
    externalProbe: env.betterStackApiKey
      ? new BetterStackStatusProbe({
          apiKey: env.betterStackApiKey,
          monitors: env.betterStackMonitorMap ?? {},
        })
      : undefined,
    history: statusHistory,
  });
  // 实时条带的后台采样器：没人开页面时也按采样间隔跑一轮探测记一笔，
  // 间隔远大于快照缓存，采样轮总是真探测；停机时随监听一起停。
  const stopStatusSampler = statusSamples
    ? startStatusSampler({
        aggregator: statusAggregator,
        samples: statusSamples,
        intervalMs: PUBLIC_STATUS_SAMPLE_INTERVAL_MS,
        onError: (error) => logger.warn("状态采样失败", describeError(error)),
      })
    : undefined;
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
    .onStop(() => {
      stopStatusSampler?.();
      remoteMcpSessions.closeAll();
      void dispose().catch((error: unknown) =>
        logger.error("服务资源释放失败", describeError(error))
      );
    })
    .onRequest(({ request, set, server }) => {
      const traceId = sanitizeLogText(
        request.headers.get("x-trace-id") ??
          request.headers.get("x-request-id") ??
          crypto.randomUUID(),
        128
      );
      // 边缘反代后 socket peer 恒为边缘节点地址：日志里的来源身份必须取真实 IP 标头，
      // 否则每条 HTTP 操作日志都记成同一个节点地址，按来源排查就失效了。
      const clientIp = resolveClientIp(request.headers, server?.requestIP(request)?.address);
      requests.set(request, { traceId, startedAt: performance.now(), clientIp });
      Object.assign(set.headers, securityHeaders(request));
      set.headers["x-trace-id"] = traceId;
    })
    // ==================== WebSocket 升级的 Origin 白名单（防跨站 WebSocket 劫持） ====================
    // 必须拦在 HTTP 层：`.ws()` 的 `upgrade` 钩子**返回值会被 Elysia 忽略**
    // （1.4.29 / 1.4.30 实测：返回 `{ status: 403 }` 或 `new Response(403)` 都拦不住，
    // 任意 Origin 照样 101 完成握手）。WebSocket 不受浏览器同源策略约束，
    // 这道闸门是唯一防线 —— 改动前请跑 App.test.ts 里「按 Origin 白名单拦截」那条用例。
    .onRequest(({ request, set }) => {
      if (request.headers.get("upgrade") !== "websocket") return;
      const { pathname } = new URL(request.url);
      if (!pathname.endsWith("/ws")) return;
      // 停机中直接拒新握手：摘流只挡住「新流量分配」，进程内照样会 101，排空窗口等不到「没有新连接」。
      // 判在 Origin 与握手配额之前：拒绝不消耗配额桶，也不给来源探测留可分辨的差异。
      const rejection = shutdownRejection(isShuttingDown, traceIdOf(set.headers));
      if (rejection) return rejection;
      if (isAllowedOrigin(request.headers.get("origin"), env.clientUrl)) return;
      throw new AppError("FORBIDDEN_ORIGIN", "来源不被允许");
    })
    // ==================== 原生插件与全局中间件 ====================
    .use(
      cors({
        origin: (req: Request) => isAllowedOrigin(req?.headers?.get("origin"), env.clientUrl),
        allowedHeaders: [
          "content-type",
          "x-trace-id",
          "accept",
          "authorization",
          "mcp-session-id",
          "mcp-protocol-version",
          "mcp-method",
          "mcp-name",
        ],
        exposeHeaders: [
          "mcp-session-id",
          "mcp-protocol-version",
          "x-trace-id",
          "retry-after",
          "ratelimit-limit",
          "ratelimit-remaining",
          "ratelimit-reset",
        ],
        methods: ["GET", "POST", "DELETE", "OPTIONS"],
        credentials: true,
      })
    )
    .use(
      createSwaggerPlugin({
        serverUrl: env.serverUrl,
        enabled: env.openapiEnabled,
      })
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
        identifier: context.clientIp,
        action: httpOperationAction(
          (routeTemplates ??= compileRouteTemplates(app.routes)),
          request.method,
          new URL(request.url).pathname
        ),
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
        statusCode = statusOfAppError(error.code);
        errorCode = error.code;
        message = error.message;
      } else if (code === "PARSE") {
        statusCode = 400;
        errorCode = "INVALID_JSON";
        message = "请求必须为合法 JSON";
      } else if (
        String(code) === "VALIDATION" &&
        (!(error instanceof ValidationError) || error.type !== "response")
      ) {
        statusCode = 422;
        errorCode = "VALIDATION_ERROR";
        message = "请求载荷格式错误";
      } else if (code === "NOT_FOUND") {
        statusCode = 404;
        errorCode = "NOT_FOUND";
        message = "请求资源不存在";
      }
      set.status = statusCode;
      if (statusCode >= 500)
        logger.error(`HTTP 500 异常 [${path}]`, { ...describeError(error), traceId });
      return { error: { code: errorCode, message, traceId } };
    })
    // 自建 `Response` 与第三方 handler 的响应（Better Auth、oRPC、头像代理）不经过 `set.headers` 这一层，
    // 追踪号会在出口丢失：日志里有 traceId，客户端却拿不到，报障时无法对上同一次请求。
    // 这里按缺失补齐已有响应头，不改状态码与 body。
    // Elysia 1.4.30 把 mapResponse 的 `undefined` 产出当成「响应就是这个 undefined」，
    // 而全局 `onError` 的信封恰好经过本钩子：返回 undefined 等于把 4xx/5xx 的响应体抹成空串，
    // 状态码还在、错误形状却没了。所以每个分支都必须显式把原值返回。
    .mapResponse(({ set, responseValue }) => {
      if (!(responseValue instanceof Response)) return responseValue as Response;
      const missing: [string, string][] = [];
      for (const [key, value] of Object.entries(set.headers)) {
        if (value !== undefined && !responseValue.headers.has(key))
          missing.push([key, String(value)]);
      }
      if (missing.length === 0) return responseValue;
      // `fetch` 透传的响应头是只读的，原地 set 会抛，所以连同原头一起复制一份再补。
      const headers = new Headers(responseValue.headers);
      for (const [key, value] of missing) headers.set(key, value);
      return new Response(responseValue.body, {
        status: responseValue.status,
        statusText: responseValue.statusText,
        headers,
      });
    })
    // ==================== 系统 HTTP 业务模块 ====================
    .use(
      systemRoutes({
        whoIsFakerService: fakerService,
        sonGuessrService: songService,
        ceeService: characterService,
        logger,
        isShuttingDown,
        onTriggerShutdown,
        maintenanceToken: env.maintenanceToken,
      })
    )
    // ==================== 公开站点状态（只读聚合，字段白名单） ====================
    .use(
      statusRoutes({
        aggregator: statusAggregator,
        environment: env.otelDeploymentEnvironment,
        history: statusHistory,
        samples: statusSamples,
        events: statusEvents,
      })
    )
    // ==================== MCP 发现（Agent 只凭站点链接即可找到远程端点） ====================
    .use(
      mcpDiscoveryRoutes({
        mcpEnabled: env.mcpEnabled === true,
        serverUrl: env.serverUrl,
        version: "1.0.0",
      })
    )
    // ==================== 远程 MCP（Streamable HTTP） ====================
    .use(
      mcpRemoteRoutes({
        enabled: env.mcpEnabled === true,
        logger,
        sessions: remoteMcpSessions,
      })
    )
    .use(
      sentryTunnelRoutes({
        allowedProjectIds: env.sentryAllowedProjectIds,
        sentryDsn: env.sentryDsn,
        logger,
      })
    )
    // ==================== 自建图床（avif 分片缓存） ====================
    .use(bangumiImageRoutes(bangumiImages))
    // ==================== 账号（Better Auth 白名单 / oRPC / 头像代理） ====================
    .use(accountRoutes(account, logger))
    .use(clientChannelRoutes(clientChannel, clientArtifacts))
    // ==================== WebSocket 入口 ====================
    // 状态页的只读通道：公开、不解析账号，只沿用同一把来源闸与停机闸。
    .use(
      statusWsRoutes({
        aggregator: statusAggregator,
        rejectOrigin: (headers, request) => rejectDisallowedOrigin(headers, request, env.clientUrl),
        sendError: (scope, error) => logger.warn(`${scope} 状态推送失败`, describeError(error)),
      })
    )
    .ws("/api/whoisfaker/ws", {
      body: WhoIsFakerClientMessageSchema,
      response: ServerMessageSchema,
      parse: decodeGameFrame,
      error: gameSocketError(logger, "WhoIsFaker", parseWhoIsFakerMessage),
      ...gameSocketHandlers({
        serviceName: "WhoIsFaker",
        env,
        logger,
        account,
        handshakeQuota,
        service: fakerService,
      }),
    })
    .ws("/api/cee/ws", {
      body: CEEClientMessageSchema,
      response: ServerMessageSchema,
      parse: decodeGameFrame,
      error: gameSocketError(logger, "CEE", parseCEEMessage),
      ...gameSocketHandlers({
        serviceName: "CEE",
        env,
        logger,
        account,
        handshakeQuota,
        clientChannel,
        normalizeMessage: normalizeCEEEnvelope,
        service: characterService,
      }),
    })
    .ws("/api/songuessr/ws", {
      body: SonGuessrClientMessageSchema,
      response: ServerMessageSchema,
      parse: decodeGameFrame,
      error: gameSocketError(logger, "SonGuessr", parseSonGuessrMessage),
      ...gameSocketHandlers({
        serviceName: "SonGuessr",
        env,
        logger,
        account,
        handshakeQuota,
        service: songService,
      }),
    });

  return {
    app,
    dispose,
    whoIsFakerService: fakerService,
    sonGuessrService: songService,
    ceeService: characterService,
  };
};
