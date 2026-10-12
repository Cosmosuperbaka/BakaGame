import { resolve } from "node:path";

import { AppError } from "../domain/Errors";

const LOCAL_LISTEN_HOSTS = new Set(["0.0.0.0", "127.0.0.1", "localhost", "::1"]);

/**
 * 图床对外前缀：**写死，不提供环境变量开关**。
 *
 * 挂在 `/api` 下是刻意的：边缘（阿里云 ESA）的 SPA 兜底函数吃掉 `game.baka.website`
 * 下所有非 `/api` 路径，新前缀必须落在 `/api/*` 里才能到得了源站。详见
 * `Agents/Deployment.md`。
 */
const BANGUMI_IMAGE_ROUTE = "/api/bangumi";

export interface AppEnv {
  clientUrl: string;
  serverUrl: string;
  serverListenHost: string;
  serverPort: number;
  /** TiDB 连接串；未配置时账号、云同步、后台与对局记录整体关闭（生产必填）。 */
  databaseUrl?: string;
  otelEndpoint?: string;
  otelHeaders?: Record<string, string>;
  otelServiceName?: string;
  otelServiceNamespace?: string;
  otelDeploymentEnvironment?: string;
  maintenanceToken?: string;
  sentryDsn?: string;
  sentryAllowedProjectIds?: string[];
  bangumiApiUrl: string;
  /**
   * 对外图片前缀：恒为 `/api/bangumi`，即自建图床。
   *
   * 路径与 Bangumi 源站一致，所以 URL 改写逻辑零改动；不提供环境变量开关 ——
   * 前缀一旦可配，就必然有人配出边缘不放行的路径（线上踩过一次，整站图片变
   * SPA HTML）。详见 `Agents/BangumiApi.md`。
   */
  bangumiImageUrl: string;
  /**
   * 图床回源前缀：`/api/bangumi` 缺失时从这里抓 avif。
   *
   * 必须能与 Bangumi 的图床路径（`/pic/cover/...`、`/r/200/...`）拼接，且支持
   * `Accept: image/avif`。**缺省为空**（只服务已缓存的图）：对外前缀是相对路径，
   * 跟着它回源会变成自己回自己的死循环。需要缺图自愈时才配，仓库里不落任何远端地址。
   */
  bangumiImageSource?: string;
  /** 本地数据集路径：猜歌与 CCB 共用同一个库。 */
  bangumiDbPath?: string;
  /** 自建图床分片目录（`/api/bangumi` 路由与更新器共用）；缺省跟随数据集目录。 */
  bangumiImagesDir?: string;
  /** 运行时更新器（阶段 6）：缺省只在生产开启。 */
  bangumiUpdaterEnabled?: boolean;
  bangumiUpdaterMinRate?: number;
  bangumiUpdaterMaxRate?: number;
  bangumiUpdaterPlayerScale?: number;
  /**
   * CCB-TagsCI 的角色标签增量地址；**不给就不跑增量同步**（不配 = 不拉）。
   *
   * 上游并不保证这条产物长期存在（仓库 `outputs/` 下只稳定发布 `id_tags.js` /
   * `id_tags.json`，diff 产物会随 CI 调整消失），写死默认地址只会在每次启动后
   * 打一条连不上的告警，所以这里留空由运维按当时可用的地址显式开启。
   */
  bangumiTagDiffUrl?: string;
  /** Bangumi API 回填缓存（可写）。只读数据集不能落盘，这里存 API 取到的补充字段。 */
  bangumiEnrichmentPath?: string;
  enableGeneralUnblock?: boolean;
  ccbOriginalServerUrl?: string;
  ccbOriginalAesSecret?: string;
  meilisearchKey?: string;
}

// ==================== 环境变量解析 ====================

const parseOtelResourceAttributes = (raw?: string): Record<string, string> => {
  if (!raw) return {};
  const attrs: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx > 0) {
      const key = part.slice(0, eqIdx).trim();
      let value = part.slice(eqIdx + 1).trim();
      try {
        value = decodeURIComponent(value);
      } catch {
        // fallback
      }
      attrs[key] = value;
    }
  }
  return attrs;
};

const parseOtelHeaders = (raw?: string): Record<string, string> | undefined => {
  if (!raw) return undefined;
  const headers: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx > 0) {
      const key = part.slice(0, eqIdx).trim();
      let value = part.slice(eqIdx + 1).trim();
      try {
        value = decodeURIComponent(value);
      } catch {
        // 解码异常时退回原始值
      }
      headers[key] = value;
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
};

const normalizeServerUrl = (value: string, port: number): URL => {
  const normalized = new URL(value);

  if (!normalized.port) {
    normalized.port = String(port);
  }

  normalized.pathname = "/";
  normalized.search = "";
  normalized.hash = "";

  return normalized;
};

const resolveListenHost = (serverUrl: URL): string => {
  if (Bun.env.SERVER_LISTEN_HOST) return Bun.env.SERVER_LISTEN_HOST;
  if (LOCAL_LISTEN_HOSTS.has(serverUrl.hostname) && Bun.env.SERVER_URL) {
    return serverUrl.hostname;
  }
  return "0.0.0.0";
};

const DEFAULT_CLIENT_URL = "http://localhost:5173";

const resolveDefaultBangumiEnrichmentPath = (): string => {
  if (Bun.env.BANGUMI_ENRICHMENT_PATH) {
    return resolve(process.cwd(), Bun.env.BANGUMI_ENRICHMENT_PATH);
  }
  // 放 Server/storage：可写、不进 Git、不参与部署产物。
  return resolve(import.meta.dir, "../../storage/bangumi-enrichment.sqlite");
};

