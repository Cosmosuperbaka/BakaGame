import { Elysia } from "elysia";

import { eachGame, type GameServices } from "../application/GameRegistry";
import type { AppEnv } from "../config/Env";
import { describeError, EventLogger } from "../infrastructure/EventLogger";

import { globalMiddleware } from "./Middleware";
import { createHttpRoutes } from "./HttpRoutes";
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
import { createCommandDeduplicator } from "./ws/Dedup";
import { legacyGameSocketRoutes } from "./ws/LegacySockets";
import { createSiteChannel } from "./ws/SiteChannel";
import { createUnifiedSocketHandlers } from "./ws/UnifiedChannel";
import { createGameEndpoints } from "./GameEndpoints";
import type { SiteFeatures } from "../shared/SiteFeatures";
import { SitePresence } from "./SitePresence";
import { SitePages } from "./SitePages";
import { TabSessions } from "./TabSessions";
import { UNIFIED_WS_PATH } from "./UnifiedSocket";
import { warnMissingDeploymentMarker } from "./DeploymentMarkerWarning";
import { decodeGameFrame } from "./ws/FrameDiagnostics";
import { createStatusAggregator, startStatusSampler } from "./routes/Status";
import { statusWsRoutes } from "./routes/StatusWs";
import type { AccountDependencies } from "./routes/Account";
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
    .use(
      globalMiddleware({
        env,
        logger,
        isShuttingDown,
        // 操作日志的路由模板索引读最终实例的路由表。
        getRoutes: (): readonly { method: string; path: string }[] => app.routes,
      })
    )
    .use(
      createHttpRoutes({
        env,
        games,
        logger,
        isShuttingDown,
        onTriggerShutdown,
        statusAggregator,
        statusHistory,
        statusSamples,
        statusEvents,
        siteFeatures,
        remoteMcpSessions,
        sitePages,
        bangumiImages,
        account,
        clientChannel,
        clientArtifacts,
        clientWebBundle,
      })
    )
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
    .use(
      legacyGameSocketRoutes({
        env,
        logger,
        endpoints,
        account,
        handshakeQuota,
        dedup,
        clientChannel,
        siteFeatures,
      })
    );

  return {
    app,
    dispose,
    games,
  };
};
