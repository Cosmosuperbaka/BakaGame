import { AppError } from "../../domain/Errors";

/**
 * 遥测与运维凭据（T1）：全部是引导项，必须在建库之前就有值。
 * 分层口径见 `Agents/Conventions.md` §5。
 */
export interface EnvObservability {
  otelEndpoint?: string;
  otelHeaders?: Record<string, string>;
  otelServiceName?: string;
  otelServiceNamespace?: string;
  otelDeploymentEnvironment?: string;
  /**
   * HTTP 文档页（`/openapi`）是否挂载。缺省视为开启（测试与本地开发装配 env 时不必逐个声明），
   * 生产由 `loadEnv` 依 `DEPLOYMENT_ENVIRONMENT` 关掉。
   */
  openapiEnabled?: boolean;
  maintenanceToken?: string;
  sentryDsn?: string;
  sentryAllowedProjectIds?: string[];
  /** 管理后台概览代查 Sentry 用的只读令牌（org:read、project:read、event:read）；不配则后台显示未配置。 */
  sentryApiToken?: string;
}

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

/** 环境解析：显式环境变量优先，缺省 development；不按操作系统猜测。 */
export const resolveDeploymentEnvironment = (): string => {
  const resourceAttrs = parseOtelResourceAttributes(Bun.env.OTEL_RESOURCE_ATTRIBUTES);
  return (
    Bun.env.DEPLOYMENT_ENVIRONMENT ??
    Bun.env.OTEL_DEPLOYMENT_ENVIRONMENT ??
    resourceAttrs["deployment.environment"] ??
    Bun.env.NODE_ENV ??
    "development"
  );
};

export const readObservabilityEnv = (deploymentEnvironment: string): EnvObservability => {
  const resourceAttrs = parseOtelResourceAttributes(Bun.env.OTEL_RESOURCE_ATTRIBUTES);
  const sentryDsn = Bun.env.SENTRY_DSN;
  let sentryAllowedProjectIds = (Bun.env.SENTRY_ALLOWED_PROJECT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentryAllowedProjectIds.length === 0 && sentryDsn) {
    try {
      const projectId = new URL(sentryDsn).pathname.match(/^\/([0-9a-zA-Z_-]+)$/)?.[1];
      if (projectId) sentryAllowedProjectIds = [projectId];
    } catch {
      /* 非法 DSN 由 Sentry 初始化阶段处理 */
    }
  }

  const sentryApiToken = Bun.env.SENTRY_API_TOKEN?.trim() || undefined;
  if (sentryApiToken && !sentryDsn) {
    throw new AppError(
      "CONFIG_ERROR",
      "SENTRY_API_TOKEN 需要同时配置 SENTRY_DSN（从中读取组织与区域）"
    );
  }

  return {
    otelEndpoint: Bun.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    otelHeaders: parseOtelHeaders(Bun.env.OTEL_EXPORTER_OTLP_HEADERS),
    otelServiceName:
      Bun.env.OTEL_SERVICE_NAME ?? resourceAttrs["service.name"] ?? "Bakagame-Server",
    otelServiceNamespace:
      Bun.env.OTEL_SERVICE_NAMESPACE ?? resourceAttrs["service.namespace"] ?? "Bakagame",
    otelDeploymentEnvironment: deploymentEnvironment,
    // 文档页默认只在非生产挂载：生产公开整张路由表等于把 admin 端点面与内网基址白送，
    // 契约产物另有 `ExportOpenapi.ts` 离线生成，不依赖线上文档。
    openapiEnabled:
      Bun.env.OPENAPI_ENABLED !== undefined
        ? Bun.env.OPENAPI_ENABLED === "true"
        : deploymentEnvironment !== "production",
    maintenanceToken: Bun.env.MAINTENANCE_TOKEN?.trim() || undefined,
    sentryDsn,
    sentryApiToken,
    sentryAllowedProjectIds,
  };
};