export const readEnv = (): AppEnv => {
  const rawPort = Bun.env.SERVER_PORT ?? "4850";
  const serverPort = Number(rawPort);
  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) {
    throw new AppError(
      "CONFIG_ERROR",
      `环境变量 SERVER_PORT 必须为 1~65535 之间的合法端口号，收到: "${rawPort}"`,
    );
  }

  const serverUrl = normalizeServerUrl(
    Bun.env.SERVER_URL ?? `http://127.0.0.1:${serverPort}`,
    serverPort,
  );

  const resourceAttrs = parseOtelResourceAttributes(Bun.env.OTEL_RESOURCE_ATTRIBUTES);
  const otelServiceName =
    Bun.env.OTEL_SERVICE_NAME ??
    resourceAttrs["service.name"] ??
    "Bakagame-Server";
  const otelServiceNamespace =
    Bun.env.OTEL_SERVICE_NAMESPACE ??
    resourceAttrs["service.namespace"] ??
    "Bakagame";
  const otelDeploymentEnvironment =
    Bun.env.DEPLOYMENT_ENVIRONMENT ??
    Bun.env.OTEL_DEPLOYMENT_ENVIRONMENT ??
    resourceAttrs["deployment.environment"] ??
    Bun.env.NODE_ENV ??
    "development";

  const sentryDsn = Bun.env.SENTRY_DSN;
  let sentryAllowedProjectIds = (Bun.env.SENTRY_ALLOWED_PROJECT_IDS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (sentryAllowedProjectIds.length === 0 && sentryDsn) {
    try {
      const projectId = new URL(sentryDsn).pathname.match(/^\/([0-9a-zA-Z_-]+)$/)?.[1];
      if (projectId) sentryAllowedProjectIds = [projectId];
    } catch { /* 非法 DSN 由 Sentry 初始化阶段处理 */ }
  }

  // 显式配置成空串（CLIENT_URL=""）时必须回落到默认值，不能把空串透出去：
  // 下游 `isAllowedOrigin` 见到空串会当成「未限制来源」而放行全部 Origin。
  const clientUrl = (Bun.env.CLIENT_URL ?? "").trim() || DEFAULT_CLIENT_URL;
  const bangumiImagesDir = Bun.env.BANGUMI_IMAGES_DIR
    ? resolve(Bun.env.BANGUMI_IMAGES_DIR)
    : resolve(import.meta.dir, "../../data/images");

  return {
    clientUrl,
    serverUrl: serverUrl.toString().replace(/\/$/, ""),
    serverListenHost: resolveListenHost(serverUrl),
    serverPort,
    databaseUrl: Bun.env.DATABASE_URL?.trim() || undefined,
    otelEndpoint: Bun.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    otelHeaders: parseOtelHeaders(Bun.env.OTEL_EXPORTER_OTLP_HEADERS),
    otelServiceName,
    otelServiceNamespace,
    otelDeploymentEnvironment,
    maintenanceToken: Bun.env.MAINTENANCE_TOKEN?.trim() || undefined,
    sentryDsn,
    sentryAllowedProjectIds,
    bangumiApiUrl: (Bun.env.BANGUMI_API_URL ?? "https://api.bgm.tv").replace(/\/+$/, ""),
    bangumiImageUrl: BANGUMI_IMAGE_ROUTE,
    // 回源没有缺省值：对外前缀是相对路径的 `/api/bangumi`，跟它回源就是自己回自己。
    bangumiImageSource: (Bun.env.BANGUMI_IMAGE_SOURCE ?? "").replace(/\/+$/, ""),
    bangumiDbPath: resolve(import.meta.dir, "../../data/bangumi.sqlite"),
    bangumiImagesDir,
    // 运行时更新器默认只在生产开启：E2E / 测试与本地开发不该打在线上上游。
    bangumiUpdaterEnabled: Bun.env.BANGUMI_UPDATER_ENABLED !== undefined
      ? Bun.env.BANGUMI_UPDATER_ENABLED === "true"
      : otelDeploymentEnvironment === "production",
    bangumiUpdaterMinRate: Number(Bun.env.BANGUMI_UPDATER_MIN_RATE ?? 10),
    bangumiUpdaterMaxRate: Number(Bun.env.BANGUMI_UPDATER_MAX_RATE ?? 100),
    bangumiUpdaterPlayerScale: Number(Bun.env.BANGUMI_UPDATER_PLAYER_SCALE ?? 20),
    // 不配就不跑：上游 diff 产物并不长期存在（实测 2026-10-11 仓库 outputs/ 下只有
    // id_tags.js / id_tags.json），写死默认地址只会让每次启动都报「连不上」。
    bangumiTagDiffUrl: Bun.env.BANGUMI_TAG_DIFF_URL?.trim() || undefined,
    bangumiEnrichmentPath: resolveDefaultBangumiEnrichmentPath(),
    ccbOriginalServerUrl: (Bun.env.CCB_ORIGINAL_SERVER_URL ?? '').trim().replace(/\/+$/, ''),
    ccbOriginalAesSecret: Bun.env.CCB_ORIGINAL_AES_SECRET,
    meilisearchKey: Bun.env.MEILISEARCH_KEY?.trim() || undefined,
    enableGeneralUnblock: Bun.env.ENABLE_GENERAL_UNBLOCK !== undefined
      ? Bun.env.ENABLE_GENERAL_UNBLOCK === "true"
      : true,
  };
};
