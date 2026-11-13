import { cors } from "@elysiajs/cors";
import { Elysia, ValidationError } from "elysia";

import { eachGame, type GameServices } from "../application/GameRegistry";
import type { AppEnv } from "../config/Env";
import { AppError, isAppError } from "../domain/Errors";
import { describeError, EventLogger, sanitizeLogText } from "../infrastructure/EventLogger";

import { createSwaggerPlugin } from "./Openapi";
import { resolveClientIp } from "./ClientIp";
import { resolveRequestTraceId } from "./RequestTraceId";
import { securityHeaders } from "./SecurityHeaders";
import { WsHandshakeQuota } from "./WsHandshakeQuota";
import {
  WS_HANDSHAKE_GLOBAL_MAX_NEW_PER_WINDOW,
  WS_HANDSHAKE_IP_MAX_CONNECTIONS,
  WS_HANDSHAKE_IP_MAX_NEW_PER_WINDOW,
  WS_HANDSHAKE_WINDOW_MS,
  STATUS_WS_IP_MAX_CONNECTIONS,
  WS_ACK_REPLAY_MAX_ENTRIES,
  WS_ACK_REPLAY_TTL_MS,
  WS_IN_FLIGHT_MAX_ENTRIES,
} from "../config/Constants";
import { connectionIdOf, openGameConnection, type GameSocketLike } from "./ws/ConnectionRecord";
import {
  applyHandshakeGates,
  confirmHandshakeLease,
  isValidHandshakeHeaders,
  releaseHandshakeLease,
  type GameUpgradeContext,
} from "./ws/Handshake";
import { createCommandDeduplicator, type CommandDeduplicator } from "./ws/Dedup";
import { handleGameMessage } from "./ws/GameMessage";
import { createSiteChannel } from "./ws/SiteChannel";
import { createUnifiedSocketHandlers } from "./ws/UnifiedChannel";
import { httpError, traceIdOf } from "./HttpErrorEnvelope";
import { WhoIsFakerClientMessageSchema } from "./WhoIsFakerProtocol";
import { SonGuessrClientMessageSchema } from "./SonGuessrProtocol";
import { CEEClientMessageSchema } from "./CEEProtocol";
import { createGameEndpoints, type GameEndpoint, type GameMessage } from "./GameEndpoints";
import { normalizeCEEEnvelope } from "../shared/CEE";
import { ServerMessageSchema } from "../shared/PacketSchemas";
import type { SiteFeatures } from "../shared/SiteFeatures";
import { assertModeOpen } from "./ModeGate";
import { SitePresence } from "./SitePresence";
import { SitePages } from "./SitePages";
import { TabSessions } from "./TabSessions";
import { UNIFIED_WS_PATH } from "./UnifiedSocket";
import { warnMissingDeploymentMarker } from "./DeploymentMarkerWarning";
import { isAllowedOrigin } from "./Origin";
import {
  compileRouteTemplates,
  httpOperationAction,
  UNROUTED_HTTP_ACTION,
  type RouteTemplate,
} from "./HttpOperation";
import { decodeGameFrame, gameSocketError } from "./ws/FrameDiagnostics";
import { shutdownRejection, systemRoutes } from "./routes/System";
import { createStatusAggregator, startStatusSampler, statusRoutes } from "./routes/Status";
import { siteConfigRoutes } from "./routes/SiteConfig";
import { statusWsRoutes } from "./routes/StatusWs";
import { sentryTunnelRoutes } from "./routes/SentryTunnel";
import { bangumiImageRoutes } from "./routes/BangumiImages";
import { songAudioRoutes } from "./routes/SongAudio";
import { accountRoutes, statusOfAppError, type AccountDependencies } from "./routes/Account";
import { clientChannelRoutes } from "./routes/ClientChannelRoutes";
import { isPublicSiteOrigin, mcpDiscoveryRoutes } from "./routes/McpDiscovery";
import { mcpRemoteRoutes } from "./routes/McpRemote";
import { RemoteMcpSessions } from "../mcp/Remote";
import type { ClientArtifacts } from "../infrastructure/ClientArtifacts";
import type { ClientWebBundle } from "../infrastructure/ClientWebBundle";
import type { ClientChannel } from "../infrastructure/ClientChannel";
import type { BangumiImageService } from "../infrastructure/BangumiImageService";
import type { ExternalStatusProbe } from "../infrastructure/ExternalStatusProbe";
import type { StatusHistoryStore } from "../infrastructure/StatusHistoryStore";
import type { StatusSampleStore } from "../infrastructure/StatusSampleStore";
import type { StatusEventRepository } from "../infrastructure/db/StatusEventRepository";
import { PUBLIC_STATUS_SAMPLE_INTERVAL_MS } from "../shared/Status";
import { resolveServerRelease } from "../infrastructure/Release";
import { countServerMetric } from "../infrastructure/Sentry";

