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
  sentryDsn?: string;
  sentryAllowedProjectIds?: string[];
  bangumiApiUrl: string;
  bangumiImageUrl: string;
  bangumiSongDbPath?: string;
  bangumiCharacterDbPath?: string;
  /** Bangumi API 回填缓存（可写）。只读数据集不能落盘，这里存 API 取到的补充字段。 */
  bangumiEnrichmentPath?: string;
  /**
   * 原版 CCB 服务器地址：兼容房间与角色使用率上报都用它。
   * `readEnv()` 恒返回字符串（未配置时为空串＝相关能力停用）；声明可选是因为
   * 大量测试夹具直接手写 `AppEnv` 字面量，消费端用 `?? ""` 兜底。
   */
  ccbOriginalServerUrl?: string;
  enableGeneralUnblock?: boolean;
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
    "production";

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
    sentryDsn,
    sentryAllowedProjectIds,
    bangumiApiUrl: (Bun.env.BANGUMI_API_URL ?? "https://api.bgm.tv").replace(/\/+$/, ""),
    bangumiImageUrl: (Bun.env.BANGUMI_IMAGE_URL ?? "").replace(/\/+$/, ""),
    bangumiSongDbPath: resolve(import.meta.dir, "../../data/bangumi-song.sqlite"),
    bangumiCharacterDbPath: resolve(import.meta.dir, "../../data/bangumi-character.sqlite"),
    bangumiEnrichmentPath: resolveDefaultBangumiEnrichmentPath(),
    // 原版 CCB 服务器地址只从环境变量注入：仓库里不写默认地址，
    // 未配置（空字符串）即停用兼容房间与角色使用率上报。
    ccbOriginalServerUrl: (Bun.env.CCB_ORIGINAL_SERVER_URL ?? "").replace(/\/+$/, ""),
    enableGeneralUnblock: Bun.env.ENABLE_GENERAL_UNBLOCK !== undefined
      ? Bun.env.ENABLE_GENERAL_UNBLOCK === "true"
      : true,
  };
};
