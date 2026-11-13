import { Elysia } from "elysia";

import type { GameServices } from "../application/GameRegistry";
import type { AppEnv } from "../config/Env";
import type { BangumiImageService } from "../infrastructure/BangumiImageService";
import type { ClientArtifacts } from "../infrastructure/ClientArtifacts";
import type { ClientChannel } from "../infrastructure/ClientChannel";
import type { ClientWebBundle } from "../infrastructure/ClientWebBundle";
import type { StatusEventRepository } from "../infrastructure/db/StatusEventRepository";
import { describeError, type EventLogger } from "../infrastructure/EventLogger";
import type { StatusHistoryStore } from "../infrastructure/StatusHistoryStore";
import type { StatusSampleStore } from "../infrastructure/StatusSampleStore";
import type { RemoteMcpSessions } from "../mcp/Remote";
import type { SiteFeatures } from "../shared/SiteFeatures";
import { accountRoutes, type AccountDependencies } from "./routes/Account";
import { bangumiImageRoutes } from "./routes/BangumiImages";
import { clientChannelRoutes } from "./routes/ClientChannelRoutes";
import { isPublicSiteOrigin, mcpDiscoveryRoutes } from "./routes/McpDiscovery";
import { mcpRemoteRoutes } from "./routes/McpRemote";
import { sentryTunnelRoutes } from "./routes/SentryTunnel";
import { siteConfigRoutes } from "./routes/SiteConfig";
import { songAudioRoutes } from "./routes/SongAudio";
import { statusRoutes, type createStatusAggregator } from "./routes/Status";
import { systemRoutes } from "./routes/System";
import type { SitePages } from "./SitePages";

export interface HttpRouteDependencies {
  env: AppEnv;
  games: GameServices;
  logger: EventLogger;
  isShuttingDown?: () => boolean;
  onTriggerShutdown?: () => Promise<void> | void;
  /** 状态聚合器：HTTP 快照、历史接口与实时通道共用同一份。 */
  statusAggregator: ReturnType<typeof createStatusAggregator>;
  statusHistory?: StatusHistoryStore;
  statusSamples?: StatusSampleStore;
  statusEvents?: StatusEventRepository;
  siteFeatures?: () => SiteFeatures;
  remoteMcpSessions: RemoteMcpSessions;
  sitePages: SitePages;
  bangumiImages?: BangumiImageService;
  account?: AccountDependencies;
  clientChannel?: ClientChannel;
  clientArtifacts?: ClientArtifacts;
  clientWebBundle?: ClientWebBundle;
}

/** 全部 HTTP 路由插件，按固定顺序组合；实时升级路由不在其中。 */
export const createHttpRoutes = ({
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
}: HttpRouteDependencies) =>
  new Elysia({ name: "http-routes" })
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
    .use(clientChannelRoutes(clientChannel, clientArtifacts, clientWebBundle));