export interface AppDependencies {
  env: AppEnv;
  /** 三款游戏服务：键就是三个具名位置，由组合根一起装配。 */
  games: GameServices;
  logger: EventLogger;
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
  /**
   * 上游组件的外部读数探针（Better Stack 与直连探测的组合结果）。
   * 未提供时上游接口读作未知：单测装配因此不会发起任何真实外网请求。
   */
  statusExternalProbe?: ExternalStatusProbe;
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
  /**
   * 移动壳 Web 资源热更新清单。未提供时 `/api/client/web-bundle` 恒回「没有可用更新」，
   * 壳按内嵌产物运行。
   */
  clientWebBundle?: ClientWebBundle;
  /**
   * 站点级功能可见性（`/api/site/config`）。未提供时全部开放：
   * 独立挂载本组路由的测试与没有数据库的实例都不该被动失去入口。
   */
  siteFeatures?: () => SiteFeatures;
}

const closeGameConnection = async (
  ws: GameSocketLike,
  unregister: (connectionId: string) => Promise<void>
): Promise<void> => {
  const connectionId = connectionIdOf(ws);
  if (connectionId) await unregister(connectionId);
};

interface GameSocketHandlersOptions<TMessage extends GameMessage> {
  /** 日志前缀、建房闸门的判定与承载命令的服务都取自端点表。 */
  endpoint: GameEndpoint<TMessage>;
  /** 各模式入口的生效值；未提供时不拦建房。 */
  siteFeatures?: () => SiteFeatures;
  env: AppEnv;
  logger: EventLogger;
  account: AccountDependencies | undefined;
  handshakeQuota: WsHandshakeQuota;
  dedup: CommandDeduplicator;
  /** 仅 CEE：握手时把壳带来的 ticket 换成通道证明。 */
  clientChannel?: ClientChannel;
  /** 仅 CEE：上游信封归一。 */
  normalizeMessage?: (incoming: TMessage) => TMessage;
}

/**
 * 三款游戏 ws 路由共用的四件套 handler（upgrade/open/message/close）。
 * 握手闸门顺序（Agent 标记 → 配额 → 登录身份，CEE 额外换通道证明）是安全语义，
 * 工厂化是为了不再出现三份手抄副本各自漂移；body/response/parse/error 与 schema 强相关，
 * 留在各路由字面量里交给 Elysia 推断。
 */
const gameSocketHandlers = <TMessage extends GameMessage>({
  endpoint,
  siteFeatures,
  env,
  logger,
  account,
  handshakeQuota,
  dedup,
  clientChannel,
  normalizeMessage,
}: GameSocketHandlersOptions<TMessage>) => ({
  upgrade: (context: GameUpgradeContext) =>
    applyHandshakeGates(context, { env, logger, account, handshakeQuota, clientChannel }),
  open: (ws: GameSocketLike) => {
    confirmHandshakeLease(ws);
    openGameConnection(ws, (connection) => endpoint.service.registerConnection(connection));
  },
  message: (ws: GameSocketLike, incoming: TMessage) =>
    handleGameMessage(ws, normalizeMessage ? normalizeMessage(incoming) : incoming, dedup, {
      serviceName: endpoint.serviceName,
      execute: async (connectionId, message) => {
        assertModeOpen(endpoint, message, siteFeatures);
        return endpoint.service.execute(connectionId, message);
      },
    }),
  close: (ws: GameSocketLike) => {
    releaseHandshakeLease(ws);
    return closeGameConnection(ws, (connectionId) =>
      endpoint.service.unregisterConnection(connectionId)
    );
  },
});

