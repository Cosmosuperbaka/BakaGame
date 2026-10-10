import { resolve } from "node:path";

import { AppError } from "../domain/Errors";

const LOCAL_LISTEN_HOSTS = new Set(["0.0.0.0", "127.0.0.1", "localhost", "::1"]);

export interface AppEnv {
  clientUrl: string;
  serverUrl: string;
  serverListenHost: string;
  serverPort: number;
  wordBankPath: string;
  otelEndpoint?: string;
  otelHeaders?: Record<string, string>;
  otelServiceName?: string;
  otelServiceNamespace?: string;
  otelDeploymentEnvironment?: string;
  maintenanceToken?: string;
  sentryDsn?: string;
  sentryAllowedProjectIds?: string[];
  bangumiApiUrl: string;
  /** 对外图片前缀；指向 `/bangumi-images` 时走自建图床。 */
  bangumiImageUrl: string;
  /**
   * 图床回源前缀：`/bangumi-images` 缺失时从这里抓 avif。
   *
   * 必须能与 Bangumi 的图床路径（`/pic/cover/...`、`/r/200/...`）拼接，且支持
   * `Accept: image/avif`。**缺省跟随 `bangumiImageUrl`**（它指向反代时，反代
   * 本身就是最佳回源）；一旦把 `bangumiImageUrl` 切到自建图床就必须显式指定
   * 本变量，否则会变成自己回自己的回环。仓库里不落任何远端地址。
   */
  bangumiImageSource?: string;
  /** 本地数据集路径：猜歌与 CCB 共用同一个库。 */
  bangumiDbPath?: string;
  /** 自建图床分片目录（`/bangumi-images` 路由与更新器共用）；缺省跟随数据集目录。 */
  bangumiImagesDir?: string;
  /** 运行时更新器（阶段 6）：缺省只在生产开启。 */
  bangumiUpdaterEnabled?: boolean;
  bangumiUpdaterMinRate?: number;
  bangumiUpdaterMaxRate?: number;
  bangumiUpdaterPlayerScale?: number;
  /** CCB-TagsCI 的角色标签增量地址（gh-proxy 通道，raw 直连国内不可用）。 */
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

const resolveDefaultWordBankPath = (): string => {
  if (Bun.env.WORD_BANK_PATH) {
    return resolve(process.cwd(), Bun.env.WORD_BANK_PATH);
  }
  // 默认优先基于当前模块文件稳定寻址（Server/storage/word-bank.json）
  return resolve(import.meta.dir, "../../storage/word-bank.json");
};

const DEFAULT_CLIENT_URL = "http://localhost:5173";

const resolveDefaultBangumiEnrichmentPath = (): string => {
  if (Bun.env.BANGUMI_ENRICHMENT_PATH) {
    return resolve(process.cwd(), Bun.env.BANGUMI_ENRICHMENT_PATH);
  }
  // 与词库同放 Server/storage：可写、不进 Git、不参与部署产物。
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
  const imageUrl = (Bun.env.BANGUMI_IMAGE_URL ?? "").replace(/\/+$/, "");

  return {
    clientUrl,
    serverUrl: serverUrl.toString().replace(/\/$/, ""),
    serverListenHost: resolveListenHost(serverUrl),
    serverPort,
    wordBankPath: resolveDefaultWordBankPath(),
    otelEndpoint: Bun.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    otelHeaders: parseOtelHeaders(Bun.env.OTEL_EXPORTER_OTLP_HEADERS),
    otelServiceName,
    otelServiceNamespace,
    otelDeploymentEnvironment,
    maintenanceToken: Bun.env.MAINTENANCE_TOKEN?.trim() || undefined,
    sentryDsn,
    sentryAllowedProjectIds,
    bangumiApiUrl: (Bun.env.BANGUMI_API_URL ?? "https://api.bgm.tv").replace(/\/+$/, ""),
    bangumiImageUrl: imageUrl,
    // 没显式给回源地址时，只有「对外前缀本身是绝对地址」才跟它（相对路径的
    // `/bangumi-images` 会把回源指向自己，宁可留空 = 只服务已缓存的图）。
    bangumiImageSource: (Bun.env.BANGUMI_IMAGE_SOURCE ?? (/^https?:\/\//.test(imageUrl) ? imageUrl : "")).replace(/\/+$/, ""),
    bangumiDbPath: resolve(import.meta.dir, "../../data/bangumi.sqlite"),
    bangumiImagesDir: Bun.env.BANGUMI_IMAGES_DIR
      ? resolve(Bun.env.BANGUMI_IMAGES_DIR)
      : resolve(import.meta.dir, "../../data/images"),
    // 运行时更新器默认只在生产开启：E2E / 测试与本地开发不该打在线上上游。
    bangumiUpdaterEnabled: Bun.env.BANGUMI_UPDATER_ENABLED !== undefined
      ? Bun.env.BANGUMI_UPDATER_ENABLED === "true"
      : otelDeploymentEnvironment === "production",
    bangumiUpdaterMinRate: Number(Bun.env.BANGUMI_UPDATER_MIN_RATE ?? 10),
    bangumiUpdaterMaxRate: Number(Bun.env.BANGUMI_UPDATER_MAX_RATE ?? 100),
    bangumiUpdaterPlayerScale: Number(Bun.env.BANGUMI_UPDATER_PLAYER_SCALE ?? 20),
    // raw.githubusercontent 在国内不可用（实测 12s 只下到 1/4）；gh-proxy 直通且新鲜。
    bangumiTagDiffUrl: Bun.env.BANGUMI_TAG_DIFF_URL
      ?? "https://gh-proxy.com/https://raw.githubusercontent.com/Cosmosuperbaka/CCB-TagsCI/master/outputs/id_tags.diff.json",
    bangumiEnrichmentPath: resolveDefaultBangumiEnrichmentPath(),
    ccbOriginalServerUrl: (Bun.env.CCB_ORIGINAL_SERVER_URL ?? '').trim().replace(/\/+$/, ''),
    ccbOriginalAesSecret: Bun.env.CCB_ORIGINAL_AES_SECRET,
    meilisearchKey: Bun.env.MEILISEARCH_KEY?.trim() || undefined,
    enableGeneralUnblock: Bun.env.ENABLE_GENERAL_UNBLOCK !== undefined
      ? Bun.env.ENABLE_GENERAL_UNBLOCK === "true"
      : true,
  };
};