export const createApp = ({
  env,
  games,
  logger,
  isShuttingDown,
  onTriggerShutdown,
  disposeResources,
  bangumiImages,
  statusHistory,
  statusSamples,
  statusEvents,
  statusExternalProbe,
  account,
  handshakeQuota: handshakeQuotaOverride,
  clientChannel,
  clientArtifacts,
  clientWebBundle,
  siteFeatures,
}: AppDependencies) => {
  warnMissingDeploymentMarker(env, logger);
  const endpoints = createGameEndpoints(games);
  // 版本在进程内不会变：装配时解析一次，状态接口的首个请求不再同步 spawn git。
  const releaseVersion = resolveServerRelease() ?? "unknown";
  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> =>
    (disposal ??= disposeResources ? disposeResources() : games.cee.close());
  const remoteMcpSessions = new RemoteMcpSessions(logger, {
    // 游戏连接只连本机回环：目标不能取自请求的 Host。
    selfUrl: `http://127.0.0.1:${env.serverPort}`,
    siteUrl: env.serverUrl,
  });
  /** 站点级 Agent 活动：首页与大厅的只读广播，不参与任何游戏的房间状态。 */
  const sitePresence = new SitePresence();
  /** 标签页接管租约：人类页面出一次性配对码，Agent 用远程 MCP 认领后由服务端驱动这张标签页。 */
  const sitePages = new SitePages({
    admitTab: (tabKey) =>
      void eachGame(games, (_, service) => service.assertTabAgentsAllowed(tabKey)),
    onControlChange: (tabKey) =>
      void eachGame(games, (_, service) => service.publishTabRooms(tabKey)),
  });
  remoteMcpSessions.onSessionClosed((id) => sitePages.closeByController(id, "agent_left"));
  /** 标签页身份的在线索引：站点连接领取，游戏连接挂上同一身份。 */
  const tabSessions = new TabSessions();
  /** 命令幂等表：归本应用实例，停机时清空。 */
  const dedup = createCommandDeduplicator({
    ackTtlMs: WS_ACK_REPLAY_TTL_MS,
    ackMax: WS_ACK_REPLAY_MAX_ENTRIES,
    inFlightMax: WS_IN_FLIGHT_MAX_ENTRIES,
    logger,
  });
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
  // 状态页实时通道的来源名额独立于游戏通道：公开只读，单来源只允许少量并发。
  const statusWsQuota = new WsHandshakeQuota({
    windowMs: WS_HANDSHAKE_WINDOW_MS,
    ipMaxRequests: WS_HANDSHAKE_IP_MAX_NEW_PER_WINDOW,
    globalMaxRequests: WS_HANDSHAKE_GLOBAL_MAX_NEW_PER_WINDOW,
    ipMaxConnections: STATUS_WS_IP_MAX_CONNECTIONS,
  });
  const unifiedSocketHandlers = createUnifiedSocketHandlers({
    env,
    logger,
    endpoints,
    account,
    handshakeQuota,
    clientChannel,
    siteFeatures,
    dedup,
    sitePresence,
    sitePages,
    tabSessions,
    siteChannel: createSiteChannel({ sitePresence, sitePages, tabSessions }),
  });
  // 状态聚合器只建一份：HTTP 快照、历史接口与 WS 实时通道读同一份缓存、记同一本账，
  // 各建一套会让页面在轮询与推送之间看到两种口径。
  const statusAggregator = createStatusAggregator({
    isServiceAvailable: () => !isShuttingDown?.(),
    meilisearchUrl: env.meilisearchUrl,
    datasetPath: env.bangumiDbPath,
    imageCache: bangumiImages ? { available: bangumiImages.available } : undefined,
    frontendUrl: env.statusFrontendUrl,
    roomsAvailable: true,
    version: () => releaseVersion,
    // 探针在 CreateServer 装配（外部监测与直连探测的组合），未传时聚合器回落到 Mock：
    // createApp 的单测装配因此不请求任何外网。
    externalProbe: statusExternalProbe,
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
      dedup.clear();
      stopStatusSampler?.();
      remoteMcpSessions.closeAll();
      void dispose().catch((error: unknown) =>
        logger.error("服务资源释放失败", describeError(error))
      );
    })
    .onRequest(({ request, set, server }) => {
      const traceId = sanitizeLogText(resolveRequestTraceId(request.headers), 128);
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
      const origin = request.headers.get("origin");
      // 不带 Origin 的只可能是非浏览器客户端（MCP 进程、本地工具）：Origin 防的是浏览器被第三方页面
      // 借用，而浏览器的跨站升级一定带 Origin，非浏览器客户端本来就能随意伪造它，所以空值放行。
      // 计数留作证据：哪天要收紧，先看这条指标有多少合法流量。
      if (!origin) countServerMetric("bakagame.ws.origin_missing", 1);
      else if (!isAllowedOrigin(origin, env.clientUrl))
        throw new AppError("FORBIDDEN_ORIGIN", "来源不被允许");
      // 缺握手必需头的升级运行时一定会拒，但它会先进入 upgrade 钩子：在这里直接回 400，不进钩子。
      if (!isValidHandshakeHeaders(request.headers))
        return new Response(
          JSON.stringify(
            httpError("INVALID_HANDSHAKE", "WebSocket 握手头不合法", traceIdOf(set.headers))
          ),
          { status: 400, headers: { "content-type": "application/json" } }
        );
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
      const action = httpOperationAction(
        (routeTemplates ??= compileRouteTemplates(app.routes)),
        request.method,
        new URL(request.url).pathname
      );
      logger.logOperation({
        status: statusCode,
        durationMs: performance.now() - context.startedAt,
        identifier: context.clientIp,
        action,
        traceId: context.traceId,
        // 级别由状态码口径决定；互联网扫描命中的未注册路径是背景噪音，只留指标计数。
        ...(action === UNROUTED_HTTP_ACTION && statusCode === 404
          ? { level: "DEBUG" as const }
          : {}),
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
        games,
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
        onError: (scope, error) => logger.warn(`${scope} 读取失败`, describeError(error)),
      })
    )
    // ==================== 站点配置（入口可见性，公开只读） ====================
    .use(siteConfigRoutes({ features: siteFeatures }))
    // ==================== MCP 发现（Agent 只凭站点链接即可找到远程端点） ====================
    .use(
      mcpDiscoveryRoutes({
        mcpEnabled: env.mcpEnabled === true,
        serverUrl: env.serverUrl,
        version: "1.0.0",
        isTrustedOrigin: (origin) => isPublicSiteOrigin(origin, env.clientUrl, env.serverUrl),
      })
    )
    // ==================== 远程 MCP（Streamable HTTP） ====================
    .use(
      mcpRemoteRoutes({
        enabled: env.mcpEnabled === true,
        logger,
        sessions: remoteMcpSessions,
        pages: sitePages,
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
    // ==================== 猜歌站内播放地址（只回跳转，音频不经过服务端） ====================
    .use(songAudioRoutes({ song: games.song }))
    // ==================== 账号（Better Auth 白名单 / oRPC / 头像代理） ====================
    .use(accountRoutes(account, logger))
    .use(clientChannelRoutes(clientChannel, clientArtifacts, clientWebBundle))
    // ==================== WebSocket 入口 ====================
    // 状态页的只读通道：公开、不解析账号，只沿用同一把来源闸与停机闸。
    .use(
      statusWsRoutes({
        aggregator: statusAggregator,
        quota: statusWsQuota,
        sendError: (scope, error) => logger.warn(`${scope} 状态推送失败`, describeError(error)),
      })
    )
    .ws(UNIFIED_WS_PATH, {
      parse: decodeGameFrame,
      ...unifiedSocketHandlers,
    })
    .ws("/api/whoisfaker/ws", {
      body: WhoIsFakerClientMessageSchema,
      response: ServerMessageSchema,
      parse: decodeGameFrame,
      error: gameSocketError(logger, endpoints.faker.serviceName, endpoints.faker.parse),
      ...gameSocketHandlers({
        endpoint: endpoints.faker,
        siteFeatures,
        env,
        logger,
        account,
        handshakeQuota,
        dedup,
      }),
    })
    .ws("/api/cee/ws", {
      body: CEEClientMessageSchema,
      response: ServerMessageSchema,
      parse: decodeGameFrame,
      error: gameSocketError(logger, endpoints.cee.serviceName, endpoints.cee.parse),
      ...gameSocketHandlers({
        endpoint: endpoints.cee,
        siteFeatures,
        env,
        logger,
        account,
        handshakeQuota,
        dedup,
        clientChannel,
        normalizeMessage: normalizeCEEEnvelope,
      }),
    })
    .ws("/api/songuessr/ws", {
      body: SonGuessrClientMessageSchema,
      response: ServerMessageSchema,
      parse: decodeGameFrame,
      error: gameSocketError(logger, endpoints.song.serviceName, endpoints.song.parse),
      ...gameSocketHandlers({
        endpoint: endpoints.song,
        siteFeatures,
        env,
        logger,
        account,
        handshakeQuota,
        dedup,
      }),
    });

  return {
    app,
    dispose,
    games,
  };
};
